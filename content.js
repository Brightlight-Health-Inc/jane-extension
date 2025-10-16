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

// ============================================================================
// SIMPLE CONFIGURATION
// ============================================================================
const max_id = null; // null for no max
const MAX_WAIT_TIME = 60000; // Maximum time to wait for page loads (60 seconds)
const PAGE_DELAY = 1000; // Standard delay between actions (1 second)
const MIN_PDF_FETCH_GAP_MS = 2500; // Minimum gap between PDF downloads per thread

// ============================================================================
// STATE TRACKING
// ============================================================================

// Simple flags to track what's happening
let shouldStop = false;        // User clicked stop button
let currentPatientId = 1;      // Which patient we're working on right now
let activeTimeouts = [];       // List of timeouts we can cancel if we need to stop
let threadId = null;           // Our thread ID (like "T1" or "T2")

// Helper: Get storage keys unique to this thread
function getStorageKey(key) {
  return threadId ? `${threadId}_${key}` : key;
}

// Current patient's files (just for tracking, not used for zipping anymore)
let currentPatientFiles = [];
let currentPatientDownloadIds = [];

// ============================================================================
// INDEXEDDB STORAGE (persists files across page navigations)
// ============================================================================

const DB_NAME = 'JaneScraperDB';
const STORE_NAME = 'patientFiles';
let dbPromise = null;

function openDatabase() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: ['patient', 'filename'] });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

async function saveFileToDatabase(patientName, filename, blob, downloadId) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);

    const store = transaction.objectStore(STORE_NAME);
    store.put({ patient: patientName, filename, blob, downloadId });
  });
}

async function getFilesFromDatabase(patientName) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const files = [];

    const request = store.openCursor();

    request.onsuccess = (event) => {
      const cursor = event.target.result;

      if (cursor) {
        const record = cursor.value;
        if (record.patient === patientName) {
          files.push({
            filename: record.filename,
            blob: record.blob,
            downloadId: record.downloadId
          });
        }
        cursor.continue();
      } else {
        resolve(files);
      }
    };

    request.onerror = () => reject(request.error);
  });
}

async function clearDatabaseForPatient(patientName) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const keysToDelete = [];

    const request = store.openCursor();

    request.onsuccess = (event) => {
      const cursor = event.target.result;

      if (cursor) {
        if (cursor.value.patient === patientName) {
          keysToDelete.push(cursor.primaryKey);
        }
        cursor.continue();
      } else {
        // Now delete all the keys we found
        if (keysToDelete.length === 0) {
          resolve();
          return;
        }

        let remaining = keysToDelete.length;
        keysToDelete.forEach((key) => {
          const deleteRequest = store.delete(key);
          deleteRequest.onsuccess = () => {
            remaining--;
            if (remaining === 0) resolve();
          };
          deleteRequest.onerror = () => reject(deleteRequest.error);
        });
      }
    };

    request.onerror = () => reject(request.error);
  });
}

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
 * Send a status message to the UI panel
 * Automatically adds thread ID to messages (like "[T1]" or "[T2]")
 */
function sendStatus(message, type = 'info') {
  const prefix = threadId ? `[${threadId}] ` : '';
  const fullMessage = prefix + message;
  
  chrome.runtime.sendMessage({
    action: 'statusUpdate',
    status: { message: fullMessage, type, threadId }
  });

  // Heartbeat for watchdog: update last activity timestamp per thread
  try {
    chrome.storage.local.set({ [getStorageKey('lastHeartbeat')]: Date.now() });
  } catch (_) {}
}

/**
 * Check if we hit Jane's rate limit page
 * Jane shows a "Whoa there friend, please take a moment" page when you're going too fast
 */
