/**
 * JANE APP SCRAPER - CONTENT SCRIPT
 * 
 * This content script automates the process of logging into Jane App,
 * navigating through patient records, and downloading chart entry PDFs.
 * 
 * Main workflow:
 * 1. Login to Jane App using provided credentials
 * 2. Iterate through patient IDs starting from index 1
 * 3. For each patient, navigate to their charts page
 * 4. Download all available chart entry PDFs to the tmp directory
 * 5. Continue until 5 consecutive patients are not found
 * 
 * The script can be stopped at any time by the user via the side panel.
 */

// Configuration: Starting patient index (change for debugging/testing)
const STARTING_INDEX = 1;

// Global flag to stop the scraping process
let shouldStop = false;

// Current patient ID being processed
let currentPatientId = 1;

// Store active timeouts for cancellation
let activeTimeouts = [];

// Track downloaded files for current patient (blob + filename for zipping)
let currentPatientFiles = [];

// Track download IDs for cleanup after zipping
let currentPatientDownloadIds = [];

// IndexedDB helpers to persist files across page navigations
const IDB_DB_NAME = 'JaneScraperDB';
const IDB_STORE_NAME = 'patientFiles';
let idbPromise = null;

// Charts/Details detection helpers and thresholds
const CHARTS_PANEL_SEL = 'div.panel.panel-default.chart-entry.panel-no-gap';
const CHARTS_SPINNER_SEL = 'i.icon-spinner.text-muted.icon-spin';
const CHARTS_EMPTY_SELS = [
  'button.dropdown-toggle.btn.btn-primary',
  'button.btn.btn-primary[aria-label="Open Template Explorer Menu"]',
  '[data-test-id="empty-state"]',
  '.no-results',
  '.empty-state'
];
const CHARTS_EMPTY_TEXT_RE = /Get started with your patient|New Chart Entry|Create a new chart entry/i;
const DETAILS_SPINNER_PATIENCE_MS = 30000; // patience on details page spinner
const CHARTS_FIRST_PAINT_MS      = 30000; // initial wait for panels or empty (with spinner gone)
const CHARTS_SPINNER_PATIENCE_MS = 45000; // extra patience if charts spinner stays

function getPatientDB() {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
        db.createObjectStore(IDB_STORE_NAME, { keyPath: ['patient', 'filename'] });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return idbPromise;
}

async function savePatientFile(patient, filename, blob, downloadId) {
  const db = await getPatientDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(IDB_STORE_NAME).put({ patient, filename, blob, downloadId });
  });
}

