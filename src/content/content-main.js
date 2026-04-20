/**
 * JANE APP SCRAPER - CONTENT SCRIPT
 *
 * This script automates downloading patient chart PDFs from Jane App.
 *
 * HOW IT WORKS:
 * 1. Logs into Jane App with your credentials
 * 2. Gets assigned patient IDs from the coordinator (background.js)
 * 3. For each patient:
 *    - Navigate to their page
 *    - Check if they exist
 *    - Go to their charts tab
 *    - Download each chart as a PDF
 * 4. Saves PDFs directly to Downloads/jane-scraper/PATIENTID_NAME/ folder
 * 5. Requests the next patient when done
 */

// Wrap everything in an async IIFE to use dynamic imports (content scripts don't support static imports)
(async () => {
  // Dynamically import shared modules
  const { TIMEOUTS, THROTTLE, RETRY, LIMITS, THREADING, SELECTORS, PATTERNS, STORAGE_KEYS, INDEXEDDB } = await import(chrome.runtime.getURL('src/shared/constants.js'));
  const { Logger } = await import(chrome.runtime.getURL('src/shared/logger.js'));
  const { StateManager } = await import(chrome.runtime.getURL('src/content/state/state-manager.js'));

  // Import utility modules
  const asyncUtils = await import(chrome.runtime.getURL('src/shared/utils/async-utils.js'));
  const stringUtils = await import(chrome.runtime.getURL('src/shared/utils/string-utils.js'));
  const urlUtils = await import(chrome.runtime.getURL('src/shared/utils/url-utils.js'));

  // Import auth module
  const authModule = await import(chrome.runtime.getURL('src/content/auth/login.js'));

  // Import navigation modules
  const patientNav = await import(chrome.runtime.getURL('src/content/navigation/patient-nav.js'));
  const chartsNav = await import(chrome.runtime.getURL('src/content/navigation/charts-nav.js'));
  const routeDetector = await import(chrome.runtime.getURL('src/content/navigation/route-detector.js'));

  // Import scraping modules
  const patientChecker = await import(chrome.runtime.getURL('src/content/scraping/patient-checker.js'));
  const chartExtractor = await import(chrome.runtime.getURL('src/content/scraping/extractors/chart-extractor.js'));

  // Import download modules
  const { PdfDownloader } = await import(chrome.runtime.getURL('src/content/download/pdf-downloader.js'));
  const { FileChecker } = await import(chrome.runtime.getURL('src/content/download/file-checker.js'));

  // Import staff-first phase dispatcher
  const { createPhaseDispatcher } = await import(chrome.runtime.getURL('src/content/discovery/phase-dispatcher.js'));

  // Make imports available globally so rest of code can use them
  window._janeConstants = { TIMEOUTS, THROTTLE, RETRY, LIMITS, THREADING, SELECTORS, PATTERNS, STORAGE_KEYS, INDEXEDDB };
  window._Logger = Logger;
  window._StateManager = StateManager;
  window._asyncUtils = asyncUtils;
  window._stringUtils = stringUtils;
  window._urlUtils = urlUtils;

  // Initialize logger (threadId will be set later when we get thread assignment)
  const logger = new Logger({ minConsoleLevel: 'error', minPanelLevel: 'info' });
  window._logger = logger; // Make logger global so it can be accessed throughout the script

  // Initialize state manager
  const stateManager = new StateManager(() => threadId);
  window._stateManager = stateManager; // Make state manager global

  // Initialize PDF downloader
  const pdfDownloader = new PdfDownloader({
    logger: logger,
    getThreadKey: (key) => getStorageKey(key),
    minFetchGap: THROTTLE.MIN_PDF_FETCH_GAP_MS
  });
  window._pdfDownloader = pdfDownloader; // Make global
  // Appointments state
  let appointmentsState = null;
  // Patients/migration state
  let patientsState = null;
  let migrationState = null;

  // Initialize file checker
  const fileChecker = new FileChecker({
    logger: logger
  });
  window._fileChecker = fileChecker; // Make global

  const MAX_PATIENT_CHECK_RETRIES = RETRY.PATIENT_CHECK_MAX_RETRIES;
  const MAX_CHARTS_CHECK_RETRIES = RETRY.CHARTS_CHECK_MAX_RETRIES;

// ============================================================================
// STATE TRACKING
// ============================================================================

// Simple flags to track what's happening
let shouldStop = false;        // User clicked stop button
let currentPatientId = 1;      // Which patient we're working on right now
let activeTimeouts = [];       // List of timeouts we can cancel if we need to stop
let threadId = null;           // Our thread ID (like "T1" or "T2")
let watchdogStarted = false;   // Page-local watchdog flag
let phaseDispatcher = null;    // Staff-first phase dispatcher (set after threadId is known)

// Helper: Get storage keys unique to this thread
function getStorageKey(key) {
  return threadId ? `${threadId}_${key}` : key;
}

function getBootstrapStorageKeys() {
  const keys = ['frozen', 'stopRequested', 'userRequestedStop', 'appointmentsState', 'migrationState', 'patientsState'];

  for (let i = 1; i <= THREADING.MAX_THREADS; i++) {
    keys.push(`T${i}_scrapingState`);
  }

  return keys;
}

function startThreadWatchdog() {
  if (watchdogStarted || !threadId) {
    return;
  }

  watchdogStarted = true;

  const scheduleCheck = () => {
    const timeout = setTimeout(async () => {
      activeTimeouts = activeTimeouts.filter(t => t !== timeout);
      await check();
    }, 15000);

    activeTimeouts.push(timeout);
  };

  const check = async () => {
    try {
      const nowWrap = await chrome.storage.local.get([getStorageKey('lastHeartbeat'), 'frozen']);
      const last = Number(nowWrap[getStorageKey('lastHeartbeat')] || 0);
      const frozen = !!nowWrap.frozen;
      const idleMs = Date.now() - last;

      if ((last > 0 && idleMs > 120000) || frozen) {
        const clinic = getClinicNameFromUrl();
        if (clinic) {
          // Classify page state before reloading. A blind reload on a rate-limit
          // page just bounces right back into the same limit; on a login page it
          // loops indefinitely. Distinguish the three cases.
          const bodyText = (document.body?.innerText || '').slice(0, 2000);
          const isRateLimited = PATTERNS.RATE_LIMIT_TEXT.test(bodyText);

          if (isRateLimited) {
            logger.warn('Watchdog: rate-limit page detected, setting global gate instead of reload');
            try {
              const existing = await chrome.storage.local.get('rateLimitUntil');
              const until = Math.max(Number(existing.rateLimitUntil || 0), Date.now() + 60000);
              await chrome.storage.local.set({ rateLimitUntil: until, frozen: false });
            } catch (_) {}
            scheduleCheck();
            return;
          }

          shouldStop = false;
          try { await chrome.storage.local.set({ frozen: false }); } catch (_) {}
          window.location.reload();
          return;
        }
      }
    } catch (error) {
      logger.error('Watchdog check failed', error);
    }

    scheduleCheck();
  };

  scheduleCheck();
}

// Current patient's files (just for tracking, not used for zipping anymore)
let currentPatientFiles = [];
let currentPatientDownloadIds = [];

// Retry tracking per patient (persisted so retries survive reloads)
// NOTE: Now using StateManager - these are wrapper functions for backward compatibility
async function getRetryCounts(patientId) {
  try {
    return await stateManager.getRetryCounts(patientId);
  } catch (error) {
    logger.error('Failed to get retry counts', error);
    return { patientCheck: 0, charts: 0 };
  }
}

async function setRetryCounts(patientId, counts) {
  try {
    await stateManager.setRetryCounts(patientId, counts);
  } catch (error) {
    logger.error('Failed to set retry counts', error);
  }
}

async function resetRetryCounts(patientId) {
  try {
    await stateManager.resetRetryCounts(patientId);
  } catch (error) {
    logger.error('Failed to reset retry counts', error);
  }
}

// ============================================================================
// INDEXEDDB REMOVED
// ============================================================================
// IndexedDB code removed in Phase 10 - we now use chrome.storage.local only
// PDFs are downloaded directly to disk via background script

// ============================================================================
// BASIC HELPER FUNCTIONS
// ============================================================================

/**
 * Wait for a specified time, but can be interrupted if user clicks stop
 */
function sleep(milliseconds) {
  return new Promise((resolve, reject) => {
    // If user clicked stop, don't wait - just reject immediately
    if (shouldStop) {
      reject(new Error('Stopped'));
      return;
    }

    // Set up a timer
    const timeout = setTimeout(() => {
      // Remove this timeout from our tracking list when it finishes
      activeTimeouts = activeTimeouts.filter(t => t !== timeout);
      resolve();
    }, milliseconds);

    // Track this timeout so we can cancel it later if needed
    activeTimeouts.push(timeout);
  });
}

/**
 * Wait for a random time between minMs and maxMs (inclusive)
 */
function sleepJitter(minMs, maxMs) {
  const min = Math.max(0, Number(minMs) || 0);
  const max = Math.max(min, Number(maxMs) || min);
  const duration = min + Math.floor(Math.random() * (max - min + 1));
  return sleep(duration);
}

/**
 * Cancel all pending waits - used when user clicks stop
 */
function cancelAllTimeouts() {
  activeTimeouts.forEach(timeout => clearTimeout(timeout));
  activeTimeouts = [];
}

/**
 * Wait for a DOM element to exist
 */
async function waitForElement(selector, timeoutMs = 30000, pollMs = 300) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (shouldStop) throw new Error('Stopped');
    const el = document.querySelector(selector);
    if (el) return el;
    await sleep(pollMs);
  }
  throw new Error(`Element not found: ${selector}`);
}

/**
 * Convert number to ordinal string (1 -> 1st)
 */
function toOrdinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/**
 * Send a status message to the UI panel
 * Automatically adds thread ID to messages (like "[T1]" or "[T2]")
 *
 * NOTE: This is a legacy wrapper around the new Logger class.
 * Gradually replace direct calls with logger.info(), logger.success(), etc.
 */