async function detectAndHandleRateLimit() {
  try {
    // Look for rate limit text in the page
    const bodyText = (document.body?.innerText || '').toLowerCase();
    const isRateLimitPage = bodyText.includes('whoa there friend') && 
                           bodyText.includes('please take a moment');
    
    if (!isRateLimitPage) {
      return false; // Not a rate limit page, we're good
    }

    // We hit the rate limit! Pause only this thread, then resume
    sendStatus('⚠️ Rate limit detected. Pausing this thread for 60 seconds...', 'warning');
    shouldStop = true;
    cancelAllTimeouts();

    const clinicName = getClinicNameFromUrl();
    let resumeState = null;
    try {
      const storage = await chrome.storage.local.get(getStorageKey('scrapingState'));
      resumeState = storage[getStorageKey('scrapingState')] || null;
    } catch (_) {}

    // Do a local pause and resume with saved state
    await pauseAllThreadsAndRetry(clinicName, resumeState, 60_000);
    return true;
  } catch (_) {
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
  } catch (_) {
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
    // Prefer a light refresh to avoid SPA dead-ends when idle
    try {
      shouldStop = false;
      const currentUrl = window.location.href;
      window.location.href = currentUrl;
    } catch (_) {
      await requestNextWork(clinicName);
    }
  }
}

/**
 * Pause all threads and wait before retrying
 * Used when we can't find PDF controls (page not loaded properly)
 */
async function pauseAllThreadsAndRetry(clinicName, resumeState, pauseMs = 70_000) {
  try {
    if (!clinicName) clinicName = getClinicNameFromUrl();
    if (!clinicName || shouldStop) return;

    // Local pause ONLY for this thread (do not broadcast)
    shouldStop = true;
    cancelAllTimeouts();

    // Mark global freeze so other threads/UX know the app controls appear frozen
    try {
      await chrome.storage.local.set({ forzen: true });
    } catch (_) {}

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
      await requestNextWork(clinicName);
    }
  } catch (_) {
    // Ignore errors in pause logic
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
 * Types like a human to avoid detection as a bot
 */
async function login(email, password) {
  try {
    // Make sure page is loaded
    if (document.readyState === 'loading') {
      await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve));
    }
    await sleep(500);

    // Check if we're already logged in
    const isOnAdminPage = window.location.href.includes('/admin');
    const hasLoginForm = document.querySelector('input[name="auth_key"], input#auth_key');
    
    if (isOnAdminPage && !hasLoginForm) {
      sendStatus('✅ Already logged in!', 'success');
      return true;
    }

    sendStatus('⏳ Waiting for login page...');
    await sleep(500);

    // Find the email field
    sendStatus('🔍 Finding email field...');
    const emailInput = document.querySelector('input[name="auth_key"], input#auth_key');

    if (!emailInput) {
      sendStatus('❌ Email field not found - retrying...', 'error');
      await sleep(1000);
      return login(email, password); // Try again recursively
    }

    // Type email character by character (looks more human)
    sendStatus('⌨️ Typing email...');
    emailInput.focus();
    await sleep(100);

    for (const character of email) {
      emailInput.value += character;
      emailInput.dispatchEvent(new Event('input', { bubbles: true }));
      
      // Random delay between 30-60ms to simulate human typing
      const delay = 30 + Math.random() * 30;
      await sleep(delay);
    }

    sendStatus('✓ Email entered');
    await sleep(200);

    // Find the password field
    const passwordInput = document.querySelector('input[name="password"], input#password');

    if (!passwordInput) {
      sendStatus('❌ Password field not found', 'error');
      return false;
    }

    // Type password character by character
    sendStatus('⌨️ Typing password...');
    passwordInput.focus();
    await sleep(100);

    for (const character of password) {
      passwordInput.value += character;
      passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
      
      const delay = 30 + Math.random() * 30;
      await sleep(delay);
    }

    sendStatus('✓ Password entered');
    await sleep(300);

    // Find and click the sign in button
    sendStatus('🔘 Clicking Sign In button...');
    const signInButton = document.querySelector('button#log_in, form button[type="submit"], button:has([data-test="sign-in"])');

    if (!signInButton) {
      sendStatus('❌ Sign In button not found', 'error');
      return false;
    }

    signInButton.click();
    return true; // Page will reload after this

  } catch (error) {
    sendStatus('❌ Login error: ' + error.message, 'error');
    return false;
  }
}

// ============================================================================
// NAVIGATION FUNCTIONS
// ============================================================================

/**
 * Navigate to a patient's main page
 */