async function listPatientFiles(patient) {
  const db = await getPatientDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_NAME, 'readonly');
    const store = tx.objectStore(IDB_STORE_NAME);
    const files = [];
    const req = store.openCursor();
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        const val = cursor.value;
        if (val.patient === patient) files.push({ filename: val.filename, blob: val.blob, downloadId: val.downloadId });
        cursor.continue();
      } else {
        resolve(files);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

async function clearPatientFiles(patient) {
  const db = await getPatientDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
    const store = tx.objectStore(IDB_STORE_NAME);
    const keysToDelete = [];
    const req = store.openCursor();
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        if (cursor.value.patient === patient) keysToDelete.push(cursor.primaryKey);
        cursor.continue();
      } else {
        if (keysToDelete.length === 0) {
          resolve();
          return;
        }
        let remaining = keysToDelete.length;
        keysToDelete.forEach((key) => {
          const del = store.delete(key);
          del.onsuccess = () => {
            remaining--;
            if (remaining === 0) resolve();
          };
          del.onerror = () => reject(del.error);
        });
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Pauses execution for a specified duration
 * Can be interrupted if shouldStop is set to true
 *
 * @param {number} ms - Number of milliseconds to sleep
 * @returns {Promise<void>} Resolves after the specified delay or rejects if stopped
 */
function sleep(ms) {
  return new Promise((resolve, reject) => {
    if (shouldStop) {
      reject(new Error('Stopped'));
      return;
    }

    const timeout = setTimeout(() => {
      activeTimeouts = activeTimeouts.filter(t => t !== timeout);
      resolve();
    }, ms);

    activeTimeouts.push(timeout);
  });
}

/**
 * Cancels all active timeouts
 */
function cancelAllTimeouts() {
  activeTimeouts.forEach(timeout => clearTimeout(timeout));
  activeTimeouts = [];
}

/**
 * Sends a status update message to the side panel
 * 
 * @param {string} message - The status message to display
 * @param {string} [type='info'] - The message type ('info', 'success', or 'error')
 * @returns {void}
 */
function sendStatus(message, type = 'info') {
  chrome.runtime.sendMessage({
    action: 'statusUpdate',
    status: { message, type }
  });
}

/**
 * Logs into Jane App by automating the login form
 * 
 * Types credentials character-by-character with random delays to simulate human behavior.
 * If already logged in, returns immediately. Will retry if email field is not found.
 * 
 * @param {string} email - The email address for the Jane App account
 * @param {string} password - The password for the Jane App account
 * @returns {Promise<boolean>} True if login successful, false otherwise
 */
async function login(email, password) {
  try {
    await sleep(10000);
    if (window.location.href.includes('/admin#schedule')) {
      sendStatus('✅ Already logged in!', 'success');
      return true;
    }

    sendStatus('⏳ Waiting for page...');
    await sleep(500);

    // Find email field
    sendStatus('🔍 Finding email field...');
    const emailInput = document.querySelector('input[name="auth_key"], input#auth_key');
    if (!emailInput) {
      sendStatus('❌ Email field not found - retrying...', 'error');
      await sleep(1000);
      return login(email, password);
    }

    // Type email
    sendStatus('⌨️ Typing email...');
    emailInput.focus();
    await sleep(100);

    for (const char of email) {
      emailInput.value += char;
      emailInput.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(30 + Math.random() * 30);
    }

    sendStatus('✓ Email entered');
    await sleep(200);

    // Find password field
    const passwordInput = document.querySelector('input[name="password"], input#password');
    if (!passwordInput) {
      sendStatus('❌ Password field not found', 'error');
      return false;
    }

    // Type password
    sendStatus('⌨️ Typing password...');
    passwordInput.focus();
    await sleep(100);

    for (const char of password) {
      passwordInput.value += char;
      passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(30 + Math.random() * 30);
    }

    sendStatus('✓ Password entered');
    await sleep(300);

    // Click Sign In button - this will cause a page reload
    sendStatus('🔘 Clicking Sign In button...');
    const signInButton = document.querySelector('button#log_in, button[type="submit"]');
    if (!signInButton) {
      sendStatus('❌ Sign In button not found', 'error');
      return false;
    }

    signInButton.click();
    // Page will reload here, so we return true immediately
    // The state listener will continue after the page reloads
    return true;

  } catch (error) {
    sendStatus('❌ Error: ' + error.message, 'error');
    return false;
  }
}

/**
 * Navigates to a specific patient's details page
 * 
 * @param {string} clinicName - The clinic subdomain name (e.g., 'myclinic')
 * @param {number} patientId - The numeric patient ID
 * @returns {Promise<void>} Resolves after navigation and 3-second wait
 */
async function navigateToPatient(clinicName, patientId) {
  const url = `https://${clinicName}.janeapp.com/admin#patients/${patientId}`;
  window.location.href = url;
  await sleep(1500);
}

/**
 * Checks if a patient exists on the current page
 * 
 * Looks for error indicators (like 404 messages) or the presence of patient name.
 * 
 * @returns {Promise<boolean>} True if patient exists, false if not found
 */
async function checkPatientExists() {
  // Wait for an initial paint
  await sleep(1500);

  // If details spinner is present and persists beyond patience window, treat as external skip
  const spinnerStart = Date.now();
  while (document.querySelector(CHARTS_SPINNER_SEL)) {
    if (Date.now() - spinnerStart > DETAILS_SPINNER_PATIENCE_MS) {
      return false; // external (no such patient / never resolved)
    }
    await sleep(500);
  }

  // Explicit error indicators
  const noPatient = document.querySelector('.alert-danger, .error-message');
  if (noPatient) return false;

  // Heuristic: presence of a patient name suggests the patient exists
  const nameDiv = document.querySelector('.row .col-xs-10.col-sm-11 .sensitive.text-selectable');
  return !!nameDiv;
}

/**
 * Extracts the patient's name from the current page
 * 
 * @returns {Promise<string>} The patient's name, or empty string if not found
 */
async function getPatientName() {
  try {
    await sleep(500);
    const nameDiv = document.querySelector('.row .col-xs-10.col-sm-11 .sensitive.text-selectable');
    return nameDiv ? nameDiv.textContent.trim() : '';
  } catch {
    return '';
  }
}

/**
 * Navigates to a patient's charts page
 * 
 * @param {string} clinicName - The clinic subdomain name
 * @param {number} patientId - The numeric patient ID
 * @returns {Promise<void>} Resolves after navigation and 3-second wait
 */
async function navigateToCharts(clinicName, patientId) {
  const url = `https://${clinicName}.janeapp.com/admin#patients/${patientId}/charts`;
  window.location.href = url;
  await sleep(1500);
}

/**
 * Checks if the current patient has any chart entries
 * 
 * @returns {Promise<boolean>} True if charts exist, false otherwise
 */
async function checkChartsExist() {
  await sleep(1000);
  const panels = document.querySelectorAll('div.panel.panel-default.chart-entry.panel-no-gap');
  return panels.length > 0;
}

/**
 * Extracts all chart entries from the current charts page
 * 
 * Parses chart entry panels to extract the date, title, chart entry ID, and index.
 * 
 * @returns {Promise<Array<Object>>} Array of chart entry objects, each containing:
 *   - {string} headerText - Combined date and title text
 *   - {string} chartEntryId - The unique chart entry ID
 *   - {number} index - The position in the list (0-based)
 */
async function getChartEntries() {
  const entries = [];
  const panels = document.querySelectorAll('div.panel.panel-default.chart-entry.panel-no-gap');

  for (let i = 0; i < panels.length; i++) {
    const panel = panels[i];

    // Get header text
    const headerContainer = panel.querySelector('div.ellipsis-after-3-lines.flex-order-sm-2.flex-item.flex-pull-left');
    let dateText = '';
    let titleText = '';

    const dateSpan = headerContainer?.querySelector('span[data-test-id="chart_entry_header_date"]');
    const titleSpan = headerContainer?.querySelector('span[data-test-id="chart_entry_header_title"]');

    if (dateSpan) dateText = dateSpan.textContent.trim();
    if (titleSpan) titleText = titleSpan.textContent.trim();

    const headerText = `${dateText} ${titleText}`.trim();

    // Get chart entry ID
    let chartEntryId = '';
    const printLink = panel.querySelector('a[href*="/admin/patients/"][href*="/chart_entries/"][target="_blank"]');
    if (printLink) {
      const href = printLink.getAttribute('href') || '';
      const match = href.match(/\/chart_entries\/(\d+)/);
      if (match) chartEntryId = match[1];
    }

    entries.push({ headerText, chartEntryId, index: i });
  }

  return entries;
}

/**
 * Initiates navigation to a chart entry page
 *
 * Saves state before navigating so we can resume after page load.
 *
 * @param {string} clinicName - The clinic subdomain name
 * @param {number} patientId - The numeric patient ID
 * @param {string} chartEntryId - The unique chart entry ID
 * @param {string} headerText - The chart entry header text
 * @param {string} patientName - The patient's name
 * @param {Array} remainingEntries - Remaining chart entries to process
 * @param {number} totalCharts - Total number of charts for this patient
 * @returns {Promise<void>} Resolves after setting up navigation
 */
async function downloadChartPDF(clinicName, patientId, chartEntryId, headerText, patientName, remainingEntries, totalCharts) {
  // Save state before navigating
  await chrome.storage.local.set({
    scrapingState: {
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

  // Navigate to chart entry page
  const url = `https://${clinicName}.janeapp.com/admin/patients/${patientId}/chart_entries/${chartEntryId}`;
  window.location.href = url;
}

/**
 * Downloads a PDF using cookies from the current session
 * Downloads to disk in patient folder
 *
 * @param {string} pdfUrl - The URL of the PDF to download
 * @param {string} filename - The filename to save as
 * @param {string} patientName - The patient name for organizing files
 * @returns {Promise<string>} The absolute file path where the file was downloaded
 */
async function downloadPdfWithCookies(pdfUrl, filename, patientName) {
  try {
    // Fetch the PDF with credentials (includes cookies)
    const response = await fetch(pdfUrl, {
      method: 'GET',
      credentials: 'include',
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

    // Store the blob for later zipping (in-memory and persistent)
    currentPatientFiles.push({ filename, blob });
    
    // Note: downloadId will be added after the download completes below

    // Also download to disk for backup
    const blobUrl = URL.createObjectURL(blob);
    const cleanPatient = patientName.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_');

    const downloadId = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        action: 'downloadPDF',
        url: blobUrl,
        filename: `jane-scraper/${cleanPatient}__${filename}`,  // Flat structure: no subfolders
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
    const maxAttempts = 60;

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

    // Store the download ID for later cleanup (in-memory and persistent)
    currentPatientDownloadIds.push(downloadId);
    try {
      await savePatientFile(patientName, filename, blob, downloadId);
    } catch (e) {
      // Non-fatal: continue even if IndexedDB write fails
      console.warn('IndexedDB save failed', e);
    }

    return true;

  } catch (error) {
    throw error;
  }
}

/**
 * Creates a zip file of all downloaded PDFs for the current patient
 *
 * @param {string} patientName - The patient's name for the zip filename
 * @returns {Promise<void>} Resolves when zip is created and downloaded
 */
async function zipPatientFiles(patientName) {
  // Load any persisted files to ensure we include files across navigations
  let filesToZip = [];
  let downloadIdsToDelete = [];
  try {
    const persisted = await listPatientFiles(patientName);
    if (persisted && persisted.length > 0) {
      filesToZip = persisted;
      downloadIdsToDelete = persisted.map(f => f.downloadId).filter(id => id != null);
    }
  } catch (e) {
    console.warn('IndexedDB list failed', e);
  }

  // Fallback to in-memory entries if IndexedDB is empty
  if (filesToZip.length === 0 && currentPatientFiles.length > 0) {
    filesToZip = currentPatientFiles;
    downloadIdsToDelete = currentPatientDownloadIds;
  }

  if (filesToZip.length === 0) {
    return;
  }

  try {
    sendStatus(`📦 Creating zip file for ${patientName} (${filesToZip.length} files)...`);

    // Create a new JSZip instance
    const zip = new JSZip();

    // Add all files to the zip
    for (const file of filesToZip) {
      zip.file(file.filename, file.blob);
    }

    // Generate the zip file
    const zipBlob = await zip.generateAsync({ type: 'blob' });

    // Create blob URL for download
    const blobUrl = URL.createObjectURL(zipBlob);

    // Clean patient name for filename
    const cleanPatient = patientName.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_');
    const zipFilename = `jane-scraper/${cleanPatient}.zip`;

    // Download the zip file
    const downloadId = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        action: 'downloadPDF',
        url: blobUrl,
        filename: zipFilename,
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

    // Wait for zip download to complete
    let downloadComplete = false;
    let attempts = 0;
    const maxAttempts = 60;

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
        throw new Error('Zip download interrupted');
      }

      if (!downloadComplete) {
        await sleep(500);
        attempts++;
      }
    }

    // Clean up blob URL
    URL.revokeObjectURL(blobUrl);

    if (!downloadComplete) {
      throw new Error('Zip download timed out');
    }

    sendStatus(`✅ Zip created: ${cleanPatient}.zip (${filesToZip.length} files)`, 'success');

    // Delete the individual PDF files from the patient folder
    if (downloadIdsToDelete.length > 0) {
      try {
        sendStatus(`🗑️ Cleaning up ${downloadIdsToDelete.length} individual files for ${patientName}...`);

        // Ensure all downloads are fully complete before deleting
        await sleep(1000);

        let deletedCount = 0;
        let failedCount = 0;

        for (const downloadId of downloadIdsToDelete) {
          try {
            // Verify download is complete first
            const downloadState = await new Promise((resolve) => {
              chrome.runtime.sendMessage({
                action: 'checkDownload',
                downloadId: downloadId
              }, (response) => {
                resolve(response?.state || 'unknown');
              });
            });

            if (downloadState !== 'complete') {
              console.warn(`Download ${downloadId} not complete (${downloadState}), skipping deletion`);
              failedCount++;
              continue;
            }

            // Now delete the file
            await new Promise((resolve, reject) => {
              chrome.runtime.sendMessage({
                action: 'deleteFile',
                downloadId: downloadId
              }, (response) => {
                if (chrome.runtime.lastError) {
                  reject(new Error(chrome.runtime.lastError.message));
                } else if (response?.error) {
                  reject(new Error(response.error));
                } else {
                  resolve();
                }
              });
            });
            deletedCount++;
            await sleep(50); // Small delay between deletes
          } catch (err) {
            console.warn(`Failed to delete file with ID ${downloadId}:`, err);
            failedCount++;
          }
        }

        if (deletedCount > 0) {
          sendStatus(`✅ Cleaned up ${deletedCount} individual files${failedCount > 0 ? ` (${failedCount} failed)` : ''}`, 'success');
        } else if (failedCount > 0) {
          sendStatus(`⚠️ Failed to clean up ${failedCount} files`, 'error');
        }
      } catch (err) {
        console.warn('Cleanup failed', err);
        sendStatus(`⚠️ Could not clean up individual files`, 'error');
      }
    }

    // Clear the files and download IDs for the next patient
    currentPatientFiles = [];
    currentPatientDownloadIds = [];
    try {
      await clearPatientFiles(patientName);
    } catch (e) {
      console.warn('IndexedDB clear failed', e);
    }

  } catch (error) {
    sendStatus(`❌ Zip creation error: ${error.message}`, 'error');
    throw error;
  }
}

/**
 * Handles the chart download after navigating to the chart entry page
 *
 * This runs after the page has loaded from the navigation in downloadChartPDF.
 *
 * @param {Object} state - The saved scraping state
 * @returns {Promise<void>} Resolves after handling the chart
 */
async function handleChartDownload(state) {
  try {
    const { clinicName, patientId, chartEntryId, headerText, patientName, remainingEntries, totalCharts, waitingForPdfPage } = state;
    const currentChartNum = totalCharts - remainingEntries.length;

    // If we just clicked the PDF button and are waiting for the PDF page to load
    if (waitingForPdfPage) {
      if (shouldStop) {
        await chrome.storage.local.remove(['scrapingState']);
        sendStatus('⏹️ Scraping stopped', 'info');
        return;
      }

      sendStatus(`🔍 Looking for PDF download link for chart ${currentChartNum}/${totalCharts}...`);
      await sleep(5000);

      if (shouldStop) {
        await chrome.storage.local.remove(['scrapingState']);
        sendStatus('⏹️ Scraping stopped', 'info');
        return;
      }

      // Look for the actual PDF link on this intermediate page
      const viewPdfButton = document.querySelector('a.btn.btn-default[href$=".pdf"]');
      if (!viewPdfButton) {
        sendStatus(`❌ PDF download link not found`, 'error');
        chrome.storage.local.remove(['scrapingState']);
        throw new Error('PDF download link not found - stopping scrape');
      }

      // Get the actual PDF URL
      const pdfHref = viewPdfButton.getAttribute('href');
      let pdfUrl;
      if (pdfHref.startsWith('http')) {
        pdfUrl = pdfHref;
      } else {
        const currentUrl = new URL(window.location.href);
        pdfUrl = `${currentUrl.protocol}//${currentUrl.host}${pdfHref}`;
      }

      if (shouldStop) {
        await chrome.storage.local.remove(['scrapingState']);
        sendStatus('⏹️ Scraping stopped', 'info');
        return;
      }

      sendStatus(`⬇️ Downloading chart ${currentChartNum}/${totalCharts}...`);

      // Create clean filename
      const cleanHeader = headerText.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_');
      const cleanPatient = patientName.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_');
      const filename = `${cleanHeader}__${chartEntryId}.pdf`;

      // Download the PDF
      await downloadPdfWithCookies(pdfUrl, filename, patientName);

      if (shouldStop) {
        await chrome.storage.local.remove(['scrapingState']);
        sendStatus('⏹️ Scraping stopped', 'info');
        return;
      }

      sendStatus(`✅ Downloaded: ${filename}`, 'success');
      await sleep(500);

      if (shouldStop) {
        await chrome.storage.local.remove(['scrapingState']);
        sendStatus('⏹️ Scraping stopped', 'info');
        return;
      }

      // Clear state
      await chrome.storage.local.remove(['scrapingState']);

      // Continue with remaining entries or move to next patient
      if (remainingEntries && remainingEntries.length > 0) {
        if (shouldStop) {
          sendStatus('⏹️ Scraping stopped', 'info');
          return;
        }

        // Process next chart entry
        const nextEntry = remainingEntries[0];
        const newRemainingEntries = remainingEntries.slice(1);

        sendStatus(`⬇️ Downloading chart ${nextEntry.index + 1}/${totalCharts}: ${nextEntry.headerText}`);
        await downloadChartPDF(clinicName, patientId, nextEntry.chartEntryId, nextEntry.headerText, patientName, newRemainingEntries, totalCharts);
      } else {
        if (shouldStop) {
          sendStatus('⏹️ Scraping stopped', 'info');
          return;
        }

        // All charts done for this patient - create zip file
        sendStatus(`✅ Completed patient ${patientId} - creating zip...`);

        // Create zip file for this patient
        await zipPatientFiles(patientName);

        if (shouldStop) {
          sendStatus('⏹️ Scraping stopped', 'info');
          return;
        }

        // Save state to continue with next patient
        await chrome.storage.local.set({
          scrapingState: {
            action: 'continuePatients',
            clinicName,
            nextPatientId: patientId + 1,
            consecutiveNotFound: 0
          }
        });

        // Navigate back to continue
        window.location.href = `https://${clinicName}.janeapp.com/admin#schedule`;
      }

      return;
    }

    // First time on chart entry page - check for error modal
    const errorModal = document.querySelector('div.modal-header h3');
    if (errorModal && errorModal.textContent.trim() === "Hmmm... That's strange.") {
      sendStatus(`⚠️ Error modal detected for entry ${chartEntryId}`, 'error');
      chrome.storage.local.remove(['scrapingState']);
      throw new Error('Error modal detected - stopping scrape');
    }

    // Find the PDF button on the chart entry page
    sendStatus(`🔍 Looking for PDF button for chart ${currentChartNum}/${totalCharts}...`);
    const pdfButton = document.querySelector('a#pdf_button[href*=".pdf"]');
    if (!pdfButton) {
      sendStatus(`❌ PDF button not found for entry ${chartEntryId}`, 'error');
      chrome.storage.local.remove(['scrapingState']);
      throw new Error('PDF button not found - stopping scrape');
    }

    // Update state to indicate we're waiting for PDF page
    await chrome.storage.local.set({
      scrapingState: {
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

    // Click the PDF button to navigate to intermediate PDF page
    sendStatus(`🖱️ Clicking PDF button for chart ${currentChartNum}/${totalCharts}...`);
    pdfButton.click();
    // The page will navigate, and we'll resume in this function with waitingForPdfPage=true

  } catch (error) {
    sendStatus(`❌ Critical error: ${error.message}`, 'error');
    chrome.storage.local.remove(['scrapingState']);
    throw error;
  }
}

/**
 * Handles post-login state after successful login
 *
 * @param {Object} state - The saved scraping state
 * @returns {Promise<void>} Resolves after starting the scrape
 */
async function handlePostLogin(state) {
  const { clinicName, startingIndex } = state;
  
  // Clear the state
  await chrome.storage.local.remove(['scrapingState']);
  await sleep(4000);
  // Verify we're logged in
  if (window.location.href.includes('/admin#schedule') || window.location.href.includes('/admin#patients')) {
    sendStatus('✅ Login successful! Starting scrape...');
    // Start the main scraping loop
    await continueScrapingFromPatient(clinicName, startingIndex, 0);
  } else {
    sendStatus('❌ Login may have failed - not on admin page', 'error');
  }
}

/**
 * Continues patient scraping after completing charts for one patient
 *
 * @param {Object} state - The saved scraping state
 * @returns {Promise<void>} Resolves after continuing the scrape
 */
async function continuePatientScraping(state) {
  const { clinicName, nextPatientId, consecutiveNotFound } = state;
  
  // Clear the state
  await chrome.storage.local.remove(['scrapingState']);
  
  // Continue the main scraping loop
  await continueScrapingFromPatient(clinicName, nextPatientId, consecutiveNotFound);
}

/**
 * Continues the scraping loop from a specific patient
 *
 * @param {string} clinicName - The clinic subdomain name
 * @param {number} startPatientId - The patient ID to start from
 * @param {number} initialConsecutiveNotFound - The current count of consecutive not found
 * @returns {Promise<void>} Resolves when scraping completes or is stopped
 */
async function continueScrapingFromPatient(clinicName, startPatientId, initialConsecutiveNotFound = 0) {
  try {
    currentPatientId = startPatientId;
    let consecutiveNotFound = initialConsecutiveNotFound;
    const maxConsecutiveNotFound = 5;

    while (!shouldStop && consecutiveNotFound < maxConsecutiveNotFound) {
      if (shouldStop) break;

      sendStatus(`📋 Processing patient ${currentPatientId}...`);

      // Navigate to patient details
      if (shouldStop) break;
      await navigateToPatient(clinicName, currentPatientId);
      if (shouldStop) break;

      // Check if patient exists
      const exists = await checkPatientExists();
      if (shouldStop) break;

      if (!exists) {
        // External skip: no such patient (404/spinner timeout)
        consecutiveNotFound++;
        sendStatus(`⚠️ External skip: patient ${currentPatientId} not found (${consecutiveNotFound}/${maxConsecutiveNotFound})`);
        currentPatientId++;
        continue;
      }

      // Reset consecutive not found counter
      consecutiveNotFound = 0;

      // Get patient name
      if (shouldStop) break;
      const patientName = await getPatientName();
      if (shouldStop) break;

      sendStatus(`👤 Patient ${currentPatientId}: ${patientName}`);

      // Navigate to charts
      if (shouldStop) break;
      await navigateToCharts(clinicName, currentPatientId);
      if (shouldStop) break;

      // Check if charts exist (internal skip detection)
      const hasCharts = await checkChartsExist();
      if (shouldStop) break;

      if (!hasCharts) {
        // Internal skip: patient exists, but no charts
        sendStatus(`ℹ️ Internal skip: patient ${currentPatientId} has no charts, continuing`);
        currentPatientId++;
        continue;
      }

      // Get chart entries
      if (shouldStop) break;
      const chartEntries = await getChartEntries();
      if (shouldStop) break;

      sendStatus(`📄 Found ${chartEntries.length} chart entries for patient ${currentPatientId}`);

      // Start downloading chart PDFs (will continue via state machine)
      if (chartEntries.length > 0) {
        const firstEntry = chartEntries[0];
        const remainingEntries = chartEntries.slice(1);
        const totalCharts = chartEntries.length;
        
        sendStatus(`⬇️ Downloading chart ${firstEntry.index + 1}/${totalCharts}: ${firstEntry.headerText}`);
        await downloadChartPDF(clinicName, currentPatientId, firstEntry.chartEntryId, firstEntry.headerText, patientName, remainingEntries, totalCharts);
        // Navigation happens here, so we return
        return;
      }

      // No charts for this patient
      sendStatus(`✅ Completed patient ${currentPatientId}`);
      currentPatientId++;

      // Small delay between patients
      await sleep(500);
    }

    if (consecutiveNotFound >= maxConsecutiveNotFound) {
      sendStatus(`✅ Reached ${maxConsecutiveNotFound} consecutive patients not found. Scraping complete!`, 'success');
    } else if (shouldStop) {
      sendStatus('⏹️ Scraping stopped by user', 'info');
    }
  } catch (error) {
    if (error.message === 'Stopped' || shouldStop) {
      sendStatus('⏹️ Scraping stopped by user', 'info');
    } else {
      sendStatus(`❌ Error: ${error.message}`, 'error');
    }
  }
}

/**
 * Main scraping loop that processes patients sequentially
 * 
 * This function coordinates the entire scraping process:
 * 1. Logs into Jane App
 * 2. Iterates through patient IDs starting from startingIndex
 * 3. For each existing patient, downloads all their chart PDFs
 * 4. Stops after 5 consecutive patients are not found
 * 5. Can be interrupted by user via the shouldStop flag
 * 
 * @param {string} clinicName - The clinic subdomain name (e.g., 'myclinic')
 * @param {string} email - Jane App login email
 * @param {string} password - Jane App login password
 * @param {number} [startingIndex=STARTING_INDEX] - The patient ID to start scraping from
 * @returns {Promise<void>} Resolves when scraping completes or is stopped
 */
async function startScraping(clinicName, email, password, startingIndex = STARTING_INDEX) {
  try {
    // Reset stop flag at the start of each scrape
    shouldStop = false;
    cancelAllTimeouts();

    sendStatus('🚀 Starting scraping process...');

    // Check if already logged in
    if (window.location.href.includes('/admin#schedule') || window.location.href.includes('/admin#patients')) {
      sendStatus('✅ Already logged in, starting scrape...');
      // Start the main scraping loop
      await continueScrapingFromPatient(clinicName, startingIndex, 0);
      return;
    }

    // Save state before attempting login (login will cause page reload)
    await chrome.storage.local.set({
      scrapingState: {
        action: 'postLogin',
        clinicName,
        email,
        password,
        startingIndex
      }
    });

    // Login first (this will cause page reload after clicking sign-in button)
    const loggedIn = await login(email, password);
    if (!loggedIn || shouldStop) {
      sendStatus('❌ Login failed, stopping', 'error');
      await chrome.storage.local.remove(['scrapingState']);
      return;
    }

    // Note: After signInButton.click(), the page reloads and execution stops here
    // The postLogin handler will continue the scraping after reload

  } catch (error) {
    // Catch any stop-related errors
    if (error.message === 'Stopped' || shouldStop) {
      sendStatus('⏹️ Scraping stopped by user', 'info');
    } else {
      sendStatus(`❌ Error: ${error.message}`, 'error');
    }
    await chrome.storage.local.remove(['scrapingState']);
  }
}

/**
 * Listens for saved credentials and scraping state to resume scraping
 * 
 * When the page loads, checks Chrome storage for:
 * 1. Credentials - starts new scraping session
 * 2. Scraping state - resumes from where we left off after navigation
 */
chrome.storage.local.get(['credentials', 'scrapingState', 'stopRequested'], async (result) => {
  // If a stop was requested previously or shouldStop is true, do nothing
  if (result.stopRequested || shouldStop) {
    // Clear the flag after acknowledging stop
    chrome.storage.local.remove(['stopRequested', 'scrapingState', 'credentials']);
    sendStatus('⏹️ Scraping stopped', 'info');
    return;
  }
  // Handle resuming from a navigation (state exists)
  if (result.scrapingState) {
    // Check stop flag one more time before processing
    if (shouldStop) {
      chrome.storage.local.remove(['stopRequested', 'scrapingState', 'credentials']);
      sendStatus('⏹️ Scraping stopped', 'info');
      return;
    }

    const state = result.scrapingState;
    
    if (document.readyState === 'loading') {
      await new Promise(resolve => {
        document.addEventListener('DOMContentLoaded', resolve);
      });
    }

    await sleep(500);
    
    // Handle different states
    if (state.action === 'downloadChart') {
      await handleChartDownload(state);
    } else if (state.action === 'continuePatients') {
      await continuePatientScraping(state);
    } else if (state.action === 'postLogin') {
      await handlePostLogin(state);
    }
    
    return;
  }

  // Handle initial scraping start (credentials exist)
  if (result.credentials) {
    const { clinicName, email, password } = result.credentials;

    // Remove credentials immediately to prevent re-triggering on page reloads
    chrome.storage.local.remove(['credentials']);

    if (document.readyState === 'loading') {
      await new Promise(resolve => {
        document.addEventListener('DOMContentLoaded', resolve);
      });
    }

    await sleep(500);
    await startScraping(clinicName, email, password, STARTING_INDEX);
  }
});

/**
 * Listens for stop command from the side panel
 *
 * When a 'stopScraping' message is received, immediately stops all operations
 * by setting the shouldStop flag and canceling all active timeouts.
 *
 * @param {Object} request - The message request object
 * @param {string} request.action - The action type ('stopScraping')
 * @param {chrome.runtime.MessageSender} sender - Information about the sender
 * @param {Function} sendResponse - Function to send response back
 * @returns {boolean} True to indicate async response
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'stopScraping') {
    shouldStop = true;
    cancelAllTimeouts();
    sendStatus('⏹️ Scraping stopped', 'info');
    // Prevent any resume on reload
    chrome.storage.local.set({ stopRequested: true });
    chrome.storage.local.remove(['scrapingState', 'credentials']);
    sendResponse({ success: true });
  }
  return true;
});