function sendStatus(message, type = 'info') {
  // Map old type names to logger methods
  switch (type) {
    case 'success':
      logger.success(message);
      break;
    case 'error':
      logger.error(message);
      break;
    case 'warning':
      logger.warn(message);
      break;
    case 'info':
    default:
      logger.info(message);
      break;
  }
}

/**
 * Check if we hit Jane's rate limit page
 * Jane shows a "Whoa there friend, please take a moment" page when you're going too fast
 * Now uses the route-detector module for proper error handling
 */
async function detectAndHandleRateLimit() {
  try {
    // Use route detector to check for rate limit
    const isRateLimited = await routeDetector.detectRateLimit({ logger });

    if (!isRateLimited) {
      return false; // Not a rate limit page, we're good
    }

    // We hit the rate limit! Pause this thread AND set a global gate so sibling
    // threads back off before they march into the same limiter.
    sendStatus('⚠️ Rate limit detected. Pausing this thread for 60 seconds...', 'warning');
    try {
      const existing = await chrome.storage.local.get('rateLimitUntil');
      const until = Math.max(Number(existing.rateLimitUntil || 0), Date.now() + 60000);
      await chrome.storage.local.set({ rateLimitUntil: until });
    } catch (_) {}
    shouldStop = true;
    cancelAllTimeouts();

    const clinicName = getClinicNameFromUrl();
    let resumeState = null;
    try {
      const storage = await chrome.storage.local.get(getStorageKey('scrapingState'));
      resumeState = storage[getStorageKey('scrapingState')] || null;
    } catch (error) {
      logger.error('Failed to get resume state for rate limit', error);
    }

    // Handle rate limit with proper error handling
    await routeDetector.handleRateLimit({
      clinicName,
      resumeState,
      pauseDuration: 60000,
      onPause: async ({ duration, resumeState }) => {
        logger.info(`Pausing for ${duration / 1000} seconds due to rate limit`);
        await pauseAllThreadsAndRetry(clinicName, resumeState, duration);
        return { pauseHandled: true };
      },
      logger
    });

    return true;
  } catch (error) {
    logger.error('Failed to detect/handle rate limit', error);
    return false;
  }
}

/**
 * Get the clinic name from the current URL
 * Example: "bedfordskinclinic" from "bedfordskinclinic.janeapp.com"
 */
function getClinicNameFromUrl() {
  try {
    const hostname = window.location.hostname || '';
    const match = hostname.match(/^([^\.]+)\.janeapp\.com$/);
    return match ? match[1] : '';
  } catch (error) {
    logger.error('Failed to get clinic name from URL', error);
    return '';
  }
}

/**
 * Schedule a recovery after an error
 * This tries to restart from where we failed
 */
async function scheduleRecovery(clinicName, resumeState) {
  if (!clinicName) clinicName = getClinicNameFromUrl();
  if (!clinicName || shouldStop) return;

  sendStatus(`🔁 Error occurred - retrying...`);

  // If we were downloading a chart, go back to that chart page
  if (resumeState?.action === 'downloadChart' && 
      resumeState.patientId && 
      resumeState.chartEntryId) {
    
    // Save where we were
    await chrome.storage.local.set({
      [getStorageKey('scrapingState')]: {
        ...resumeState,
        savedThreadId: threadId
      }
    });
    
    await sleep(500);
    
    // Navigate back to the chart page (force route reload)
    const url = `https://${clinicName}.janeapp.com/admin/patients/${resumeState.patientId}/chart_entries/${resumeState.chartEntryId}`;
    shouldStop = false;
    window.location.href = url;
  } else {
    // Otherwise, just ask for new work
    // Use reload() because hash-based URLs don't navigate when set to the same value
    try {
      shouldStop = false;
      window.location.reload();
    } catch (error) {
      logger.error('Failed to reload during recovery', error);
      scheduleNextWorkRequest(clinicName);
    }
  }
}

/**
 * Pause this thread and wait before retrying
 * Used when we can't find PDF controls or need a local recovery pause.
 */
async function pauseAllThreadsAndRetry(clinicName, resumeState, pauseMs = 70_000) {
  try {
    if (!clinicName) clinicName = getClinicNameFromUrl();
    if (!clinicName) return;

    // Check for explicit user-requested stop (not the thread-local shouldStop,
    // which callers often set before invoking this function as an interrupt signal).
    const userStop = await chrome.storage.local.get('userRequestedStop');
    if (userStop && userStop.userRequestedStop) return;

    // Local pause for this thread; global gate set by caller / watchdog.
    shouldStop = true;
    cancelAllTimeouts();

    // Save our current state so we can resume later
    if (resumeState && typeof resumeState === 'object') {
      await chrome.storage.local.set({
        [getStorageKey('scrapingState')]: {
          ...resumeState,
          savedThreadId: threadId,
          needsRefresh: true
        }
      });
    }

    const seconds = Math.floor(pauseMs / 1000);
    sendStatus(`⏸️ PDF controls not found - pausing this thread for ${seconds}s...`, 'warning');

    // Wait locally without affecting other threads
    await new Promise((resolve) => setTimeout(resolve, pauseMs));

    // Respect explicit user stop, but do not let a temporary global stop block resume
    const flags = await chrome.storage.local.get(['stopRequested', 'userRequestedStop']);
    if (flags && flags.userRequestedStop) {
      return; // user explicitly stopped; do not resume
    }

    // Clear stop and resume work (even if a transient stopRequested was set earlier)
    await chrome.storage.local.set({ stopRequested: false });
    shouldStop = false;
    const stateNowWrap = await chrome.storage.local.get(getStorageKey('scrapingState'));
    const stateNow = stateNowWrap && stateNowWrap[getStorageKey('scrapingState')];
    if (stateNow && stateNow.action) {
      // Prefer navigating directly back to the chart entry to rebuild controls
      await chrome.storage.local.set({
        [getStorageKey('scrapingState')]: {
          ...stateNow,
          needsRefresh: false
        }
      });
      await scheduleRecovery(clinicName, stateNow);
    } else {
      // No saved state; request new work to avoid going idle
      scheduleNextWorkRequest(clinicName);
    }
  } catch (error) {
    logger.error('Pause and retry failed', error);
  }
}

/**
 * Wait for the charts page to finish loading
 * Returns true if charts loaded, false if timeout
 */
async function waitForChartsLoaded({ maxWaitMs = 60000 } = {}) {
  const startTime = Date.now();
  
  // What we're looking for on the page
  const chartPanelSelector = 'div.panel.panel-default.chart-entry.panel-no-gap';
  const loadingSpinnerSelector = 'i.icon-spinner.text-muted.icon-spin';
  const chartsContainerSelector = '#charts, [data-test-id="charts_container"]';

  // Keep checking until we timeout
  while (Date.now() - startTime < maxWaitMs) {
    if (shouldStop) throw new Error('Stopped');

    // Check what's on the page
    const hasChartPanels = document.querySelectorAll(chartPanelSelector).length > 0;
    const hasChartsContainer = document.querySelector(chartsContainerSelector);
    const isStillLoading = document.querySelector(loadingSpinnerSelector);

    // Charts are loaded if we see chart panels OR we see the container without a spinner
    const chartsAreLoaded = hasChartPanels || (hasChartsContainer && !isStillLoading);
    
    if (chartsAreLoaded) {
      return true;
    }

    await sleep(500); // Wait half a second before checking again
  }
  
  return false; // Timed out
}

// ============================================================================
// LOGIN FUNCTIONS
// ============================================================================

/**
 * Log into Jane App with email and password
 * Now uses the auth module for proper error handling and human-like typing
 */
async function login(email, password) {
  try {
    // Call the auth module's login function
    const result = await authModule.login(email, password, {
      shouldStop: () => shouldStop,
      logger: logger
    });

    // Handle the result
    if (result.alreadyLoggedIn) {
      sendStatus('✅ Already logged in!', 'success');
      return true;
    }

    if (result.willReload) {
      sendStatus('✓ Login submitted, waiting for reload...', 'success');
      return true;
    }

    return result.success;

  } catch (error) {
    if (error.message === 'Stopped' || error.message.includes('Stopped while')) {
      sendStatus('⏹️ Login stopped by user', 'info');
      throw error; // Re-throw so caller knows we stopped
    }

    sendStatus('❌ Login error: ' + error.message, 'error');
    logger.error('Login failed', error);
    return false;
  }
}

// ============================================================================
// NAVIGATION FUNCTIONS
// ============================================================================

/**
 * Navigate to a patient's main page
 * Now uses the patient-nav module for proper error handling
 */
async function navigateToPatient(clinicName, patientId) {
  try {
    sendStatus(`🔄 Navigating to patient ${patientId}...`);

    await patientNav.navigateToPatient(clinicName, patientId, {
      shouldStop: () => shouldStop,
      logger: logger
    });

    sendStatus(`✓ Arrived at patient ${patientId} page`);
  } catch (error) {
    if (error.message === 'Stopped' || error.message.includes('Stopped while')) {
      throw error; // Re-throw stop errors
    }

    sendStatus(`❌ Navigation failed: ${error.message}`, 'error');
    logger.error('Patient navigation failed', error);
    throw error;
  }
}

/**
 * Navigate to a patient's charts page and load all charts
 * Now uses the charts-nav module for proper error handling and freeze detection
 */