async function navigateToPatient(clinicName, patientId) {
  sendStatus(`🔄 Navigating to patient ${patientId}...`);
  await sleep(1000);
  
  const url = `https://${clinicName}.janeapp.com/admin#patients/${patientId}`;
  window.location.href = url;
  
  await sleep(3000); // Wait for page to load
  sendStatus(`✓ Arrived at patient ${patientId} page`);
}

/**
 * Navigate to a patient's charts page and load all charts
 */
async function navigateToCharts(clinicName, patientId) {
  sendStatus(`🔄 Navigating to charts page for patient ${patientId}...`);
  await sleep(1000);
  
  const url = `https://${clinicName}.janeapp.com/admin#patients/${patientId}/charts`;
  window.location.href = url;

  // Wait for Jane's single-page app to load the charts view
  await sleep(3500);
  sendStatus(`⏳ Waiting for charts to render...`);
  
  const chartsLoaded = await waitForChartsLoaded({ maxWaitMs: 40000 });

  // Check if there are any charts on the page
  const chartPanels = document.querySelectorAll('div.panel.panel-default.chart-entry.panel-no-gap');

  if (!chartsLoaded || chartPanels.length === 0) {
    // If page is marked frozen, pause and refresh charts route instead of skipping
    try {
      const freeze = await chrome.storage.local.get('forzen');
      if (freeze && freeze.forzen) {
        sendStatus(`🧊 Charts view appears frozen. Waiting 100s then refreshing charts...`, 'warning');
        try {
          await chrome.storage.local.set({
            [getStorageKey('scrapingState')]: {
              action: 'requestWork',
              clinicName,
              resumePatientId: patientId,
              savedThreadId: threadId
            }
          });
        } catch (_) {}
        await sleep(100000);
        window.location.href = url;
        return { success: false, paused: true };
      }
    } catch (_) {}
    sendStatus(`✓ No charts found for patient ${patientId}`);
    return false;
  }

  sendStatus(`✓ Charts page loaded successfully`);

  // Click "Load More" button until all charts are loaded
  let loadMoreCount = 0;
  const maxRepeats = 10;
  
  while (true) {
    // Look for the "Load More" button
    const loadMoreButton = Array.from(document.querySelectorAll('button.btn.btn-link'))
      .find(btn => (btn.textContent || '').trim().toLowerCase() === 'load more');
    
    if (!loadMoreButton) {
      // No more "Load More" button, we're done
      const plural = loadMoreCount !== 1 ? 's' : '';
      sendStatus(`✓ All charts loaded (clicked ${loadMoreCount} "Load More" button${plural})`);
      break;
    }
    
    // Click the button
    loadMoreButton.click();
    loadMoreCount++;
    sendStatus(`🔍 Clicked "Load More" button #${loadMoreCount}`);
    
    // Wait for charts to load
    for (let i = 0; i < maxRepeats; i++) {
      await sleep(1000);
      
      // Check if the button says "Loading..."
      const loadingButton = Array.from(document.querySelectorAll('button.btn.btn-link[disabled]'))
        .find(btn => (btn.textContent || '').trim().toLowerCase().startsWith('loading'));
      
      if (!loadingButton) {
        // Not loading anymore, break out of wait loop
        break;
      }
    }
  }

  return { success: true, alreadyComplete: false };
}

// ============================================================================
// PATIENT CHECKING FUNCTIONS
// ============================================================================

/**
 * Check if the patient exists on their page
 * Returns true if patient exists, false if not found
 */
