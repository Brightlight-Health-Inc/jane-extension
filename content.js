/**
 * JANE APP SCRAPER - CONTENT SCRIPT
 *
 * This script automates downloading patient chart PDFs from Jane App.
 * It logs in, goes through each patient, downloads their charts, and zips them.
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const STARTING_INDEX = 1; // Which patient ID to start from
const MAX_CONSECUTIVE_NOT_FOUND = 5; // Stop after this many missing patients in a row

// ============================================================================
// GLOBAL STATE
// ============================================================================

let shouldStop = false; // Set to true when user clicks stop
let currentPatientId = 1; // The patient we're currently processing
let activeTimeouts = []; // Track timeouts so we can cancel them on stop

// Thread coordination (all runs use threading now, even single thread)
let threadId = null;

function getStorageKey(key) {
  return threadId ? `${threadId}_${key}` : key;
}

// Files for current patient (stored in memory for zipping)
let currentPatientFiles = []; // Array of { filename, blob }
let currentPatientDownloadIds = []; // Array of download IDs for cleanup

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
// UTILITY FUNCTIONS
// ============================================================================

function sleep(milliseconds) {
  return new Promise((resolve, reject) => {
    if (shouldStop) {
      reject(new Error('Stopped'));
      return;
    }

    const timeout = setTimeout(() => {
      activeTimeouts = activeTimeouts.filter(t => t !== timeout);
      resolve();
    }, milliseconds);

    activeTimeouts.push(timeout);
  });
}

function cancelAllTimeouts() {
  activeTimeouts.forEach(timeout => clearTimeout(timeout));
  activeTimeouts = [];
}

function sendStatus(message, type = 'info') {
  // Automatically prefix with thread ID if available
  const prefix = threadId ? `[${threadId}] ` : '';
  const fullMessage = prefix + message;
  chrome.runtime.sendMessage({
    action: 'statusUpdate',
    status: { message: fullMessage, type, threadId }
  });
}

// Detect Jane rate-limit / slowdown page and trigger coordinated recovery
async function detectAndHandleRateLimit() {
  try {
    // Texts observed on slowdown page (require BOTH to avoid false positives)
    const bodyText = (document.body?.innerText || '').toLowerCase();
    const sawWhoa = bodyText.includes('whoa there friend');
    const sawMoment = bodyText.includes('please take a moment');
    if (!(sawWhoa && sawMoment)) return false;

    // Signal background to pause everyone and coordinate recovery
    const clinicName = getClinicNameFromUrl();
    sendStatus('⚠️ Rate limit page detected. Pausing all threads and recovering...', 'error');

    // Capture current resume state for this thread if available
    let resumeState = null;
    try {
      const scoped = await chrome.storage.local.get(getStorageKey('scrapingState'));
      resumeState = scoped[getStorageKey('scrapingState')] || null;
    } catch (_) {}

    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'globalCooldownAndRecover', clinicName, threadId, resumeState }, () => resolve());
    });

    return true;
  } catch (_) {
    return false;
  }
}

function getClinicNameFromUrl() {
  try {
    const host = window.location.hostname || '';
    const match = host.match(/^([^\.]+)\.janeapp\.com$/);
    return match ? match[1] : '';
  } catch (_) {
    return '';
  }
}

async function scheduleRecovery(clinicName, resumeState) {
  if (!clinicName) clinicName = getClinicNameFromUrl();
  if (!clinicName) return;
  if (shouldStop) return;

  sendStatus(`🔁 Recovering from error, returning to schedule...`);
  await chrome.storage.local.set({
    [getStorageKey('scrapingState')]: {
      action: 'recover',
      clinicName,
      resumeState,
      phase: 'toSchedule'
    }
  });
  await sleep(250);
  window.location.href = `https://${clinicName}.janeapp.com/`;
}

async function waitForChartsLoaded({ maxWaitMs = 45000 } = {}) {
  const start = Date.now();
  // Known selectors on the charts tab
  const panelSel = 'div.panel.panel-default.chart-entry.panel-no-gap';
  const spinnerSel = 'i.icon-spinner.text-muted.icon-spin';
  const containerSel = '#charts, [data-test-id="charts_container"]';

  // First wait until the charts container shows up or spinner disappears
  while (Date.now() - start < maxWaitMs) {
    if (shouldStop) throw new Error('Stopped');

    const hasPanels = document.querySelectorAll(panelSel).length > 0;
    const hasContainer = document.querySelector(containerSel);
    const hasSpinner = document.querySelector(spinnerSel);

    // Success when either we see panels OR we see a container and no spinner
    if (hasPanels || (hasContainer && !hasSpinner)) return true;

    await sleep(500);
  }
  return false; // timed out
}

// ============================================================================
// LOGIN FUNCTIONS
// ============================================================================

async function login(email, password) {
  try {
    // Wait for initial page load or DOM readiness
    if (document.readyState === 'loading') {
      await new Promise(r => document.addEventListener('DOMContentLoaded', r));
    }
    await sleep(500);

    // Check if already logged in (admin shell present, not showing login form)
    const alreadyLoggedIn = window.location.href.includes('/admin') && !document.querySelector('input[name="auth_key"], input#auth_key');
    if (alreadyLoggedIn) {
      sendStatus('✅ Already logged in!', 'success');
      return true;
    }

    sendStatus('⏳ Waiting for login page...');
    await sleep(500);

    // Find and fill email field
    sendStatus('🔍 Finding email field...');
    const emailInput = document.querySelector('input[name="auth_key"], input#auth_key');

    if (!emailInput) {
      sendStatus('❌ Email field not found - retrying...', 'error');
      await sleep(1000);
      return login(email, password); // Try again
    }

    // Type email
    sendStatus('⌨️ Typing email...');
    emailInput.focus();
    await sleep(100);

    for (const character of email) {
      emailInput.value += character;
      emailInput.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(30 + Math.random() * 30); // Random delay to look human
    }

    sendStatus('✓ Email entered');
    await sleep(200);

    // Find and fill password field
    const passwordInput = document.querySelector('input[name="password"], input#password');

    if (!passwordInput) {
      sendStatus('❌ Password field not found', 'error');
      return false;
    }

    sendStatus('⌨️ Typing password...');
    passwordInput.focus();
    await sleep(100);

    for (const character of password) {
      passwordInput.value += character;
      passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(30 + Math.random() * 30);
    }

    sendStatus('✓ Password entered');
    await sleep(300);

    // Click sign in button
    sendStatus('🔘 Clicking Sign In button...');
    const signInButton = document.querySelector('button#log_in, form button[type="submit"], button:has([data-test="sign-in"])');

    if (!signInButton) {
      sendStatus('❌ Sign In button not found', 'error');
      return false;
    }

    signInButton.click();
    // Page will reload after this, so we just return true
    return true;

  } catch (error) {
    sendStatus('❌ Error: ' + error.message, 'error');
    return false;
  }
}

// ============================================================================
// NAVIGATION FUNCTIONS
// ============================================================================

async function navigateToPatient(clinicName, patientId) {
  sendStatus(`🔄 Navigating to patient ${patientId}...`);
  await sleep(500);
  const url = `https://${clinicName}.janeapp.com/admin#patients/${patientId}`;
  window.location.href = url;
  await sleep(2000);
  sendStatus(`✓ Arrived at patient ${patientId} page`);
}

async function navigateToCharts(clinicName, patientId) {
  sendStatus(`🔄 Navigating to charts page for patient ${patientId}...`);
  await sleep(500);
  const url = `https://${clinicName}.janeapp.com/admin#patients/${patientId}/charts`;
  window.location.href = url;

  // Give the SPA time to swap views and render
  await sleep(1500);
  sendStatus(`⏳ Waiting for charts to render...`);
  const chartsLoaded = await waitForChartsLoaded({ maxWaitMs: 25000 });
  if (chartsLoaded) {
    sendStatus(`✓ Charts page loaded successfully`);
  } else {
    sendStatus(`⚠️ Charts page load timeout`, 'error');
  }

  // Now greedily load everything (be robust to capitalization)
  let loadMoreCount = 0;
  while (true) {
    sendStatus(`🔍 Looking for "Load More" button...`);
    const loadMoreBtn = Array.from(document.querySelectorAll('button.btn.btn-link'))
      .find(btn => (btn.textContent || '').trim().toLowerCase() === 'load more');
    if (!loadMoreBtn) {
      sendStatus(`✓ All charts loaded (clicked ${loadMoreCount} "Load More" button${loadMoreCount !== 1 ? 's' : ''})`);
      break;
    }
    loadMoreBtn.click();
    loadMoreCount++;
    sendStatus(`🔍 Clicked "Load More" button #${loadMoreCount}`);
    await sleep(3000);
  }
}

// ============================================================================
// PATIENT CHECKING FUNCTIONS
// ============================================================================

async function checkPatientExists() {
  sendStatus(`🔍 Checking if patient exists...`);
  await sleep(1500); // Wait for page to load

  // Wait for any loading spinners to disappear (max 30 seconds)
  const spinnerSelector = 'i.icon-spinner.text-muted.icon-spin';
  const startTime = Date.now();
  const maxWait = 10000;

  while (document.querySelector(spinnerSelector)) {
    if (Date.now() - startTime > maxWait) {
      sendStatus(`⚠️ Patient check timed out (spinner still visible)`, 'warning');
      return false; // Spinner never went away, patient probably doesn't exist
    }
    await sleep(500);
  }

  // Check for error messages
  const errorElement = document.querySelector('.alert-danger, .error-message');
  if (errorElement) {
    sendStatus(`⚠️ Patient not found (error message detected)`, 'error');
    return false;
  }

  // Check if patient name is visible
  const nameElement = document.querySelector('.row .col-xs-10.col-sm-11 .sensitive.text-selectable');
  const exists = !!nameElement;
  if (exists) {
    sendStatus(`✓ Patient found`);
  } else {
    sendStatus(`⚠️ Patient not found (no name element)`, 'error');
  }
  return exists;
}

async function getPatientName() {
  try {
    await sleep(500);
    const nameElement = document.querySelector('.row .col-xs-10.col-sm-11 .sensitive.text-selectable');
    return nameElement ? nameElement.textContent.trim() : '';
  } catch {
    return '';
  }
}

async function checkChartsExist() {
  const ok = await waitForChartsLoaded({ maxWaitMs: 45000 });
  if (!ok) return false;
  return document.querySelectorAll('div.panel.panel-default.chart-entry.panel-no-gap').length > 0;
}

// ============================================================================
// CHART EXTRACTION FUNCTIONS
// ============================================================================

async function getChartEntries() {
  const entries = [];
  const panels = document.querySelectorAll('div.panel.panel-default.chart-entry.panel-no-gap');

  for (let i = 0; i < panels.length; i++) {
    const panel = panels[i];

    // Get the date and title from the header
    const headerContainer = panel.querySelector('div.ellipsis-after-3-lines.flex-order-sm-2.flex-item.flex-pull-left');
    let dateText = '';
    let titleText = '';

    const dateSpan = headerContainer?.querySelector('span[data-test-id="chart_entry_header_date"]');
    const titleSpan = headerContainer?.querySelector('span[data-test-id="chart_entry_header_title"]');

    if (dateSpan) dateText = dateSpan.textContent.trim();
    if (titleSpan) titleText = titleSpan.textContent.trim();

    const headerText = `${dateText} ${titleText}`.trim();

    // Get the chart entry ID from the print link
    let chartEntryId = '';
    const printLink = panel.querySelector('a[href*="/admin/patients/"][href*="/chart_entries/"][target="_blank"]');

    if (printLink) {
      const href = printLink.getAttribute('href') || '';
      const match = href.match(/\/chart_entries\/(\d+)/);
      if (match) chartEntryId = match[1];
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

async function downloadPdfWithCookies(pdfUrl, filename, patientName, patientId) {
  try {
    // Fetch the PDF from the server
    sendStatus(`⬇️ Fetching PDF...`);

    const response = await fetch(pdfUrl, {
      method: 'GET',
      credentials: 'include', // Include cookies for authentication
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': window.location.href,
        'User-Agent': navigator.userAgent
      }
    });

    if (!response.ok) {
      sendStatus(`❌ PDF fetch failed: ${response.status}`, 'error');
      throw new Error(`PDF fetch failed: ${response.status}`);
    }

    // Get the PDF as a blob
    const blob = await response.blob();

    if (blob.size === 0) {
      sendStatus(`❌ Downloaded PDF is empty`, 'error');
      throw new Error('Downloaded PDF is empty');
    }

    // Store the blob in memory for later zipping
    currentPatientFiles.push({ filename, blob });

    // Download the PDF to disk
    sendStatus(`💾 Saving PDF to disk...`);

    const blobUrl = URL.createObjectURL(blob);
    const cleanPatient = patientName.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_');
    const patientFolder = `jane-scraper/${patientId}_${cleanPatient}`;

    // Download directly into per-patient folder
    const downloadId = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        action: 'downloadPDF',
        url: blobUrl,
        filename: `${patientFolder}/${filename}`,
        saveAs: false
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

    // Wait for download to complete
    let downloadComplete = false;
    let attempts = 0;
    const maxAttempts = 60; // 30 seconds max

    while (!downloadComplete && attempts < maxAttempts) {
      if (shouldStop) {
        URL.revokeObjectURL(blobUrl);
        throw new Error('Stopped');
      }

      const result = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'checkDownload',
          downloadId: downloadId
        }, (response) => {
          resolve(response.state);
        });
      });

      if (result === 'complete') {
        downloadComplete = true;
      } else if (result === 'interrupted') {
        URL.revokeObjectURL(blobUrl);
        throw new Error('Download interrupted');
      }

      if (!downloadComplete) {
        await sleep(500);
        attempts++;
      }
    }

    URL.revokeObjectURL(blobUrl);

    if (shouldStop) {
      throw new Error('Stopped');
    }

    if (!downloadComplete) {
      throw new Error('Download timed out');
    }

    // Track for potential future needs (no cleanup now that we skip zipping)
    currentPatientDownloadIds.push(downloadId);
    try { await saveFileToDatabase(patientName, filename, blob, downloadId); } catch (e) { console.warn('IndexedDB save failed', e); }

    return true;

  } catch (error) {
    // Attempt recovery for PDF failures by scheduling a resume
    try {
      const clinicName = getClinicNameFromUrl();
      await scheduleRecovery(clinicName, await chrome.storage.local.get(getStorageKey('scrapingState')).then(r => r[getStorageKey('scrapingState')]));
      // Note: scheduleRecovery will navigate; stop current flow
      return false;
    } catch (_) {
      throw error;
    }
  }
}

// ============================================================================
// ZIP CREATION FUNCTIONS
// ============================================================================

// Removed zipping; kept function name block for minimal diff but make it a no-op
async function zipPatientFiles(patientName, patientId) {
  // No-op: direct-to-folder saving eliminates need for zipping or cleanup
  try {
    // Reset buffers for next patient to avoid memory growth
    currentPatientFiles = [];
    currentPatientDownloadIds = [];
    try { await clearDatabaseForPatient(patientName); } catch (e) { console.warn('IndexedDB clear failed', e); }
  } catch (_) {}
}

// ============================================================================
// CHART DOWNLOAD ORCHESTRATION
// ============================================================================

async function initiateChartDownload(clinicName, patientId, chartEntryId, headerText, patientName, remainingEntries, totalCharts) {
  const currentChartNum = totalCharts - remainingEntries.length;
  sendStatus(`🔄 [Chart ${currentChartNum}/${totalCharts}] Navigating to chart entry ${chartEntryId}...`);
  
  // Save state before navigating to chart entry page
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

  // Navigate to the chart entry page
  const url = `https://${clinicName}.janeapp.com/admin/patients/${patientId}/chart_entries/${chartEntryId}`;
  window.location.href = url;
}

async function handleChartDownload(state) {
  try {
    const { clinicName, patientId, chartEntryId, headerText, patientName, remainingEntries, totalCharts, waitingForPdfPage } = state;
    const currentChartNum = totalCharts - remainingEntries.length;

    // Check if we're on the PDF preview page (after clicking PDF button)
    if (waitingForPdfPage) {
      if (shouldStop) {
        await chrome.storage.local.remove([getStorageKey('scrapingState')]);
        sendStatus('⏹️ Scraping stopped', 'info');
        return;
      }

      sendStatus(`🔍 Looking for PDF download link (chart ${currentChartNum}/${totalCharts})...`);

      // Wait for up to 30s for the PDF button to appear (poll every 1s)
      let waitMs = 0;
      const maxWait = 30000;
      let pdfDownloadButton = null;
      while (waitMs < maxWait) {
        if (shouldStop) {
          await chrome.storage.local.remove([getStorageKey('scrapingState')]);
          sendStatus('⏹️ Scraping stopped', 'info');
          return;
        }

        pdfDownloadButton = document.querySelector('a.btn.btn-default[href$=".pdf"]');
        if (pdfDownloadButton) break;

        await sleep(1000);
        waitMs += 1000;
      }

      if (!pdfDownloadButton) {
        sendStatus(`❌ PDF download link not found`, 'error');
        chrome.storage.local.remove([getStorageKey('scrapingState')]);
        throw new Error('PDF download link not found');
      }

      // Get the PDF URL
      const pdfHref = pdfDownloadButton.getAttribute('href');
      let pdfUrl;

      if (pdfHref.startsWith('http')) {
        pdfUrl = pdfHref;
      } else {
        const currentUrl = new URL(window.location.href);
        pdfUrl = `${currentUrl.protocol}//${currentUrl.host}${pdfHref}`;
      }

      if (shouldStop) {
        await chrome.storage.local.remove([getStorageKey('scrapingState')]);
        sendStatus('⏹️ Scraping stopped', 'info');
        return;
      }

      sendStatus(`⬇️ Downloading chart ${currentChartNum}/${totalCharts}...`);

      // Create filename
      const cleanHeader = headerText.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_');
      const filename = `${cleanHeader}__${chartEntryId}.pdf`;

      // Download the PDF
      await downloadPdfWithCookies(pdfUrl, filename, patientName, patientId);

      if (shouldStop) {
        await chrome.storage.local.remove([getStorageKey('scrapingState')]);
        sendStatus('⏹️ Scraping stopped', 'info');
        return;
      }

      sendStatus(`✅ Downloaded: ${filename}`, 'success');
      await sleep(500);

      if (shouldStop) {
        await chrome.storage.local.remove([getStorageKey('scrapingState')]);
        sendStatus('⏹️ Scraping stopped', 'info');
        return;
      }

      // Clear state
      await chrome.storage.local.remove([getStorageKey('scrapingState')]);

      // Continue with remaining charts or finish patient
      if (remainingEntries && remainingEntries.length > 0) {
        if (shouldStop) {
          sendStatus('⏹️ Scraping stopped', 'info');
          return;
        }

        // Download next chart
        const nextEntry = remainingEntries[0];
        const newRemainingEntries = remainingEntries.slice(1);

        sendStatus(`⬇️ Downloading chart ${nextEntry.index + 1}/${totalCharts}: ${nextEntry.headerText}`);
        await initiateChartDownload(clinicName, patientId, nextEntry.chartEntryId, nextEntry.headerText, patientName, newRemainingEntries, totalCharts);

      } else {
        // All charts downloaded - create zip
        if (shouldStop) {
          sendStatus('⏹️ Scraping stopped', 'info');
          return;
        }

        sendStatus(`✅ Completed patient ${patientId} - files saved to folder`, 'success');

        if (shouldStop) {
          sendStatus('⏹️ Scraping stopped', 'info');
          return;
        }

        // Mark work complete and request next patient
        sendStatus(`✅ Completed patient ${patientId}`);

        try {
          const cleanPatient = patientName.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_');
          const zipFilename = `jane-scraper/${patientId}_${cleanPatient}.zip`;
          chrome.runtime.sendMessage({ action: 'completeWork', threadId, patientId, patientName, zipFilename, success: true });
        } catch (_) {}

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

    // We're on the chart entry page - need to click the PDF button

    // Check for error modal
    const errorModal = document.querySelector('div.modal-header h3');
    if (errorModal && errorModal.textContent.trim() === "Hmmm... That's strange.") {
      sendStatus(`⚠️ Error modal detected for chart ${chartEntryId}`, 'error');
      chrome.storage.local.remove([getStorageKey('scrapingState')]);
      throw new Error('Error modal detected');
    }


    await sleep(1_000);

    // Find the PDF button
    sendStatus(`🔍 Looking for PDF button (chart ${currentChartNum}/${totalCharts})...`);
    const pdfButton = document.querySelector('a#pdf_button[href*=".pdf"]');

    if (!pdfButton) {
      sendStatus(`❌ PDF button not found for chart ${chartEntryId}`, 'error');
      chrome.storage.local.remove([getStorageKey('scrapingState')]);
      throw new Error('PDF button not found');
    }

    // Update state to indicate we're waiting for PDF page
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
        waitingForPdfPage: true
      }
    });

    // Click the PDF button
    sendStatus(`🖱️ Clicking PDF button (chart ${currentChartNum}/${totalCharts})...`);
    pdfButton.click();

  } catch (error) {
    sendStatus(`❌ Error: ${error.message}`, 'error');
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
      // As a last resort, clear state
      await chrome.storage.local.remove([getStorageKey('scrapingState')]);
      throw error;
    }
  }
}

// ============================================================================
// MAIN SCRAPING LOOP
// ============================================================================
//
// HOW THREADING WORKS:
//
// ALL runs use the threading system now (even single thread).
// - Each tab is assigned a threadId (T1, T2, etc.)
// - Tabs request work from background.js coordinator
// - Coordinator assigns next available patient ID and locks it
// - Tab processes ONE patient, then requests new work
// - No local looping - coordinator decides what to process next
//
// Single thread (numThreads=1) = one tab requesting work
// Multiple threads (numThreads=2) = two tabs requesting work simultaneously
//
// ============================================================================

async function handlePostLogin(state) {
  const { clinicName } = state;

  await chrome.storage.local.remove([getStorageKey('scrapingState')]);
  await sleep(3000);

  // Consider login successful if we're on any admin page with the app shell loaded
  const adminLoaded = window.location.href.includes('/admin');
  const hasAppShell = !!document.querySelector('#ember-basic-dropdown-wormhole, header, nav');
  if (adminLoaded && hasAppShell) {
    sendStatus(`✅ Login successful`, 'success');
    await requestNextWork(clinicName);
  } else {
    sendStatus(`❌ Login failed`, 'error');
  }
}

async function continueScrapingFromPatient(clinicName, patientId) {
  try {
    currentPatientId = patientId;

    // Process ONE patient, then request new work from coordinator
    await processOnePatient(clinicName, patientId);

  } catch (error) {
    if (error.message === 'Stopped' || shouldStop) {
      sendStatus('⏹️ Scraping stopped by user', 'info');
    } else {
      sendStatus(`❌ Error: ${error.message}`, 'error');
    }
  }
}

// Process a single patient
async function processOnePatient(clinicName, patientId) {
  if (shouldStop) return;

  sendStatus(`📋 Processing patient ${patientId}...`);

  // Navigate to patient details page
  if (shouldStop) return;
  await navigateToPatient(clinicName, patientId);
  if (shouldStop) return;

  // Check if patient exists
  const patientExists = await checkPatientExists();
  if (shouldStop) return;

  if (!patientExists) {
    sendStatus(`⚠️ Patient ${patientId} not found`);

    // Tell coordinator to unlock this patient, then request new work
    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'patientNotFound', threadId, patientId }, resolve);
      });
    } catch (_) {}
    await requestNextWork(clinicName);
    return;
  }

  // Get patient name
  if (shouldStop) return;
  const patientName = await getPatientName();
  if (shouldStop) return;

  sendStatus(`👤 Patient ${patientId}: ${patientName}`);

  // Navigate to charts page
  if (shouldStop) return;
  await navigateToCharts(clinicName, patientId);
  if (shouldStop) return;

  // Check if patient has charts
  const hasCharts = await checkChartsExist();
  if (shouldStop) return;

  if (!hasCharts) {
    sendStatus(`ℹ️ Patient ${patientId} has no charts, skipping`);

    // Tell coordinator to unlock this patient, then request new work
    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'patientNoCharts', threadId, patientId }, resolve);
      });
    } catch (_) {}
    await requestNextWork(clinicName);
    return;
  }

  // Get all chart entries
  if (shouldStop) return;
  const chartEntries = await getChartEntries();
  if (shouldStop) return;

  sendStatus(`📄 Found ${chartEntries.length} chart entries for patient ${patientId}`);

  // Start downloading charts (will navigate away and resume via state machine)
  if (chartEntries.length > 0) {
    const firstEntry = chartEntries[0];
    const remainingEntries = chartEntries.slice(1);
    const totalCharts = chartEntries.length;

    sendStatus(`⬇️ Downloading chart ${firstEntry.index + 1}/${totalCharts}: ${firstEntry.headerText}`);
    await initiateChartDownload(clinicName, patientId, firstEntry.chartEntryId, firstEntry.headerText, patientName, remainingEntries, totalCharts);
    return;
  }

  // No charts - shouldn't reach here since hasCharts checked above
  sendStatus(`✅ Completed patient ${patientId}`);
}

// Request next work from coordinator
//
// This is the key function that prevents duplicate work.
// It asks background.js for the next available patient ID.
// Background.js maintains locks to ensure no two threads work on the same patient.
//
async function requestNextWork(clinicName) {
  await sleep(1000);

  try {
    chrome.runtime.sendMessage({ action: 'requestWork', threadId }, async (resp) => {
      if (resp && resp.status === 'assigned' && resp.patientId) {
        sendStatus(`📋 Assigned patient ${resp.patientId}`, 'success');
        await sleep(500);
        await continueScrapingFromPatient(resp.clinicName || clinicName, resp.patientId);
      } else if (resp && resp.status === 'done') {
        sendStatus(`✅ No more work available`, 'success');
      } else {
        sendStatus(`⚠️ Unexpected response: ${JSON.stringify(resp)}`, 'error');
      }
    });
  } catch (e) {
    sendStatus(`❌ Failed to request work: ${e.message}`, 'error');
  }
}

async function startScraping(clinicName, email, password) {
  try {
    // Reset stop flag
    shouldStop = false;
    cancelAllTimeouts();

    sendStatus('🚀 Starting scraping process...');

    // Save state before login (login causes page reload)
    await chrome.storage.local.set({
      [getStorageKey('scrapingState')]: {
        action: 'postLogin',
        clinicName,
        email,
        password
      }
    });

    // Login (this will cause page reload)
    const loggedIn = await login(email, password);

    if (!loggedIn || shouldStop) {
      sendStatus('❌ Login failed', 'error');
      await chrome.storage.local.remove([getStorageKey('scrapingState')]);
      return;
    }

    // After login, page will reload and postLogin handler will continue

  } catch (error) {
    if (error.message === 'Stopped' || shouldStop) {
      sendStatus('⏹️ Scraping stopped by user', 'info');
    } else {
      sendStatus(`❌ Error: ${error.message}`, 'error');
    }
    await chrome.storage.local.remove([getStorageKey('scrapingState')]);
  }
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================

// Listen for page loads to resume scraping
chrome.storage.local.get(null, async (result) => {
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
  // Get thread ID for this tab
  try {
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'getThreadAssignment' }, (resp) => {
        if (resp && resp.ok && resp.threadId) {
          threadId = resp.threadId;
        }
        resolve();
      });
    });
  } catch (_) {}

  // Check for stop request
  if (result.stopRequested || shouldStop) {
    chrome.storage.local.remove(['stopRequested', getStorageKey('scrapingState')]);
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
    return await requestNextWork(scopedState.clinicName);
  }

  if (scopedState.action === 'recover') {
    const { clinicName, resumeState, phase } = scopedState;
    const patientId = resumeState?.patientId || currentPatientId;

    if (!patientId) {
      sendStatus(`❌ Recovery failed`, 'error');
      await chrome.storage.local.remove([getStorageKey('scrapingState')]);
      return;
    }

    if (phase === 'toSchedule') {
      await chrome.storage.local.set({
        [getStorageKey('scrapingState')]: { action: 'recover', clinicName, resumeState, phase: 'toCharts' }
      });
      await navigateToPatient(clinicName, patientId);
      await sleep(500);
      await navigateToCharts(clinicName, patientId);
      return;
    }

    if (phase === 'toCharts') {
      await chrome.storage.local.remove([getStorageKey('scrapingState')]);
      // Prefer any best-effort recover hint if present
      try {
        const hint = await chrome.storage.local.get(threadId + '_recoverHint');
        if (hint && hint[threadId + '_recoverHint']) {
          await chrome.storage.local.remove(threadId + '_recoverHint');
          if (hint[threadId + '_recoverHint'].action === 'downloadChart') {
            return await handleChartDownload(hint[threadId + '_recoverHint']);
          }
        }
      } catch (_) {}

      if (resumeState?.action === 'downloadChart') {
        return await handleChartDownload(resumeState);
      }
      return await continueScrapingFromPatient(clinicName, patientId);
    }
  }
});

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
        await sleep(loginDelayMs);
      }

      sendStatus(`🚀 Starting...`);

      // Ensure DOM is ready before deciding login state
      if (document.readyState === 'loading') {
        await new Promise(r => document.addEventListener('DOMContentLoaded', r));
      }
      await sleep(500);

      const loginFormPresent = !!document.querySelector('input[name="auth_key"], input#auth_key');
      const onAdminHash = window.location.href.includes('/admin#');

      // If login form is visible OR we are not on an authenticated admin hash, perform login
      if (loginFormPresent || !onAdminHash) {
        await startScraping(clinicName, email, password);
      } else {
        // Logged in: request work
        await sleep(1000);
        await requestNextWork(clinicName);
      }
    })();
    return true;
  } else if (request.action === 'clearStopAndResume') {
    // Clear stop flag and resume best-effort from recover hint or request work
    shouldStop = false;
    cancelAllTimeouts();
    try { chrome.storage.local.remove(['stopRequested']); } catch (_) {}

    sendResponse({ ok: true });

    (async () => {
      try {
        const clinicName = request.clinicName || getClinicNameFromUrl();
        const hintKey = threadId ? (threadId + '_recoverHint') : null;
        let hint = null;
        if (hintKey) {
          try {
            const obj = await chrome.storage.local.get(hintKey);
            hint = obj && obj[hintKey] ? obj[hintKey] : null;
          } catch (_) {}
        }

        if (hint && hint.action === 'downloadChart' && hint.patientId) {
          // Navigate to patient and charts, then continue the download flow
          await navigateToPatient(clinicName, hint.patientId);
          await sleep(500);
          await navigateToCharts(clinicName, hint.patientId);

          // Proceed with the original download state
          await handleChartDownload(hint);
          return;
        }

        // Fallback: request next work
        await requestNextWork(clinicName);
      } catch (e) {
        sendStatus('❌ Resume failed: ' + (e?.message || String(e)), 'error');
      }
    })();
    return true;
  }
});

console.log('Jane Scraper loaded');