async function navigateToCharts(clinicName, patientId) {
  try {
    sendStatus(`🔄 Navigating to charts page for patient ${patientId}...`);
    sendStatus(`⏳ Waiting for charts to render...`);

    // Define freeze callback
    const handleFreeze = async ({ clinicName, patientId }) => {
      sendStatus(`🧊 Charts view appears frozen. Waiting 100s then refreshing charts...`, 'warning');

      // Save state to resume after freeze recovery
      try {
        await chrome.storage.local.set({
          [getStorageKey('scrapingState')]: {
            action: 'requestWork',
            clinicName,
            resumePatientId: patientId,
            savedThreadId: threadId
          }
        });
      } catch (error) {
        logger.error('Failed to save freeze recovery state', error);
      }

      // Wait for freeze recovery
      await sleep(TIMEOUTS.FREEZE_RECOVERY_PAUSE, { shouldStop: () => shouldStop });

      // Refresh the charts route
      const url = urlUtils.buildChartsUrl(clinicName, patientId);
      window.location.href = url;
    };

    // Call the charts navigation module
    const result = await chartsNav.navigateToCharts(clinicName, patientId, {
      shouldStop: () => shouldStop,
      logger: logger,
      onFreeze: handleFreeze
    });

    // Handle different result states
    if (!result.success) {
      if (result.paused) {
        sendStatus(`🧊 Charts view frozen, recovery in progress`, 'warning');
        return { success: false, paused: true, reason: result.reason };
      }

      if (result.reason === 'timeout') {
        sendStatus(`⚠️ Charts load timed out for patient ${patientId}`);
        return { success: false, reason: 'timeout' };
      }

      if (result.reason === 'no_charts') {
        sendStatus(`✓ No charts found for patient ${patientId}`);
        return { success: false, reason: 'no_charts' };
      }

      // Unknown failure reason
      return result;
    }

    // Success!
    sendStatus(`✓ Charts page loaded successfully`);

    if (result.loadMoreCount > 0) {
      const plural = result.loadMoreCount !== 1 ? 's' : '';
      sendStatus(`✓ All charts loaded (clicked ${result.loadMoreCount} "Load More" button${plural})`);
    }

    return result;

  } catch (error) {
    if (error.message === 'Stopped' || error.message.includes('Stopped while')) {
      throw error; // Re-throw stop errors
    }

    sendStatus(`❌ Charts navigation failed: ${error.message}`, 'error');
    logger.error('Charts navigation failed', error);
    return { success: false, reason: 'error', error: error.message };
  }
}

// ============================================================================
// APPOINTMENTS FUNCTIONS
// ============================================================================

/**
 * Navigate to appointments report page and set date range
 * Stops after selecting the date range - no export button clicking
 */
async function navigateToAppointmentsExportPreview(clinicName, startDate, endDate) {
  // Navigate to appointments report page
  const baseUrl = `https://${clinicName}.janeapp.com/admin#reports/appointments`;
  window.location.href = baseUrl;
  await sleepJitter(3000, 4000);
  
  // Wait for page to load
  if (document.readyState !== 'complete') {
    await new Promise(resolve => {
      if (document.readyState === 'complete') {
        resolve();
      } else {
        window.addEventListener('load', resolve, { once: true });
        setTimeout(resolve, 10000);
      }
    });
  }
  
  // Wait after page load before interacting
  await sleepJitter(2000, 3000);
  
  // Set the date range
  await applyAppointmentsDateRange(startDate, endDate);

  // Wait a bit after date range is set
  await sleepJitter(2000, 3000);

  // Navigate to Excel export URL
  // The _request_path is a base64-encoded path to the xlsx endpoint with parameters
  const requestedAt = Date.now();
  
  // Construct the path that will be base64 encoded: /admin/reports/appointments.xlsx?start_date=...&end_date=...&requested_at=...
  const xlsxPath = `/admin/reports/appointments.xlsx?start_date=${startDate}&end_date=${endDate}&requested_at=${requestedAt}`;
  // Base64 encode the path (using URL-safe base64 encoding)
  const requestPath = btoa(xlsxPath).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  
  const exportUrl = `https://${clinicName}.janeapp.com/admin/reports/appointments?start_date=${startDate}&end_date=${endDate}&requested_at=${requestedAt}&_request_path=${encodeURIComponent(requestPath)}`;

  // IMPORTANT:
  // Navigating to exportUrl triggers a full page load, which kills this JS context before
  // runAppointmentsFlow can clean up storage. If appointmentsState remains set, the next
  // page load will "resume" and may navigate back to the SPA route, which looks like the
  // extension is forcing you back.
  //
  // To fix this, we persist a stage marker + exportUrl BEFORE navigating, so the next page
  // load can resume directly into downloadExcelFromPreviewPage().
  try {
    const wrap = await chrome.storage.local.get(['appointmentsState']);
    const current = wrap?.appointmentsState || null;
    if (current && typeof current === 'object') {
      await chrome.storage.local.set({
        appointmentsState: {
          ...current,
          stage: 'export_preview',
          exportUrl
        }
      });
    }
  } catch (e) {
    logger.warn('Failed to persist appointments export stage before navigation', e);
  }

  window.location.href = exportUrl;
  return null;
}

/**
 * Download Excel file from the preview page
 */