async function checkPatientExists() {
  sendStatus(`🔍 Checking if patient exists...`);
  await sleep(3000); // Wait for page to load

  // If a global freeze was signaled, wait and re-enter the same URL, then resume
  try {
    const freeze = await chrome.storage.local.get('forzen');
    if (freeze && freeze.forzen) {
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
      } catch (_) {}

      // Small pause, then re-enter same patient URL to refresh SPA route
      await sleep(100_000);
      const clinic = getClinicNameFromUrl();
      if (clinic) {
        const url = `https://${clinic}.janeapp.com/admin#patients/${currentPatientId}`;
        window.location.href = url;
      }
      return false;
    }
  } catch (_) {}

  // Wait for loading spinner to disappear
  const spinnerSelector = 'i.icon-spinner.text-muted.icon-spin';
  const startTime = Date.now();
  const maxWaitTime = 20000; // 20 seconds

  while (document.querySelector(spinnerSelector)) {
    if (Date.now() - startTime > maxWaitTime) {
      sendStatus(`⚠️ Patient check timed out`, 'warning');
      return false; // Spinner never went away
    }
    await sleep(500);
  }

  // Check for error messages on the page
  const errorElement = document.querySelector('.alert-danger, .error-message');
  if (errorElement) {
    sendStatus(`⚠️ Patient not found (error message shown)`, 'error');
    return false;
  }

  // Check if patient name element is on the page
  const nameElement = document.querySelector('.row .col-xs-10.col-sm-11 .sensitive.text-selectable');
  
  if (nameElement) {
    sendStatus(`✓ Patient found`);
    return true;
  } else {
    sendStatus(`⚠️ Patient not found (no name element)`, 'error');
    return false;
  }
}

/**
 * Get the patient's name from the page
 */
async function getPatientName() {
  try {
    await sleep(500);
    const nameElement = document.querySelector('.row .col-xs-10.col-sm-11 .sensitive.text-selectable');
    return nameElement ? nameElement.textContent.trim() : '';
  } catch {
    return '';
  }
}

// ============================================================================
// CHART EXTRACTION FUNCTIONS
// ============================================================================

/**
 * Extract all chart entries from the charts page
 * Returns an array of chart objects with header text, ID, and index
 */
async function getChartEntries() {
  const entries = [];
  const panels = document.querySelectorAll('div.panel.panel-default.chart-entry.panel-no-gap');

  for (let i = 0; i < panels.length; i++) {
    const panel = panels[i];

    // Get the header container that has date and title
    const headerContainer = panel.querySelector('div.ellipsis-after-3-lines.flex-order-sm-2.flex-item.flex-pull-left');
    
    let dateText = '';
    let titleText = '';

    // Extract date and title from the header
    const dateSpan = headerContainer?.querySelector('span[data-test-id="chart_entry_header_date"]');
    const titleSpan = headerContainer?.querySelector('span[data-test-id="chart_entry_header_title"]');

    if (dateSpan) dateText = dateSpan.textContent.trim();
    if (titleSpan) titleText = titleSpan.textContent.trim();

    // Combine date and title for a readable header
    const headerText = `${dateText} ${titleText}`.trim();

    // Get the chart entry ID from the print/PDF link
    let chartEntryId = '';
    const printLink = panel.querySelector('a[href*="/admin/patients/"][href*="/chart_entries/"][target="_blank"]');

    if (printLink) {
      const href = printLink.getAttribute('href') || '';
      const match = href.match(/\/chart_entries\/(\d+)/);
      if (match) {
        chartEntryId = match[1];
      }
    }

    entries.push({
      headerText: headerText,
      chartEntryId: chartEntryId,
      index: i
    });
  }

  return entries;
}

// ============================================================================
// PDF DOWNLOAD FUNCTIONS
// ============================================================================

/**
 * Download a PDF file and save it to disk
 * 
 * Steps:
 * 1. Fetch the PDF from Jane App (using our login cookies)
 * 2. Create a blob URL for the PDF
 * 3. Tell Chrome to download it to the patient's folder
 * 4. Wait for the download to complete
 */