async function downloadExcelFromPreviewPage(clinicName, folderPath = 'jane-scraper/appointments') {
  // Wait for the download button to appear
  let downloadButton;
  let waitTime = 0;
  const maxWait = 30000; // 30 seconds
  
  while (waitTime < maxWait) {
    if (shouldStop) throw new Error('Stopped');
    
    // Try different selectors
    downloadButton = document.querySelector('a.btn.btn-default[href*=".xlsx"]') ||
                     document.querySelector('a[href*=".xlsx"]') ||
                     Array.from(document.querySelectorAll('a[href]')).find(link => {
                       const href = link.getAttribute('href') || '';
                       return href.includes('.xlsx') && (href.includes('downloads') || link.textContent.toLowerCase().includes('download'));
                     });
    
    if (downloadButton) break;
    
    await sleep(1000);
    waitTime += 1000;
  }
  
  if (!downloadButton) {
    throw new Error('Excel download link not found on preview page');
  }
  
  // Wait after finding button
  await sleepJitter(2000, 3000);
  
  // Get the download URL
  const excelUrl = downloadButton.getAttribute('href');
  if (!excelUrl) {
    throw new Error('Excel download URL not found');
  }

  // Make sure we have a full URL
  let fullUrl;
  if (excelUrl.startsWith('http')) {
    fullUrl = excelUrl;
  } else {
    const currentUrl = new URL(window.location.href);
    fullUrl = `${currentUrl.protocol}//${currentUrl.host}${excelUrl}`;
  }

  // Fetch the Excel file (similar to PDF download), but be careful:
  // Jane sometimes redirects /downloads/<file>.xlsx -> /downloads/<file>.xlsx/preview (HTML),
  // which would produce a bogus "xlsx" containing HTML. Detect and recover by stripping /preview.
  const fetchXlsxBlob = async (urlToFetch) => {
    await sleepJitter(2000, 3000);
    const res = await fetch(urlToFetch, {
      method: 'GET',
      credentials: 'include', // Include login cookies
      headers: {
        'Accept': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,*/*',
        'Referer': window.location.href,
        'User-Agent': navigator.userAgent
      }
    });

    if (!res.ok) {
      throw new Error(`Excel fetch failed: HTTP ${res.status}`);
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const finalUrl = res.url || urlToFetch;

    // If we ended up on a preview page (often HTML), retry with /preview removed.
    if ((finalUrl.endsWith('/preview') || urlToFetch.endsWith('/preview')) &&
        (contentType.includes('text/html') || contentType.includes('application/xhtml') || contentType.includes('text/plain'))) {
      const nonPreviewUrl = finalUrl.replace(/\/preview$/, '');
      if (nonPreviewUrl && nonPreviewUrl !== finalUrl) {
        return await fetchXlsxBlob(nonPreviewUrl);
      }
    }

    // If server responded with HTML, it's not an xlsx.
    if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
      throw new Error(`Excel fetch returned HTML (likely preview page). finalUrl=${finalUrl}`);
    }

    const blob = await res.blob();
    if (blob.size === 0) {
      throw new Error('Downloaded Excel file is empty');
    }
    return blob;
  };

  const blob = await fetchXlsxBlob(fullUrl);

  // Extract filename from URL or use default
  const urlParts = excelUrl.split('/');
  const filename = urlParts[urlParts.length - 1] || `appointments_${Date.now()}.xlsx`;

  // Create blob URL and download via background script
  const blobUrl = URL.createObjectURL(blob);
  try {
    const downloadId = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        action: 'downloadPDF', // Reuse the same download handler
        url: blobUrl,
        filename: `${folderPath}/${filename}`,
        saveAs: false
      }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response && response.error) {
          reject(new Error(response.error));
        } else if (response && response.downloadId) {
          resolve(response.downloadId);
        } else {
          reject(new Error('No download ID returned'));
        }
      });
    });

    // Wait for download to complete
    let downloadComplete = false;
    let attempts = 0;
    const maxAttempts = 60; // 30 seconds max

    while (!downloadComplete && attempts < maxAttempts) {
      if (shouldStop) {
        throw new Error('Stopped while waiting for download');
      }

      const downloadState = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'checkDownload',
          downloadId: downloadId
        }, (response) => {
          resolve(response?.state || 'unknown');
        });
      });

      if (downloadState === 'complete') {
        downloadComplete = true;
      } else if (downloadState === 'interrupted') {
        throw new Error('Download interrupted');
      }

      if (!downloadComplete) {
        await sleep(500);
        attempts++;
      }
    }

    if (!downloadComplete) {
      throw new Error('Download timed out');
    }

    URL.revokeObjectURL(blobUrl);
    return filename;
  } catch (error) {
    URL.revokeObjectURL(blobUrl);
    throw error;
  }
}

/**
 * Apply date range to appointments report using date picker UI
 */
async function applyAppointmentsDateRange(startDate, endDate) {
  // Wait for date range picker button
  const button = await waitForElement('[data-testid="date-range-picker-button"]', 30000);
  await sleepJitter(1500, 2000);
  button.click();
  await sleepJitter(1500, 2000);
  
  // Wait for date picker to appear (with timeout)
  let datePicker;
  const maxWait = 10000;
  const startTime = Date.now();
  while (Date.now() - startTime < maxWait) {
    datePicker = document.querySelector('.react-datepicker');
    if (datePicker) break;
    await sleep(200);
  }
  
  if (!datePicker) {
    throw new Error('Date picker did not appear');
  }

  // Wait after picker appears
  await sleepJitter(1500, 2000);

  await selectDateInPicker(startDate);
  await sleepJitter(1500, 2000); // Wait between date selections
  await selectDateInPicker(endDate);

  // Wait for date picker to close
  const startWait = Date.now();
  while (document.querySelector('.react-datepicker') && Date.now() - startWait < 10000) {
    await sleep(200);
  }
  await sleepJitter(2000, 3000); // Wait after date range is applied
}

/**
 * Select a date in the date picker
 */
async function selectDateInPicker(dateStr) {
  const target = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(target.getTime())) {
    throw new Error(`Invalid date: ${dateStr}`);
  }

  let attempts = 0;
  while (attempts < 24) {
    if (shouldStop) throw new Error('Stopped');

    const monthLabels = Array.from(document.querySelectorAll('.react-datepicker__current-month'));
    if (monthLabels.length === 0) {
      throw new Error('Date picker month labels not found');
    }
    
    const firstLabel = monthLabels[0]?.textContent || '';
    const info = getMonthIndex(firstLabel);
    if (!info) throw new Error('Unable to read calendar month');

    const targetMonth = target.getMonth();
    const targetYear = target.getFullYear();

    if (info.yearNum === targetYear && info.monthIdx === targetMonth) {
      const matchText = buildAriaMatch(target);
      const dayEl = Array.from(document.querySelectorAll('.react-datepicker__day'))
        .find((el) => (el.getAttribute('aria-label') || '').includes(matchText));
      if (!dayEl) {
        throw new Error(`Day not found for ${dateStr}`);
      }
      await sleepJitter(1000, 1500); // Wait before clicking date
      dayEl.click();
      await sleepJitter(1500, 2000); // Wait after clicking date
      return;
    }

    const navNext = document.querySelector('.react-datepicker__navigation--next');
    const navPrev = document.querySelector('.react-datepicker__navigation--previous');

    if ((info.yearNum < targetYear) || (info.yearNum === targetYear && info.monthIdx < targetMonth)) {
      if (!navNext) throw new Error('Next month button not found');
      await sleepJitter(1000, 1500); // Wait before clicking navigation
      navNext.click();
    } else {
      if (!navPrev) throw new Error('Previous month button not found');
      await sleepJitter(1000, 1500); // Wait before clicking navigation
      navPrev.click();
    }
    await sleepJitter(1500, 2000); // Wait after month navigation
    attempts++;
  }

  throw new Error(`Could not navigate to month for ${dateStr}`);
}

function getMonthIndex(label) {
  const parts = label?.trim().split(' ');
  if (!parts || parts.length < 2) return null;
  const monthName = parts[0];
  const yearNum = Number(parts[1]);
  const monthIdx = new Date(`${monthName} 1, ${yearNum}`).getMonth();
  return { monthIdx, yearNum };
}

function buildAriaMatch(dateObj) {
  const weekday = dateObj.toLocaleDateString('en-US', { weekday: 'long' });
  const month = dateObj.toLocaleDateString('en-US', { month: 'long' });
  const day = toOrdinal(dateObj.getDate());
  const year = dateObj.getFullYear();
  return `Choose ${weekday}, ${month} ${day}, ${year}`;
}

/**
 * Navigate to patients report page
 * Just navigates - no clicking or exporting
 */
async function navigateToPatientsPage(clinicName) {
  // Navigate to patients report page
  const baseUrl = `https://${clinicName}.janeapp.com/admin#reports/patients/list`;
  window.location.href = baseUrl;
  await sleepJitter(3000, 4000);
  
  // Wait for page to load
    if (document.readyState !== 'complete') {
      await new Promise(resolve => {
        if (document.readyState === 'complete') {
          resolve();
        } else {
          window.addEventListener('load', resolve, { once: true });
        setTimeout(resolve, 10000);
        }
      });
    }
    
  // Wait a few seconds after page loads
  await sleepJitter(3000, 4000);
}

async function runAppointmentsFlow(state, { fromResume = false } = {}) {
  try {
    const { clinicName, email, password, startDate, endDate } = state || {};
    if (!clinicName || !email || !password || !startDate || !endDate) {
      throw new Error('Missing appointments parameters');
    }

    await chrome.storage.local.set({ appointmentsState: state });

    const loginFormPresent = !!document.querySelector('input[name="auth_key"], input#auth_key');
    if (loginFormPresent) {
      const loggedIn = await login(email, password);
      if (!loggedIn) {
        throw new Error('Login failed for appointments');
      }
      return;
    }

    // If we're on Jane's download preview page, download the XLSX from here.
    // This is often where the export flow lands (e.g. /downloads/<file>.xlsx/preview).
    const currentUrlObj = new URL(window.location.href);
    const isOnDownloadsPreview =
      currentUrlObj.pathname.startsWith('/downloads/') &&
      currentUrlObj.pathname.endsWith('/preview') &&
      currentUrlObj.pathname.includes('.xlsx');

    if (isOnDownloadsPreview) {
      // Ensure page finished loading/rendering before we query the download link.
      if (document.readyState !== 'complete') {
        await new Promise(resolve => {
          if (document.readyState === 'complete') {
            resolve();
          } else {
            window.addEventListener('load', resolve, { once: true });
            setTimeout(resolve, 10000);
          }
        });
      }
      await sleepJitter(2000, 3000);

      const filename = await downloadExcelFromPreviewPage(clinicName);

      await chrome.storage.local.remove(['appointmentsState']);
      appointmentsState = null;
      logger.success(`Appointments Excel downloaded: ${filename}`);
      try {
        chrome.runtime.sendMessage({
          action: 'statusUpdate',
          status: {
            message: `Appointments Excel downloaded: ${filename}`,
            type: 'info'
          }
        });
      } catch (_) {}
      return;
    }

    // If we're already on the export preview URL, download the Excel from this page.
    // This prevents the "bounce back" where appointmentsState causes a resume that
    // navigates back to the SPA appointments route.
    const isOnExportPreview =
      window.location.pathname === '/admin/reports/appointments' &&
      (new URL(window.location.href)).searchParams.has('_request_path');

    if (isOnExportPreview) {
      // Wait for page to fully load
      if (document.readyState !== 'complete') {
        await new Promise(resolve => {
          if (document.readyState === 'complete') {
            resolve();
          } else {
            window.addEventListener('load', resolve, { once: true });
            setTimeout(resolve, 10000);
          }
        });
      }

      // Wait for URL to end with /preview (or wait 5 seconds max)
      // The page may redirect to /downloads/...xlsx/preview
      let waitTime = 0;
      const maxWait = 5000; // 5 seconds
      while (waitTime < maxWait) {
        const currentUrl = window.location.href;
        if (currentUrl.endsWith('/preview')) {
          break;
        }
        await sleep(200);
        waitTime += 200;
      }

      // Additional wait to ensure page is fully rendered
      await sleepJitter(2000, 3000);

      const filename = await downloadExcelFromPreviewPage(clinicName);

      await chrome.storage.local.remove(['appointmentsState']);
      appointmentsState = null;
      logger.success(`Appointments Excel downloaded: ${filename}`);
      try {
        chrome.runtime.sendMessage({
          action: 'statusUpdate',
          status: {
            message: `Appointments Excel downloaded: ${filename}`,
            type: 'info'
          }
        });
      } catch (_) {}
      return;
    }

    // Otherwise, navigate to appointments report, set date range, then navigate to export URL.
    // The actual download will happen after the export page loads (resume via appointmentsState).
    await navigateToAppointmentsExportPreview(clinicName, startDate, endDate);
    return;
  } catch (error) {
    logger.error('Appointments flow failed', error);
    try {
      chrome.runtime.sendMessage({
        action: 'statusUpdate',
        status: {
          message: `Appointments error: ${error.message}`,
          type: 'error'
        }
      });
    } catch (_) {}
  }
}

async function runPatientsFlow(state) {
  try {
    const { clinicName, email, password } = state || {};
    if (!clinicName || !email || !password) {
      throw new Error('Missing patients parameters');
    }

    patientsState = state;
    await chrome.storage.local.set({ patientsState: state });

    const loginFormPresent = !!document.querySelector('input[name="auth_key"], input#auth_key');
    if (loginFormPresent) {
      const loggedIn = await login(email, password);
      if (!loggedIn) {
        throw new Error('Login failed for patients');
      }
      return;
    }

    // Navigate to patients page
    await navigateToPatientsPage(clinicName);

    await chrome.storage.local.remove(['patientsState']);
    patientsState = null;
    logger.success('Navigated to patients page');
    try {
      chrome.runtime.sendMessage({
        action: 'statusUpdate',
        status: {
          message: 'Navigated to patients page',
          type: 'info'
        }
      });
    } catch (_) {}
  } catch (error) {
    logger.error('Patients flow failed', error);
    try {
      chrome.runtime.sendMessage({
        action: 'statusUpdate',
        status: {
          message: `Patients error: ${error.message}`,
          type: 'error'
        }
      });
    } catch (_) {}
    throw error;
  }
}

async function runMigrationFlow(state, { fromResume = false } = {}) {
  try {
    const { clinicName, email, password, startDate, endDate } = state || {};
    if (!clinicName || !email || !password || !startDate || !endDate) {
      throw new Error('Missing migration parameters');
    }

    migrationState = state;
    await chrome.storage.local.set({ migrationState: state });

    // If login is needed, the underlying flows will handle it and return early.
    await runAppointmentsFlow(state, { fromResume });
    // await runPatientsFlow(state);

    // Clean up all state to ensure nothing continues after migration
    await chrome.storage.local.remove(['migrationState', 'appointmentsState', 'patientsState']);
    migrationState = null;
    
    logger.success('Migration completed (appointments + patients)');
    try {
      chrome.runtime.sendMessage({
        action: 'statusUpdate',
        status: {
          message: 'Migration completed (appointments + patients)',
          type: 'info'
        }
      });
    } catch (_) {}
    
    // Explicitly return to prevent any further execution
    return;
  } catch (error) {
    // Clean up state on error too
    await chrome.storage.local.remove(['migrationState', 'appointmentsState', 'patientsState']);
    migrationState = null;
    
    logger.error('Migration flow failed', error);
    try {
      chrome.runtime.sendMessage({
        action: 'statusUpdate',
        status: {
          message: `Migration error: ${error.message}`,
          type: 'error'
        }
      });
    } catch (_) {}
    throw error;
  }
}

// ============================================================================
// PATIENT CHECKING FUNCTIONS
// ============================================================================

/**
 * Check if the patient exists on their page
 * Now uses the patient-checker module for proper error handling
 * Returns { exists: boolean, reason?: 'timeout'|'not_found', paused?: boolean }
 */
async function checkPatientExists() {
  sendStatus(`🔍 Checking if patient exists...`);

  try {
    // Define freeze callback
    const handleFreeze = async () => {
      sendStatus(`🧊 Page appears frozen. Waiting 100s then refreshing route...`, 'warning');

      // Save state to resume this patient after reload/navigation
      try {
        await chrome.storage.local.set({
          [getStorageKey('scrapingState')]: {
            action: 'requestWork',
            clinicName: getClinicNameFromUrl(),
            resumePatientId: currentPatientId,
            savedThreadId: threadId
          }
        });
      } catch (error) {
        logger.error('Failed to save freeze recovery state', error);
      }

      // Small pause, then re-enter same patient URL to refresh SPA route
      await sleep(TIMEOUTS.FREEZE_RECOVERY_PAUSE, { shouldStop: () => shouldStop });
      const clinic = getClinicNameFromUrl();
      if (clinic) {
        const url = urlUtils.buildPatientUrl(clinic, currentPatientId);
        window.location.href = url;
      }
    };

    // Call patient checker module
    const result = await patientChecker.checkPatientExists({
      shouldStop: () => shouldStop,
      logger: logger,
      onFreeze: handleFreeze
    });

    // Handle different result states
    if (result.exists) {
      sendStatus(`✓ Patient found`);
    } else if (result.paused) {
      sendStatus(`🧊 Page frozen, recovery in progress`, 'warning');
    } else if (result.reason === 'timeout') {
      sendStatus(`⚠️ Patient check timed out`, 'warning');
    } else {
      sendStatus(`⚠️ Patient not found`, 'error');
    }

    return result;

  } catch (error) {
    if (error.message === 'Stopped' || error.message.includes('Stopped while')) {
      throw error; // Re-throw stop errors
    }

    sendStatus(`❌ Patient check failed: ${error.message}`, 'error');
    logger.error('Patient check failed', error);
    return { exists: false, reason: 'error' };
  }
}

/**
 * Get the patient's name from the page
 * Now uses the patient-checker module
 */
async function getPatientName() {
  try {
    return await patientChecker.getPatientName({ logger });
  } catch (error) {
    logger.error('Failed to get patient name', error);
    return '';
  }
}

// ============================================================================
// CHART EXTRACTION FUNCTIONS
// ============================================================================

/**
 * Extract all chart entries from the charts page
 * Now uses the chart-extractor module for proper error handling
 * Returns an array of chart objects with header text, ID, and index
 */
async function getChartEntries() {
  try {
    const entries = await chartExtractor.extractChartEntries({ logger });

    // Filter out invalid entries
    const validEntries = chartExtractor.filterValidEntries(entries, { logger });

    return validEntries;
  } catch (error) {
    logger.error('Failed to extract chart entries', error);
    return [];
  }
}

// ============================================================================
// PDF DOWNLOAD FUNCTIONS
// ============================================================================

/**
 * Download a PDF file and save it to disk
 * Now uses the PdfDownloader module for proper error handling and throttling
 *
 * Steps:
 * 1. Fetch the PDF from Jane App (using our login cookies)
 * 2. Create a blob URL for the PDF
 * 3. Tell Chrome to download it to the patient's folder
 * 4. Wait for the download to complete
 */
async function downloadPdfWithCookies(pdfUrl, filename, patientName, patientId) {
  try {
    sendStatus(`⬇️ Fetching PDF from server...`);

    // Use PdfDownloader module
    const result = await pdfDownloader.downloadPdfWithCookies(
      pdfUrl,
      filename,
      patientName,
      patientId,
      { shouldStop: () => shouldStop }
    );

    if (result.success) {
      sendStatus(`💾 PDF saved successfully`);

      // Track this download (for backward compatibility with existing code)
      if (result.downloadId) {
        currentPatientDownloadIds.push(result.downloadId);
      }

      return true;
    } else {
      sendStatus(`❌ PDF download failed: ${result.error}`, 'error');

      // If download failed, try to recover
      try {
        const clinicName = getClinicNameFromUrl();
        const storage = await chrome.storage.local.get(getStorageKey('scrapingState'));
        const currentState = storage[getStorageKey('scrapingState')];
        await scheduleRecovery(clinicName, currentState);
        return false;
      } catch (error) {
        logger.error('Recovery failed after download error', error);
        return false;
      }
    }

  } catch (error) {
    if (error.message === 'Stopped' || error.message.includes('Stopped while')) {
      throw error; // Re-throw stop errors
    }

    sendStatus(`❌ PDF download error: ${error.message}`, 'error');
    logger.error('PDF download failed', error);

    // Try to recover
    try {
      const clinicName = getClinicNameFromUrl();
      const storage = await chrome.storage.local.get(getStorageKey('scrapingState'));
      const currentState = storage[getStorageKey('scrapingState')];
      await scheduleRecovery(clinicName, currentState);
      return false;
    } catch (recoveryError) {
      logger.error('Recovery failed', recoveryError);
      throw error;
    }
  }
}

/**
 * Pick the most likely direct-download PDF link from Jane's preview page.
 * Prefer non-preview targets so we fetch the real PDF when both links exist.
 */
function findBestPdfDownloadLink() {
  const currentUrl = new URL(window.location.href);

  const candidates = Array.from(document.querySelectorAll('a[href*=".pdf"]'))
    .map((link) => {
      const href = link.getAttribute('href') || '';
      if (!href) {
        return null;
      }

      let absoluteHref = href;
      try {
        absoluteHref = new URL(href, currentUrl).toString();
      } catch (error) {
        return null;
      }

      const text = (link.textContent || '').trim().toLowerCase();
      let score = 0;

      if (link.matches('a.btn.btn-default')) score += 3;
      if (text.includes('download')) score += 2;
      if (!absoluteHref.includes('/preview')) score += 4;
      if (absoluteHref === currentUrl.toString()) score -= 10;

      return { link, score };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score);

  return candidates[0]?.link || null;
}

// ============================================================================
// CLEANUP FUNCTIONS
// ============================================================================

/**
 * Clean up after finishing a patient
 * We used to zip files here, but now we save directly to folders
 * Now uses PdfDownloader to clear tracking data
 */
async function zipPatientFiles(patientName, patientId) {
  try {
    // Clear memory for next patient using PdfDownloader
    pdfDownloader.clearPatientData();

    // Also clear legacy tracking arrays for backward compatibility
    currentPatientFiles = [];
    currentPatientDownloadIds = [];
  } catch (error) {
    logger.error('Cleanup failed', error);
    // Ignore all errors in cleanup
  }
}

// ============================================================================
// CHART DOWNLOAD ORCHESTRATION
// ============================================================================

/**
 * Start downloading a single chart
 * Saves state and navigates to the chart entry page
 */
async function initiateChartDownload(clinicName, patientId, chartEntryId, headerText, patientName, remainingEntries, totalCharts) {
  const currentChartNum = totalCharts - remainingEntries.length;
  sendStatus(`🔄 [Chart ${currentChartNum}/${totalCharts}] Opening chart ${chartEntryId}...`);

  // Save our progress so we can resume if something goes wrong
  await chrome.storage.local.set({
    [getStorageKey('scrapingState')]: {
      action: 'downloadChart',
      clinicName,
      patientId,
      chartEntryId,
      headerText,
      patientName,
      remainingEntries,
      totalCharts
    }
  });

  // Wait a bit before navigating (give browser time to save state)
  await sleep(800);

  // Go to the chart entry page
  const url = `https://${clinicName}.janeapp.com/admin/patients/${patientId}/chart_entries/${chartEntryId}`;
  window.location.href = url;
}

/**
 * Handle downloading a chart PDF
 * This function is called after we navigate to a chart entry page
 * 
 * There are two phases:
 * 1. Finding and clicking the "PDF" button (navigates to PDF preview page)
 * 2. Finding and downloading the PDF link
 */
async function handleChartDownload(state) {
  try {
    const { clinicName, patientId, chartEntryId, headerText, patientName, 
            remainingEntries, totalCharts, waitingForPdfPage, retryCount } = state;
    
    const currentChartNum = totalCharts - remainingEntries.length;
    const currentRetry = retryCount || 0;
    const maxRetries = 3; // Reduced from 10 - keep it simple

    // If global frozen flag is set, pause and force a route refresh before proceeding
    try {
      const freeze = await chrome.storage.local.get('frozen');
      if (freeze && freeze.frozen) {
        sendStatus(`🧊 Page appears frozen. Waiting 100s then refreshing route...`, 'warning');
        const resumeState = {
          action: 'downloadChart',
          clinicName,
          patientId,
          chartEntryId,
          headerText,
          patientName,
          remainingEntries,
          totalCharts,
          waitingForPdfPage,
          retryCount: currentRetry,
          needsRefresh: true
        };
        await pauseAllThreadsAndRetry(clinicName, resumeState, 100000);
        return;
      }
    } catch (error) {
      logger.error('Operation failed', error);
    }

    // PHASE 2: We're on the PDF preview page, find the download link
    if (waitingForPdfPage) {
      if (shouldStop) {
        await chrome.storage.local.remove([getStorageKey('scrapingState')]);
        sendStatus('⏹️ Stopped', 'info');
        return;
      }

      const retryMsg = currentRetry > 0 ? ` [Retry ${currentRetry}/${maxRetries}]` : '';
      sendStatus(`🔍 Looking for PDF download link${retryMsg}...`);

      // Wait for PDF download button to appear (up to 30 seconds)
      let waitTime = 0;
      let pdfDownloadButton = null;
      
      while (waitTime < 30000) {
        if (shouldStop) {
          await chrome.storage.local.remove([getStorageKey('scrapingState')]);
          sendStatus('⏹️ Stopped', 'info');
          return;
        }

        await sleep(2_000);

        // If page is frozen during waiting, pause and refresh
        try {
          const freeze = await chrome.storage.local.get('frozen');
          if (freeze && freeze.frozen) {
            sendStatus(`🧊 Page appears frozen. Waiting 100s then refreshing route...`, 'warning');
            const resumeState = {
              action: 'downloadChart',
              clinicName,
              patientId,
              chartEntryId,
              headerText,
              patientName,
              remainingEntries,
              totalCharts,
              waitingForPdfPage: true,
              retryCount: currentRetry,
              needsRefresh: true
            };
            await pauseAllThreadsAndRetry(clinicName, resumeState, 100000);
            return;
          }
        } catch (error) {
      logger.error('Operation failed', error);
    }

        // Some clinics append query params to the PDF link (e.g. .pdf?download=1)
        // Use a contains selector instead of ends-with to catch both cases
        pdfDownloadButton = findBestPdfDownloadLink();
        if (pdfDownloadButton) break;

        await sleep(1000);
        waitTime += 1000;
      }

      // Can't find the PDF download button
      if (!pdfDownloadButton) {
        // If we've hit max retries, fall back to a longer local pause and then try fresh
        if (currentRetry >= maxRetries) {
          sendStatus(`⚠️ PDF link not found after ${maxRetries} retries, pausing longer and retrying...`, 'warning');
          const resumeState = {
            action: 'downloadChart',
            clinicName,
            patientId,
            chartEntryId,
            headerText,
            patientName,
            remainingEntries,
            totalCharts,
            waitingForPdfPage: true,
            retryCount: 0,
            needsRefresh: true
          };
          await pauseAllThreadsAndRetry(clinicName, resumeState, 100000);
          return;
        }

        // Try again after a pause
        sendStatus(`⚠️ PDF link not found, pausing and retrying...`, 'warning');
        const resumeState = {
          action: 'downloadChart',
          clinicName,
          patientId,
          chartEntryId,
          headerText,
          patientName,
          remainingEntries,
          totalCharts,
          waitingForPdfPage: true,
          retryCount: currentRetry + 1,
          needsRefresh: true
        };

        await pauseAllThreadsAndRetry(clinicName, resumeState, 100000);
        return;
      }

      // Found the PDF button! Get its URL
      const pdfHref = pdfDownloadButton.getAttribute('href');
      let pdfUrl;

      // Make sure we have a full URL (not just a path)
      if (pdfHref.startsWith('http')) {
        pdfUrl = pdfHref;
      } else {
        const currentUrl = new URL(window.location.href);
        pdfUrl = `${currentUrl.protocol}//${currentUrl.host}${pdfHref}`;
      }

      if (shouldStop) {
        await chrome.storage.local.remove([getStorageKey('scrapingState')]);
        sendStatus('⏹️ Stopped', 'info');
        return;
      }

      // Create filename (clean up special characters)
      const cleanHeader = headerText.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_');
      const filename = `${cleanHeader}__${chartEntryId}.pdf`;
      
      // Check if we already downloaded this file
      try {
        const response = await new Promise((resolve) => {
          chrome.runtime.sendMessage({
            action: 'fileExistsInPatientFolder',
            patientId,
            filenamePrefix: filename
          }, (resp) => resolve(resp));
        });
        
        if (response && response.ok && response.exists) {
          sendStatus(`⏭️ Already have chart ${currentChartNum}/${totalCharts}`);
        } else {
          // Download the PDF
          sendStatus(`⬇️ Downloading chart ${currentChartNum}/${totalCharts}...`);
          await downloadPdfWithCookies(pdfUrl, filename, patientName, patientId);
          sendStatus(`✅ Downloaded: ${filename}`, 'success');
        }
      } catch (error) {
        // If check fails, just download it
        logger.warn('File existence check failed, proceeding with download', error);
        sendStatus(`⬇️ Downloading chart ${currentChartNum}/${totalCharts}...`);
        await downloadPdfWithCookies(pdfUrl, filename, patientName, patientId);
        sendStatus(`✅ Downloaded: ${filename}`, 'success');
      }

      if (shouldStop) {
        await chrome.storage.local.remove([getStorageKey('scrapingState')]);
        sendStatus('⏹️ Stopped', 'info');
        return;
      }

    // Wait a bit to let the download finish and add light jitter between downloads
    await sleepJitter(1000, 2000);

      if (shouldStop) {
        await chrome.storage.local.remove([getStorageKey('scrapingState')]);
        sendStatus('⏹️ Stopped', 'info');
        return;
      }

      // Clear our saved state
      await chrome.storage.local.remove([getStorageKey('scrapingState')]);

      // Are there more charts to download?
      if (remainingEntries && remainingEntries.length > 0) {
        if (shouldStop) {
          sendStatus('⏹️ Stopped', 'info');
          return;
        }

        // Wait a bit between charts with jitter to avoid bursts
        await sleepJitter(800, 2000);

        // Download the next chart
        const nextEntry = remainingEntries[0];
        const newRemaining = remainingEntries.slice(1);

        sendStatus(`⬇️ Next chart: ${nextEntry.index + 1}/${totalCharts}`);
        await initiateChartDownload(
          clinicName, patientId, nextEntry.chartEntryId, 
          nextEntry.headerText, patientName, newRemaining, totalCharts
        );

      } else {
        // All charts done for this patient!
        if (shouldStop) {
          sendStatus('⏹️ Stopped', 'info');
          return;
        }

        sendStatus(`✅ Completed patient ${patientId}`, 'success');

        // Tell coordinator we're done with this patient
        try {
          const cleanPatient = patientName.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_');
          const zipFilename = `jane-scraper/${patientId}_${cleanPatient}.zip`;
          chrome.runtime.sendMessage({
            action: 'completeWork',
            threadId,
            patientId,
            patientName,
            zipFilename,
            success: true
          });
        } catch (error) {
      logger.error('Operation failed', error);
    }

        // Request next patient
        await chrome.storage.local.set({
          [getStorageKey('scrapingState')]: {
            action: 'requestWork',
            clinicName
          }
        });

        await sleep(1000);
        window.location.href = urlUtils.buildScheduleUrl(clinicName);
      }

      return;
    }

    // PHASE 1: We're on the chart entry page - find and click the PDF button

    // Check if there's an error modal on the page
    const errorModal = document.querySelector('div.modal-header h3');
    if (errorModal && errorModal.textContent.trim() === "Hmmm... That's strange.") {
      sendStatus(`⚠️ Error modal detected for chart ${chartEntryId}`, 'error');
      chrome.storage.local.remove([getStorageKey('scrapingState')]);
      throw new Error('Error modal detected');
    }

    // Wait for page to load
    await sleep(1000);

    // Look for the PDF button
    const retryMsg = currentRetry > 0 ? ` [Retry ${currentRetry}/${maxRetries}]` : '';
    sendStatus(`🔍 Looking for PDF button${retryMsg}...`);
    const pdfButton = document.querySelector('a#pdf_button[href*=".pdf"]');

    // Can't find the PDF button
    if (!pdfButton) {
      if (currentRetry >= maxRetries) {
        // Give up after max retries
        sendStatus(`❌ PDF button not found after ${maxRetries} retries - stopping`, 'error');
        await chrome.storage.local.remove([getStorageKey('scrapingState')]);
        shouldStop = true;
        chrome.storage.local.set({ stopRequested: true });
        chrome.runtime.sendMessage({ action: 'broadcastStop' });
        return;
      }

      // Try again after a pause
      sendStatus(`⚠️ PDF button not found, pausing and retrying...`, 'warning');
      const resumeState = {
        action: 'downloadChart',
        clinicName,
        patientId,
        chartEntryId,
        headerText,
        patientName,
        remainingEntries,
        totalCharts,
        waitingForPdfPage: false,
        retryCount: currentRetry + 1,
        needsRefresh: true
      };

      await pauseAllThreadsAndRetry(clinicName, resumeState, 100000);
      return;
    }

    // Found the PDF button! Update our state before clicking
    await chrome.storage.local.set({
      [getStorageKey('scrapingState')]: {
        action: 'downloadChart',
        clinicName,
        patientId,
        chartEntryId,
        headerText,
        patientName,
        remainingEntries,
        totalCharts,
        waitingForPdfPage: true,
        retryCount: currentRetry
      }
    });

    // Click the PDF button (this will navigate to the PDF preview page)
    sendStatus(`🖱️ Clicking PDF button...`);
    await sleep(500); // Wait for page to be stable
    pdfButton.click();
    await sleep(500); // Wait for navigation to start

  } catch (error) {
    sendStatus(`❌ Error: ${error.message}`, 'error');

    // Try to recover from the error
    try {
      const clinic = state?.clinicName || getClinicNameFromUrl();
      await scheduleRecovery(clinic, {
        action: 'downloadChart',
        clinicName: state?.clinicName,
        patientId: state?.patientId,
        chartEntryId: state?.chartEntryId,
        headerText: state?.headerText,
        patientName: state?.patientName,
        remainingEntries: state?.remainingEntries,
        totalCharts: state?.totalCharts
      });
      return;
    } catch (error) {
      logger.error('Failed to initiate chart download', error);
      await chrome.storage.local.remove([getStorageKey('scrapingState')]);
      throw error;
    }
  }
}

// ============================================================================
// MAIN SCRAPING FLOW
// ============================================================================
//
// HOW THE SCRAPING PROCESS WORKS:
//
// 1. User starts scraping from the side panel
// 2. Background.js creates one or more worker tabs (threads)
// 3. Each tab logs in and requests a patient ID
// 4. The tab processes that ONE patient completely:
//    - Navigate to patient page
//    - Check if they exist
//    - Go to their charts page
//    - Download all their chart PDFs
// 5. When done, the tab requests the next patient
// 6. This repeats until there are no more patients
//
// Threading: If you set "2 threads", two tabs run this process in parallel
// ============================================================================

/**
 * Handle what happens after login completes
 * The page reloads after login, so this checks if we're logged in and starts scraping
 * Now uses the auth module for proper login validation
 */
async function handlePostLogin(state) {
  const { clinicName } = state;

  // Clear the post-login state
  await chrome.storage.local.remove([getStorageKey('scrapingState')]);

  try {
    // Use auth module to handle post-login check
    const success = await authModule.handlePostLogin({
      shouldStop: () => shouldStop,
      logger: logger
    });

    if (success) {
      sendStatus(`✅ Login successful`, 'success');
      scheduleNextWorkRequest(clinicName);
    } else {
      sendStatus(`❌ Login failed`, 'error');
      logger.error('Login validation failed after page reload');
    }
  } catch (error) {
    sendStatus(`❌ Post-login check failed: ${error.message}`, 'error');
    logger.error('Post-login check failed', error);
  }
}

/**
 * Process a patient (called after coordinator assigns us a patient)
 */
async function continueScrapingFromPatient(clinicName, patientId) {
  try {
    currentPatientId = patientId;

    // Process this ONE patient completely, then request the next one
    await processOnePatient(clinicName, patientId);

  } catch (error) {
    if (error.message === 'Stopped' || shouldStop) {
      sendStatus('⏹️ Stopped by user', 'info');
      return; // User stopped — don't request more work
    }
    sendStatus(`❌ Error processing patient ${patientId}: ${error.message}`, 'error');
    // Don't let the thread die — skip this patient and move on
    scheduleNextWorkRequest(clinicName);
  }
}

/**
 * Process a single patient from start to finish
 * This is the main workhorse function
 * 
 * Steps:
 * 1. Navigate to patient page
 * 2. Check if they exist
 * 3. Get their name
 * 4. Go to charts page
 * 5. Get list of all charts
 * 6. Download each chart PDF
 * 7. Tell coordinator we're done
 * 8. Request next patient
 */
async function processOnePatient(clinicName, patientId) {
  if (shouldStop) return;

  // Clear memory for this patient
  pdfDownloader.clearPatientData();
  currentPatientFiles = [];
  currentPatientDownloadIds = [];

  sendStatus(`📋 Processing patient ${patientId}...`);

  // Step 1: Navigate to patient page
  if (shouldStop) return;
  await navigateToPatient(clinicName, patientId);
  
  // Step 2: Check if patient exists with retries
  if (shouldStop) return;
  let existsResult = { exists: false, reason: 'not_found' };
  let counts = await getRetryCounts(patientId);
  for (let attempt = 1; attempt <= MAX_PATIENT_CHECK_RETRIES; attempt++) {
    existsResult = await checkPatientExists();
    if (existsResult?.exists) break;
    counts.patientCheck = attempt;
    await setRetryCounts(patientId, counts);
    // If paused due to freeze, stop here and allow resume
    if (existsResult?.paused) return;
    const reason = existsResult?.reason || 'unknown';
    sendStatus(`🔁 Retry patient existence check ${attempt}/${MAX_PATIENT_CHECK_RETRIES} (reason: ${reason})`, 'warning');
    await sleep(2000 + Math.min(5000, attempt * 1000));
    // Re-navigate to ensure fresh state between attempts
    await navigateToPatient(clinicName, patientId);
  }
  if (!existsResult?.exists) {
    const reason = existsResult?.reason || 'not_found';
    const human = reason === 'timeout' ? 'Patient check timed out' : 'Patient not found';
    sendStatus(`⚠️ ${human} after ${counts.patientCheck} retr${counts.patientCheck === 1 ? 'y' : 'ies'} - skipping`, 'warning');
    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'patientNotFound', threadId, patientId, reason }, resolve);
      });
    } catch (error) {
      logger.error('Operation failed', error);
    }
    await resetRetryCounts(patientId);
    scheduleNextWorkRequest(clinicName);
    return;
  }
  // Reset patient-check retries on success
  counts.patientCheck = 0;
  await setRetryCounts(patientId, counts);

  // Step 3: Get patient name
  if (shouldStop) return;
  const patientName = await getPatientName();
  sendStatus(`👤 Patient ${patientId}: ${patientName}`);

  // Step 4: Navigate to charts page
  if (shouldStop) return;
  // Step 4: Navigate to charts with retries and explicit reasons
  let chartsResult = { success: false, reason: 'no_charts' };
  for (let attempt = 1; attempt <= MAX_CHARTS_CHECK_RETRIES; attempt++) {
    chartsResult = await navigateToCharts(clinicName, patientId);
    if (chartsResult && chartsResult.success) break;
    // If paused due to freeze, stop here and allow resume
    if (chartsResult && chartsResult.paused) return;
    counts.charts = attempt;
    await setRetryCounts(patientId, counts);
    const reason = chartsResult?.reason || 'unknown';
    const msg = reason === 'timeout' ? 'charts check timed out' : 'no charts yet';
    sendStatus(`🔁 Retry charts check ${attempt}/${MAX_CHARTS_CHECK_RETRIES} (${msg})`, 'warning');
    await sleep(2000 + Math.min(8000, attempt * 2000));
  }
  if (!chartsResult || !chartsResult.success) {
    const reason = chartsResult?.reason || 'no_charts';
    const human = reason === 'timeout' ? 'Patient charts check timed out' : 'Patient has no charts';
    sendStatus(`ℹ️ ${human} after ${counts.charts} retr${counts.charts === 1 ? 'y' : 'ies'} - skipping`);
    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'patientNoCharts', threadId, patientId, reason }, resolve);
      });
    } catch (error) {
      logger.error('Operation failed', error);
    }
    await resetRetryCounts(patientId);
    scheduleNextWorkRequest(clinicName);
    return;
  }
  // Reset charts retries on success
  counts.charts = 0;
  await setRetryCounts(patientId, counts);

  // Step 5: Get all chart entries
  if (shouldStop) return;
  const chartEntries = await getChartEntries();
  sendStatus(`📄 Found ${chartEntries.length} charts`);

  // Quick check: are all charts already downloaded?
  try {
    const cleanPatient = patientName.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_');
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: 'countPatientPdfs',
        patientId,
        folderName: cleanPatient
      }, (resp) => resolve(resp));
    });
    
    if (response && response.ok) {
      const downloadedCount = Number(response.count || 0);
      const totalCount = chartEntries.length;
      
      if (downloadedCount >= totalCount && totalCount > 0) {
        sendStatus(`✅ Patient ${patientId} already complete (${downloadedCount}/${totalCount})`, 'success');
        // Mark as complete and get next patient
        try {
          const zipFilename = `jane-scraper/${patientId}_${cleanPatient}.zip`;
          chrome.runtime.sendMessage({
            action: 'completeWork',
            threadId,
            patientId,
            patientName,
            zipFilename,
            success: true
          });
        } catch (error) {
      logger.error('Operation failed', error);
    }
        scheduleNextWorkRequest(clinicName);
        return;
      }
    }
  } catch (error) {
      logger.error('Operation failed', error);
    }

  // Step 6: Download charts (skip ones we already have)
  if (chartEntries.length > 0) {
    const totalCharts = chartEntries.length;
    const entriesToDownload = [];
    
    // Check which charts we already have
    for (const entry of chartEntries) {
      const cleanHeader = entry.headerText.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_');
      const filename = `${cleanHeader}__${entry.chartEntryId}.pdf`;
      
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'fileExistsInPatientFolder',
          patientId,
          filenamePrefix: filename
        }, (resp) => resolve(resp));
      });
      
      if (response && response.ok && response.exists) {
        sendStatus(`⏭️ Already have chart ${entry.index + 1}/${totalCharts}`);
        continue;
      }
      
      entriesToDownload.push(entry);
    }

    if (entriesToDownload.length === 0) {
      sendStatus(`✅ Patient ${patientId} complete`, 'success');
      // Mark as complete and get next patient
      try {
        const cleanPatient = patientName.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_');
        const zipFilename = `jane-scraper/${patientId}_${cleanPatient}.zip`;
        chrome.runtime.sendMessage({
          action: 'completeWork',
          threadId,
          patientId,
          patientName,
          zipFilename,
          success: true
        });
      } catch (error) {
      logger.error('Operation failed', error);
    }
      scheduleNextWorkRequest(clinicName);
      return;
    }

    // Start downloading the first chart
    const first = entriesToDownload[0];
    const remaining = entriesToDownload.slice(1);
    
    sendStatus(`⬇️ Downloading chart ${first.index + 1}/${totalCharts}`);
    await initiateChartDownload(
      clinicName, patientId, first.chartEntryId,
      first.headerText, patientName, remaining, totalCharts
    );
    return;
  }

  sendStatus(`✅ Completed patient ${patientId}`);
}

/**
 * Request the next patient to work on from the coordinator
 * 
 * This is how we avoid duplicate work when running multiple threads.
 * Background.js keeps track of which patients are being worked on and
 * assigns the next available patient ID to this thread.
 */
async function requestNextWork(clinicName) {
  if (shouldStop) {
    return;
  }

  // Wait a bit between patients (be nice to Jane's servers)
  await sleep(1500);

  if (shouldStop) {
    return;
  }

  try {
    // Use Promise wrapper instead of async callback — chrome.runtime.sendMessage
    // does not await async callbacks, so errors get silently swallowed
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'requestWork', threadId }, (resp) => resolve(resp));
    });

    if (response && response.status === 'assigned' && response.patientId) {
      // We got assigned a patient!
      sendStatus(`📋 Assigned patient ${response.patientId}`, 'success');
      await sleep(1000);
      await continueScrapingFromPatient(response.clinicName || clinicName, response.patientId);

    } else if (response && response.status === 'done') {
      // No more patients to process
      sendStatus(`✅ All patients complete - thread stopping`, 'success');

      // Tell background to remove this thread
      try {
        chrome.runtime.sendMessage({ action: 'threadComplete', threadId });
      } catch (error) {
        logger.error('Operation failed', error);
      }

    } else {
      sendStatus(`⚠️ Unexpected response: ${JSON.stringify(response)}`, 'error');
      // Don't silently stop — retry after a delay
      scheduleNextWorkRequest(clinicName, 5000);
      return;
    }
  } catch (error) {
    sendStatus(`❌ Failed to request work: ${error.message}`, 'error');
    // Don't silently stop — retry after a delay
    scheduleNextWorkRequest(clinicName, 5000);
  }
}