async function downloadPdfWithCookies(pdfUrl, filename, patientName, patientId) {
  try {
    // Throttle: ensure minimum gap between fetches per thread
    try {
      const wrap = await chrome.storage.local.get(getStorageKey('lastPdfFetchTs'));
      const lastTs = Number(wrap[getStorageKey('lastPdfFetchTs')] || 0);
      const now = Date.now();
      const delta = now - lastTs;
      if (delta < MIN_PDF_FETCH_GAP_MS) {
        await sleep(MIN_PDF_FETCH_GAP_MS - delta);
      }
      await chrome.storage.local.set({ [getStorageKey('lastPdfFetchTs')]: Date.now() });
    } catch (_) {}

    sendStatus(`⬇️ Fetching PDF from server...`);

    // Fetch the PDF file from Jane App
    const response = await fetch(pdfUrl, {
      method: 'GET',
      credentials: 'include', // This includes our login cookies
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': window.location.href,
        'User-Agent': navigator.userAgent
      }
    });

    if (!response.ok) {
      sendStatus(`❌ PDF fetch failed: HTTP ${response.status}`, 'error');
      throw new Error(`PDF fetch failed: ${response.status}`);
    }

    // Convert response to a blob (binary data)
    const blob = await response.blob();

    if (blob.size === 0) {
      sendStatus(`❌ Downloaded PDF is empty`, 'error');
      throw new Error('Downloaded PDF is empty');
    }

    // Store blob in memory (for tracking, not used for zipping anymore)
    currentPatientFiles.push({ filename, blob });

    // Save the PDF to disk
    sendStatus(`💾 Saving PDF to Downloads folder...`);

    // Create a temporary URL for the blob
    const blobUrl = URL.createObjectURL(blob);
    
    // Clean up patient name for folder (remove special characters)
    const cleanPatientName = patientName.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_');
    const patientFolder = `jane-scraper/${patientId}_${cleanPatientName}`;

    // Ask Chrome to download the file
    const downloadId = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        action: 'downloadPDF',
        url: blobUrl,
        filename: `${patientFolder}/${filename}`,
        saveAs: false // Don't ask user where to save
      }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response.error) {
          reject(new Error(response.error));
        } else {
          resolve(response.downloadId);
        }
      });
    });

    // Wait for the download to finish
    let downloadComplete = false;
    let attempts = 0;
    const maxAttempts = 60; // Try for up to 30 seconds

    while (!downloadComplete && attempts < maxAttempts) {
      if (shouldStop) {
        URL.revokeObjectURL(blobUrl);
        throw new Error('Stopped');
      }

      // Check download status
      const downloadState = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'checkDownload',
          downloadId: downloadId
        }, (response) => {
          resolve(response.state);
        });
      });

      if (downloadState === 'complete') {
        downloadComplete = true;
      } else if (downloadState === 'interrupted') {
        URL.revokeObjectURL(blobUrl);
        throw new Error('Download interrupted');
      }

      if (!downloadComplete) {
        await sleep(500);
        attempts++;
      }
    }

    // Clean up the temporary blob URL
    URL.revokeObjectURL(blobUrl);

    if (shouldStop) {
      throw new Error('Stopped');
    }

    if (!downloadComplete) {
      throw new Error('Download timed out');
    }

    // Track this download
    currentPatientDownloadIds.push(downloadId);
    
    // Try to save to IndexedDB (ignore errors, it's just for backup)
    try {
      await saveFileToDatabase(patientName, filename, blob, downloadId);
    } catch (e) {
      console.warn('IndexedDB save failed', e);
    }

    return true;

  } catch (error) {
    // If download failed, try to recover
    try {
      const clinicName = getClinicNameFromUrl();
      const storage = await chrome.storage.local.get(getStorageKey('scrapingState'));
      const currentState = storage[getStorageKey('scrapingState')];
      await scheduleRecovery(clinicName, currentState);
      return false;
    } catch (_) {
      throw error;
    }
  }
}

// ============================================================================
// CLEANUP FUNCTIONS
// ============================================================================

/**
 * Clean up after finishing a patient
 * We used to zip files here, but now we save directly to folders
 */