function scheduleNextWorkRequest(clinicName, delayMs = 0) {
  if (shouldStop) {
    return;
  }

  const timeout = setTimeout(async () => {
    activeTimeouts = activeTimeouts.filter(t => t !== timeout);

    if (shouldStop) {
      return;
    }

    try {
      await requestNextWork(clinicName);
    } catch (error) {
      if (!(error.message === 'Stopped' || error.message?.includes('Stopped while'))) {
        logger.error('Scheduled next-work request failed', error);
      }
    }
  }, delayMs);

  activeTimeouts.push(timeout);
}

/**
 * Start the scraping process (called by background.js via initThread message)
 * This logs in and then the page reload will trigger the post-login flow
 */
async function startScraping(clinicName, email, password) {
  try {
    shouldStop = false;
    cancelAllTimeouts();

    sendStatus('🚀 Starting...');

    // Save state so we know what to do after page reloads from login
    await chrome.storage.local.set({
      [getStorageKey('scrapingState')]: {
        action: 'postLogin',
        clinicName,
        email,
        password
      }
    });

    // Login (this will cause the page to reload)
    const loggedIn = await login(email, password);

    if (!loggedIn || shouldStop) {
      sendStatus('❌ Login failed', 'error');
      await chrome.storage.local.remove([getStorageKey('scrapingState')]);
      return;
    }

    // After login, the page reloads and the post-login handler continues

  } catch (error) {
    if (error.message === 'Stopped' || shouldStop) {
      sendStatus('⏹️ Stopped by user', 'info');
    } else {
      sendStatus(`❌ Error: ${error.message}`, 'error');
    }
    await chrome.storage.local.remove([getStorageKey('scrapingState')]);
  }
}

// ============================================================================
// PAGE LOAD & EVENT LISTENERS
// ============================================================================
//
// These run when the page loads and handle:
// - Resuming from saved state after page navigation
// - Handling messages from background.js (start, stop, etc.)
// - Rate limit detection and recovery
// ============================================================================

// Listen for page loads to resume scraping
chrome.storage.local.get(getBootstrapStorageKeys(), async (result) => {
  // Reset global freeze flag on page load, so it only clears after a reload
  try {
    if (result && result.frozen) {
      await chrome.storage.local.set({ frozen: false });
    }
  } catch (error) {
      logger.error('Operation failed', error);
    }

  // Global cooldown removed; threads self-manage pauses
  // Get thread ID for this tab
  try {
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'getThreadAssignment' }, (resp) => {
        if (resp && resp.ok && resp.threadId) {
          threadId = resp.threadId;
          logger.setThreadId(threadId); // Update logger with thread ID
        } else {
          // This is normal for tabs that aren't worker threads - don't log as error
        }
        resolve();
      });
    });
  } catch (e) {
    // Only log if we have a saved state (meaning we're in an active scraping context)
    if (result && result[getStorageKey('scrapingState')]) {
      console.error('[Thread] Error getting threadId:', e);
    }
  }

  // If we don't have a threadId but there's a saved state with one, try to restore it
  if (!threadId) {
    // Check all possible thread-scoped states
    for (let i = 1; i <= THREADING.MAX_THREADS; i++) {
      const key = `T${i}_scrapingState`;
      if (result[key] && result[key].savedThreadId) {
        threadId = result[key].savedThreadId;
        logger.setThreadId(threadId); // Update logger with restored thread ID
        break;
      }
    }
  }

  if (threadId) {
    startThreadWatchdog();
  }

  // Staff-first phase dispatcher (new flow). Each phase handler reads its
  // state from `{threadId}_phaseState` in chrome.storage.local so that a page
  // reload resumes into the same phase mid-flight.
  phaseDispatcher = createPhaseDispatcher({
    getContext: () => ({
      threadId,
      logger,
      pdfDownloader,
      fileChecker,
      shouldStop: () => shouldStop,
      ensureLoggedIn: async (clinicName) => {
        try {
          if (await authModule.isAlreadyLoggedIn()) {
            logger?.debug?.(`[auth] already logged in (thread=${threadId})`);
            return true;
          }
        } catch (error) {
          logger?.warn?.(`[auth] isAlreadyLoggedIn check threw: ${error.message}`);
        }
        const credsKey = getStorageKey('credentials');
        const wrap = await chrome.storage.local.get(credsKey);
        const creds = wrap[credsKey] || {};
        const email = creds.email;
        const password = creds.password;
        if (!email || !password) {
          throw new Error(`ensureLoggedIn: missing credentials for ${threadId}`);
        }
        logger?.info?.(`[auth] logging in for thread ${threadId}`);
        await chrome.storage.local.set({
          [getStorageKey('credentials')]: { clinicName, email, password },
        });
        const result = await authModule.login(email, password, {
          shouldStop: () => shouldStop,
          logger,
        });
        logger?.info?.(`[auth] login result: ${JSON.stringify({ success: result?.success, alreadyLoggedIn: result?.alreadyLoggedIn, willReload: result?.willReload })}`);
        return true;
      },
    }),
  });

  // If a phaseState is present (page reloaded mid-phase), resume it.
  try {
    const resumed = await phaseDispatcher.resumeFromStorage();
    if (resumed) return;
  } catch (error) {
    logger.error('Phase resume failed', error);
  }

  const scopedState = threadId ? result[getStorageKey('scrapingState')] : null;

  // Check for explicit user stop; ignore transient stopRequested so threads auto-resume
  if (result.userRequestedStop || shouldStop) {
    chrome.storage.local.remove(['stopRequested', 'userRequestedStop', getStorageKey('scrapingState'), 'appointmentsState', 'migrationState', 'patientsState']);
    sendStatus('⏹️ Scraping stopped', 'info');
    return;
  }

  // Early global freeze/rate-limit detection only when we're resuming active work
  try {
    if (result && (result.migrationState || result.appointmentsState || scopedState)) {
      if (document.readyState === 'loading') {
        await new Promise(r => document.addEventListener('DOMContentLoaded', r));
      }
      await sleep(200);
      await detectAndHandleRateLimit();
    }
  } catch (error) {
      logger.error('Operation failed', error);
    }

  // Resume migration flow if present
  if (result && result.migrationState) {
    if (document.readyState === 'loading') {
      await new Promise(r => document.addEventListener('DOMContentLoaded', r));
    }
    await runMigrationFlow(result.migrationState, { fromResume: true });
    return;
  }

  // Resume appointments flow if present
  if (result && result.appointmentsState) {
    if (document.readyState === 'loading') {
      await new Promise(r => document.addEventListener('DOMContentLoaded', r));
    }
    await runAppointmentsFlow(result.appointmentsState, { fromResume: true });
    return;
  }

  // Resume from saved state if exists
  if (!scopedState) return;

  if (document.readyState === 'loading') {
    await new Promise(r => document.addEventListener('DOMContentLoaded', r));
  }
  await sleep(500);

  // Handle different state actions
  if (scopedState.action === 'downloadChart') {
    return await handleChartDownload(scopedState);
  }

  if (scopedState.action === 'postLogin') {
    return await handlePostLogin(scopedState);
  }

  if (scopedState.action === 'requestWork') {
    await chrome.storage.local.remove([getStorageKey('scrapingState')]);
    // If we have a resumePatientId, continue with that patient instead of requesting new work
    if (scopedState.resumePatientId) {
      sendStatus(`🔄 Resuming patient ${scopedState.resumePatientId}...`, 'info');
      return await continueScrapingFromPatient(scopedState.clinicName, scopedState.resumePatientId);
    }
    return await requestNextWork(scopedState.clinicName);
  }

  // No more complex recovery phases - downloadChart action handles everything
});