async function zipPatientFiles(patientName, patientId) {
  try {
    // Clear memory for next patient
    currentPatientFiles = [];
    currentPatientDownloadIds = [];
    
    // Clear IndexedDB (ignore errors)
    try {
      await clearDatabaseForPatient(patientName);
    } catch (e) {
      console.warn('IndexedDB clear failed', e);
    }
  } catch (_) {
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
      const freeze = await chrome.storage.local.get('forzen');
      if (freeze && freeze.forzen) {
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
    } catch (_) {}

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
          const freeze = await chrome.storage.local.get('forzen');
          if (freeze && freeze.forzen) {
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
        } catch (_) {}

        // Some clinics append query params to the PDF link (e.g. .pdf?download=1)
        // Use a contains selector instead of ends-with to catch both cases
        pdfDownloadButton = document.querySelector('a.btn.btn-default[href*=".pdf"]');
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
      } catch (_) {
        // If check fails, just download it
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
        } catch (_) {}

        // Request next patient
        await chrome.storage.local.set({
          [getStorageKey('scrapingState')]: {
            action: 'requestWork',
            clinicName
          }
        });

        await sleep(1000);
        window.location.href = `https://${clinicName}.janeapp.com/admin#schedule`;
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
    } catch (_) {
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
 */
async function handlePostLogin(state) {
  const { clinicName } = state;

  // Clear the post-login state
  await chrome.storage.local.remove([getStorageKey('scrapingState')]);
  await sleep(3000); // Wait for Jane App to finish loading

  // Check if we're logged in successfully
  const isOnAdminPage = window.location.href.includes('/admin');
  const hasJaneAppShell = !!document.querySelector('#ember-basic-dropdown-wormhole, header, nav');
  
  if (isOnAdminPage && hasJaneAppShell) {
    sendStatus(`✅ Login successful`, 'success');
    await requestNextWork(clinicName);
  } else {
    sendStatus(`❌ Login failed`, 'error');
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
    } else {
      sendStatus(`❌ Error: ${error.message}`, 'error');
    }
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
  currentPatientFiles = [];
  currentPatientDownloadIds = [];

  sendStatus(`📋 Processing patient ${patientId}...`);

  // Step 1: Navigate to patient page
  if (shouldStop) return;
  await navigateToPatient(clinicName, patientId);
  
  // Step 2: Check if patient exists
  if (shouldStop) return;
  const patientExists = await checkPatientExists();
  
  if (!patientExists) {
    sendStatus(`⚠️ Patient ${patientId} not found`);
    // Tell coordinator and get next patient
    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'patientNotFound', threadId, patientId }, resolve);
      });
    } catch (_) {}
    await requestNextWork(clinicName);
    return;
  }

  // Step 3: Get patient name
  if (shouldStop) return;
  const patientName = await getPatientName();
  sendStatus(`👤 Patient ${patientId}: ${patientName}`);

  // Step 4: Navigate to charts page
  if (shouldStop) return;
  const chartsResult = await navigateToCharts(clinicName, patientId);

  if (!chartsResult || !chartsResult.success) {
    if (chartsResult && chartsResult.paused) {
      // We paused to refresh charts due to frozen state; do not mark as no charts
      return;
    }
    sendStatus(`ℹ️ Patient ${patientId} has no charts`);
    // Tell coordinator and get next patient
    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'patientNoCharts', threadId, patientId }, resolve);
      });
    } catch (_) {}
    await requestNextWork(clinicName);
    return;
  }

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
        } catch (_) {}
        await requestNextWork(clinicName);
        return;
      }
    }
  } catch (_) {}

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
      } catch (_) {}
      await requestNextWork(clinicName);
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
  // Wait a bit between patients (be nice to Jane's servers)
  await sleep(1500);

  try {
    chrome.runtime.sendMessage({ action: 'requestWork', threadId }, async (response) => {
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
        } catch (_) {}
        
      } else {
        sendStatus(`⚠️ Unexpected response: ${JSON.stringify(response)}`, 'error');
      }
    });
  } catch (error) {
    sendStatus(`❌ Failed to request work: ${error.message}`, 'error');
  }
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
chrome.storage.local.get(null, async (result) => {
  // Start a watchdog to ensure this thread recovers if idle too long
  try {
    const existingTimer = result && result[getStorageKey('watchdogActive')];
    if (!existingTimer) {
      await chrome.storage.local.set({ [getStorageKey('watchdogActive')]: true });
      (function startWatchdog() {
        const check = async () => {
          try {
            const nowWrap = await chrome.storage.local.get([getStorageKey('lastHeartbeat'), 'forzen']);
            const last = Number(nowWrap[getStorageKey('lastHeartbeat')] || 0);
            const frozen = !!nowWrap.forzen;
            const idleMs = Date.now() - last;
            // If no heartbeat for > 120s or page marked frozen, force navigate to current URL
            if (idleMs > 120000 || frozen) {
              const clinic = getClinicNameFromUrl();
              if (clinic) {
                const url = window.location.href;
                // Clear shouldStop to allow resumption after navigate
                shouldStop = false;
                window.location.href = url;
                return; // Stop further checks; page is navigating
              }
            }
          } catch (_) {}
          setTimeout(check, 15000);
        };
        setTimeout(check, 15000);
      })();
    }
  } catch (_) {}
  // Reset global freeze flag on page load, so it only clears after a reload
  try {
    if (result && result.forzen) {
      await chrome.storage.local.set({ forzen: false });
    }
  } catch (_) {}
  // Early global freeze detection only when we're in an active scraping lifecycle
  // i.e., we have a scoped scraping state saved for this thread
  try {
    if (result && result[getStorageKey('scrapingState')]) {
      if (document.readyState === 'loading') {
        await new Promise(r => document.addEventListener('DOMContentLoaded', r));
      }
      await sleep(200);
      await detectAndHandleRateLimit();
    }
  } catch (_) {}

  // Global cooldown removed; threads self-manage pauses
  // Get thread ID for this tab
  try {
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'getThreadAssignment' }, (resp) => {
        if (resp && resp.ok && resp.threadId) {
          threadId = resp.threadId;
          sendStatus(`[Thread] Assigned threadId: ${threadId}`);
          console.log(`[Thread] Assigned threadId: ${threadId}`);
        } else {
          sendStatus('❌ Failed to get threadId', 'error');
          console.warn('[Thread] Failed to get threadId:', resp);
        }
        resolve();
      });
    });
  } catch (e) {
    console.error('[Thread] Error getting threadId:', e);
  }

  // If we don't have a threadId but there's a saved state with one, try to restore it
  if (!threadId) {
    // Check all possible thread-scoped states (max 5 threads)
    for (let i = 1; i <= 5; i++) {
      const key = `T${i}_scrapingState`;
      if (result[key] && result[key].savedThreadId) {
        threadId = result[key].savedThreadId;
        console.log(`[Thread] Restored threadId from state: ${threadId}`);
        break;
      }
    }
  }

  // Check for explicit user stop; ignore transient stopRequested so threads auto-resume
  if (result.userRequestedStop || shouldStop) {
    chrome.storage.local.remove(['stopRequested', 'userRequestedStop', getStorageKey('scrapingState')]);
    sendStatus('⏹️ Scraping stopped', 'info');
    return;
  }

  // Resume from saved state if exists
  const scopedState = result[getStorageKey('scrapingState')];
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
  if (request.action === 'stopScraping') {
    shouldStop = true;
    cancelAllTimeouts();
    sendStatus('⏹️ Scraping stopped', 'info');

    // Clear all state
    chrome.storage.local.set({ stopRequested: true });
    chrome.storage.local.remove([getStorageKey('scrapingState'), getStorageKey('credentials')]);

    sendResponse({ success: true });
  } else if (request.action === 'initThread') {
    threadId = request.threadId;
    const loginDelayMs = request.loginDelayMs || 0;

    sendResponse({ ok: true, threadId });

    (async () => {
      const { clinicName, email, password } = request;

      if (loginDelayMs > 0) {
        sendStatus(`⏳ Waiting ${loginDelayMs / 1000}s before starting...`);
        await sleep(loginDelayMs);
      }

      sendStatus(`🚀 Starting scraping process...`);

      // Simple: always save credentials and navigate to login page
      // This ensures predictable starting point
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
        // Need to login
        sendStatus(`🔐 Logging in...`);
        await performLogin(clinicName, email, password);
      } else {
        // Already logged in - just request work
        sendStatus(`✅ Already logged in!`);
        await requestNextWork(clinicName);
      }
    })();
    return true;
  // Global pause/resume message handlers removed
  }
});

console.log('Jane Scraper loaded');