// Simplified: no complex fallback logic needed

// Listen for stop command
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Staff-first phase messages route through the dispatcher first.
  if (phaseDispatcher && ['initPreflight', 'beginDiscovery', 'beginDownload', 'beginProfile'].includes(request.action)) {
    return phaseDispatcher.handleMessage(request, sender, sendResponse);
  }

  if (request.action === 'stopScraping') {
    shouldStop = true;
    cancelAllTimeouts();
    sendStatus('⏹️ Scraping stopped', 'info');

    // Clear all state
    chrome.storage.local.set({ stopRequested: true });
    chrome.storage.local.remove([getStorageKey('scrapingState'), getStorageKey('credentials'), getStorageKey('phaseState')]);

    sendResponse({ success: true });
  } else if (request.action === 'initThread') {
    threadId = request.threadId;
    logger.setThreadId(threadId); // Update logger with thread ID
    const loginDelayMs = request.loginDelayMs || 0;

    sendResponse({ ok: true, threadId });

    (async () => {
      const { clinicName, email, password } = request;

      if (loginDelayMs > 0) {
        sendStatus(`⏳ Waiting ${loginDelayMs / 1000}s before starting...`);
        await sleep(loginDelayMs);
      }

      sendStatus(`🚀 Starting scraping process...`);

      // Save credentials for this thread
      await chrome.storage.local.set({
        [getStorageKey('credentials')]: { clinicName, email, password }
      });

      // Check if we need to login
      if (document.readyState === 'loading') {
        await new Promise(r => document.addEventListener('DOMContentLoaded', r));
      }
      await sleep(1000);

      const loginFormPresent = !!document.querySelector('input[name="auth_key"], input#auth_key');

      if (loginFormPresent) {
        // Use startScraping so post-login state is saved and resume works after reload
        sendStatus(`🔐 Logging in...`);
        await startScraping(clinicName, email, password);
      } else {
        // Already logged in - just request work
        sendStatus(`✅ Already logged in!`);
        scheduleNextWorkRequest(clinicName);
      }
    })();
    return true;
  } else if (request.action === 'initAppointments') {
    (async () => {
      try {
        appointmentsState = {
          clinicName: request.clinicName,
          email: request.email,
          password: request.password,
          startDate: request.startDate,
          endDate: request.endDate
        };
        await runAppointmentsFlow(appointmentsState);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  } else if (request.action === 'initMigration') {
    (async () => {
      try {
        migrationState = {
          clinicName: request.clinicName,
          email: request.email,
          password: request.password,
          startDate: request.startDate,
          endDate: request.endDate
        };
        await runMigrationFlow(migrationState);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  // Global pause/resume message handlers removed
  }
});


})(); // Close async IIFE wrapper
