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

// Threaded mode coordination
let threadMode = false;
let threadId = null;

function getStorageKey(key) {
  return threadMode ? `${threadId}_${key}` : key;
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
  chrome.runtime.sendMessage({
    action: 'statusUpdate',
    status: { message, type }
  });
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
    await sleep(10000); // Wait for initial page load

    // Check if already logged in
    if (window.location.href.includes('/admin#schedule')) {
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
    const signInButton = document.querySelector('button#log_in, button[type="submit"]');

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
  await sleep(500);
  const url = `https://${clinicName}.janeapp.com/admin#patients/${patientId}`;
  window.location.href = url;
  await sleep(2000);
}

async function navigateToCharts(clinicName, patientId) {
  await sleep(500);
  const url = `https://${clinicName}.janeapp.com/admin#patients/${patientId}/charts`;
  window.location.href = url;

  // Give the SPA time to swap views and render
  await sleep(1500);
  sendStatus(`⏳ Waiting for charts to render...`);
  await waitForChartsLoaded({ maxWaitMs: 45000 });

  // Now greedily load everything (be robust to capitalization)
  while (true) {
    sendStatus(`🔍 Looking for "Load More" button...`);
    const loadMoreBtn = Array.from(document.querySelectorAll('button.btn.btn-link'))
      .find(btn => (btn.textContent || '').trim().toLowerCase() === 'load more');
    if (!loadMoreBtn) break;
    loadMoreBtn.click();
    sendStatus(`🔍 Clicked "Load More" button...`);
    await sleep(2500);
  }
}

// ============================================================================
// PATIENT CHECKING FUNCTIONS
// ============================================================================

async function checkPatientExists() {
  await sleep(1500); // Wait for page to load

  // Wait for any loading spinners to disappear (max 30 seconds)
  const spinnerSelector = 'i.icon-spinner.text-muted.icon-spin';
  const startTime = Date.now();
  const maxWait = 30000;

  while (document.querySelector(spinnerSelector)) {
    if (Date.now() - startTime > maxWait) {
      return false; // Spinner never went away, patient probably doesn't exist
    }
    await sleep(500);
  }

  // Check for error messages
  const errorElement = document.querySelector('.alert-danger, .error-message');
  if (errorElement) return false;

  // Check if patient name is visible
  const nameElement = document.querySelector('.row .col-xs-10.col-sm-11 .sensitive.text-selectable');
  return !!nameElement;
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

async function downloadPdfWithCookies(pdfUrl, filename, patientName) {
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

    // Download to jane-scraper folder with patient name prefix
    const downloadId = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        action: 'downloadPDF',
        url: blobUrl,
        filename: `jane-scraper/${cleanPatient}__${filename}`,
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

    // Store the download ID for later cleanup
    currentPatientDownloadIds.push(downloadId);

    // Also save to database in case we need to resume
    try {
      await saveFileToDatabase(patientName, filename, blob, downloadId);
    } catch (e) {
      console.warn('IndexedDB save failed', e);
    }

    return true;

  } catch (error) {
    throw error;
  }
}

// ============================================================================
// ZIP CREATION FUNCTIONS
// ============================================================================

async function zipPatientFiles(patientName, patientId) {
  // Get files from database (in case of page reloads)
  let filesToZip = [];
  let downloadIdsToDelete = [];

  try {
    const persistedFiles = await getFilesFromDatabase(patientName);
    if (persistedFiles && persistedFiles.length > 0) {
      filesToZip = persistedFiles;
      downloadIdsToDelete = persistedFiles.map(f => f.downloadId).filter(id => id != null);
    }
  } catch (e) {
    console.warn('IndexedDB list failed', e);
  }

  // Fall back to in-memory files if database is empty
  if (filesToZip.length === 0 && currentPatientFiles.length > 0) {
    filesToZip = currentPatientFiles;
    downloadIdsToDelete = currentPatientDownloadIds;
  }

  // Nothing to zip
  if (filesToZip.length === 0) {
    return;
  }

  try {
    sendStatus(`📦 Creating zip file for ${patientName} (${filesToZip.length} files)...`);

    // Create a new zip file
    const zip = new JSZip();

    // Add all PDFs to the zip
    for (const file of filesToZip) {
      zip.file(file.filename, file.blob);
    }

    // Generate the zip blob
    const zipBlob = await zip.generateAsync({ type: 'blob' });

    // Download the zip file
    const blobUrl = URL.createObjectURL(zipBlob);
    const cleanPatient = patientName.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_');
    const zipFilename = `jane-scraper/${cleanPatient}__PID${patientId}.zip`;

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

    URL.revokeObjectURL(blobUrl);

    if (!downloadComplete) {
      throw new Error('Zip download timed out');
    }

    sendStatus(`✅ Zip created: ${cleanPatient}__PID${patientId}.zip (${filesToZip.length} files)`, 'success');

    // Delete the individual PDF files
    if (downloadIdsToDelete.length > 0) {
      try {
        sendStatus(`🗑️ Cleaning up ${downloadIdsToDelete.length} individual files...`);

        await sleep(1000); // Wait a bit to ensure downloads are complete

        let deletedCount = 0;
        let failedCount = 0;

        for (const downloadId of downloadIdsToDelete) {
          try {
            // Check if download is complete before deleting
            const downloadState = await new Promise((resolve) => {
              chrome.runtime.sendMessage({
                action: 'checkDownload',
                downloadId: downloadId
              }, (response) => {
                resolve(response?.state || 'unknown');
              });
            });

            if (downloadState !== 'complete') {
              console.warn(`Download ${downloadId} not complete (${downloadState}), skipping`);
              failedCount++;
              continue;
            }

            // Delete the file
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
            console.warn(`Failed to delete file ${downloadId}:`, err);
            failedCount++;
          }
        }

        if (deletedCount > 0) {
          const message = failedCount > 0
            ? `✅ Cleaned up ${deletedCount} files (${failedCount} failed)`
            : `✅ Cleaned up ${deletedCount} files`;
          sendStatus(message, 'success');
        } else if (failedCount > 0) {
          sendStatus(`⚠️ Failed to clean up ${failedCount} files`, 'error');
        }

      } catch (err) {
        console.warn('Cleanup failed', err);
        sendStatus(`⚠️ Could not clean up individual files`, 'error');
      }
    }

    // Clear everything for the next patient
    currentPatientFiles = [];
    currentPatientDownloadIds = [];

    try {
      await clearDatabaseForPatient(patientName);
    } catch (e) {
      console.warn('IndexedDB clear failed', e);
    }

  } catch (error) {
    sendStatus(`❌ Zip creation error: ${error.message}`, 'error');
    throw error;
  }
}

// ============================================================================
// CHART DOWNLOAD ORCHESTRATION
// ============================================================================

async function initiateChartDownload(clinicName, patientId, chartEntryId, headerText, patientName, remainingEntries, totalCharts) {
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
      await downloadPdfWithCookies(pdfUrl, filename, patientName);

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

        sendStatus(`✅ Completed patient ${patientId} - creating zip...`);

        await zipPatientFiles(patientName, patientId);

        if (shouldStop) {
          sendStatus('⏹️ Scraping stopped', 'info');
          return;
        }

        if (threadMode) {
          try {
            const cleanPatient = patientName.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_');
            const zipFilename = `jane-scraper/${cleanPatient}__PID${patientId}.zip`;
            chrome.runtime.sendMessage({ action: 'completeWork', threadId, patientId, patientName, zipFilename, success: true });
          } catch (_) {}

          // Save state to request new work after navigation
          await chrome.storage.local.set({
            [getStorageKey('scrapingState')]: {
              action: 'requestWork',
              clinicName
            }
          });

          await sleep(1000);
          window.location.href = `https://${clinicName}.janeapp.com/admin#schedule`;
        } else {
          // Save state to continue with next patient
          await chrome.storage.local.set({
            [getStorageKey('scrapingState')]: {
              action: 'continuePatients',
              clinicName,
              nextPatientId: patientId + 1,
              consecutiveNotFound: 0
            }
          });
          // Navigate back to continue
          await sleep(1000);
          window.location.href = `https://${clinicName}.janeapp.com/admin#schedule`;
        }
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
    chrome.storage.local.remove([getStorageKey('scrapingState')]);
    throw error;
  }
}

// ============================================================================
// MAIN SCRAPING LOOP
// ============================================================================
//
// HOW THREADING WORKS:
//
// SINGLE-THREADED MODE:
// - continueScrapingFromPatient() loops through patient IDs (1, 2, 3, ...)
// - Each patient: check exists → download charts → zip → move to next
// - Stops after MAX_CONSECUTIVE_NOT_FOUND missing patients
//
// MULTI-THREADED MODE (threadMode=true):
// - Each tab is assigned a threadId (T1, T2, etc.)
// - Tabs request work from background.js coordinator
// - Coordinator assigns next available patient ID and locks it
// - Tab processes ONE patient, then requests new work
// - No local looping - coordinator decides what to process next
//
// ============================================================================

async function handlePostLogin(state) {
  const { clinicName, startingIndex } = state;

  await chrome.storage.local.remove([getStorageKey('scrapingState')]);
  await sleep(5000); // Extra time for post-login page load

  // Verify we're logged in
  if (window.location.href.includes('/admin#schedule') || window.location.href.includes('/admin#patients')) {
    sendStatus('✅ Login successful! Starting scrape...');

    // In thread mode, request work from coordinator
    if (threadMode) {
      sendStatus(`🔄 [${threadId}] Requesting first assignment...`);
      await sleep(1000);
      await requestNextWork(clinicName);
    } else {
      // Single-threaded mode: start looping through patients
      await continueScrapingFromPatient(clinicName, startingIndex, 0);
    }
  } else {
    sendStatus('❌ Login may have failed', 'error');
  }
}

async function continuePatientScraping(state) {
  const { clinicName, nextPatientId, consecutiveNotFound } = state;

  await chrome.storage.local.remove([getStorageKey('scrapingState')]);

  await continueScrapingFromPatient(clinicName, nextPatientId, consecutiveNotFound);
}

async function continueScrapingFromPatient(clinicName, startPatientId, initialConsecutiveNotFound = 0) {
  try {
    currentPatientId = startPatientId;
    let consecutiveNotFound = initialConsecutiveNotFound;

    // THREAD MODE: Process ONE patient, then request new work
    if (threadMode) {
      await processOnePatient(clinicName, currentPatientId, consecutiveNotFound);
      return;
    }

    // SINGLE-THREADED MODE: Loop through patients
    while (!shouldStop && consecutiveNotFound < MAX_CONSECUTIVE_NOT_FOUND) {
      if (shouldStop) break;

      const result = await processOnePatient(clinicName, currentPatientId, consecutiveNotFound);

      if (result.stopped) break;
      if (result.downloaded) return; // Will continue after navigation

      consecutiveNotFound = result.consecutiveNotFound;
      currentPatientId = result.nextPatientId;

      await sleep(500);
    }

    // Finished scraping
    if (consecutiveNotFound >= MAX_CONSECUTIVE_NOT_FOUND) {
      sendStatus(`✅ Found ${MAX_CONSECUTIVE_NOT_FOUND} consecutive missing patients. Scraping complete!`, 'success');
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

// Process a single patient (used by both thread and single-threaded modes)
//
// Returns object with:
//   - stopped: true if user clicked stop or thread requested new work
//   - downloaded: true if started chart downloads (will continue after navigation)
//   - consecutiveNotFound: updated counter
//   - nextPatientId: next patient to process (single-threaded only)
//
async function processOnePatient(clinicName, patientId, consecutiveNotFound) {
  if (shouldStop) return { stopped: true, consecutiveNotFound, nextPatientId: patientId };

  sendStatus(`📋 Processing patient ${patientId}...`);

  // Navigate to patient details page
  if (shouldStop) return { stopped: true, consecutiveNotFound, nextPatientId: patientId };
  await navigateToPatient(clinicName, patientId);
  if (shouldStop) return { stopped: true, consecutiveNotFound, nextPatientId: patientId };

  // Check if patient exists
  const patientExists = await checkPatientExists();
  if (shouldStop) return { stopped: true, consecutiveNotFound, nextPatientId: patientId };

  if (!patientExists) {
    consecutiveNotFound++;
    sendStatus(`⚠️ Patient ${patientId} not found (${consecutiveNotFound}/${MAX_CONSECUTIVE_NOT_FOUND})`);

    if (threadMode) {
      // Thread mode: Tell coordinator to unlock this patient, then request new work
      try {
        await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: 'patientNotFound', threadId, patientId }, resolve);
        });
      } catch (_) {}
      await requestNextWork(clinicName);
      return { stopped: true, consecutiveNotFound, nextPatientId: patientId };
    }

    // Single-threaded: Move to next patient
    return { stopped: false, consecutiveNotFound, nextPatientId: patientId + 1 };
  }

  // Patient exists - reset counter
  consecutiveNotFound = 0;

  // Get patient name
  if (shouldStop) return { stopped: true, consecutiveNotFound, nextPatientId: patientId };
  const patientName = await getPatientName();
  if (shouldStop) return { stopped: true, consecutiveNotFound, nextPatientId: patientId };

  sendStatus(`👤 Patient ${patientId}: ${patientName}`);

  // Navigate to charts page
  if (shouldStop) return { stopped: true, consecutiveNotFound, nextPatientId: patientId };
  await navigateToCharts(clinicName, patientId);
  if (shouldStop) return { stopped: true, consecutiveNotFound, nextPatientId: patientId };

  // Check if patient has charts
  const hasCharts = await checkChartsExist();
  if (shouldStop) return { stopped: true, consecutiveNotFound, nextPatientId: patientId };

  if (!hasCharts) {
    sendStatus(`ℹ️ Patient ${patientId} has no charts, skipping`);

    if (threadMode) {
      // Thread mode: Tell coordinator to unlock this patient, then request new work
      try {
        await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: 'patientNoCharts', threadId, patientId }, resolve);
        });
      } catch (_) {}
      await requestNextWork(clinicName);
      return { stopped: true, consecutiveNotFound, nextPatientId: patientId };
    }

    // Single-threaded: Move to next patient
    return { stopped: false, consecutiveNotFound, nextPatientId: patientId + 1 };
  }

  // Get all chart entries
  if (shouldStop) return { stopped: true, consecutiveNotFound, nextPatientId: patientId };
  const chartEntries = await getChartEntries();
  if (shouldStop) return { stopped: true, consecutiveNotFound, nextPatientId: patientId };

  sendStatus(`📄 Found ${chartEntries.length} chart entries for patient ${patientId}`);

  // Start downloading charts (will navigate away and resume via state machine)
  if (chartEntries.length > 0) {
    const firstEntry = chartEntries[0];
    const remainingEntries = chartEntries.slice(1);
    const totalCharts = chartEntries.length;

    sendStatus(`⬇️ Downloading chart ${firstEntry.index + 1}/${totalCharts}: ${firstEntry.headerText}`);
    await initiateChartDownload(clinicName, patientId, firstEntry.chartEntryId, firstEntry.headerText, patientName, remainingEntries, totalCharts);
    return { stopped: false, downloaded: true, consecutiveNotFound, nextPatientId: patientId };
  }

  // No charts - shouldn't reach here since hasCharts checked above
  sendStatus(`✅ Completed patient ${patientId}`);
  return { stopped: false, consecutiveNotFound, nextPatientId: patientId + 1 };
}

// Request next work from coordinator (thread mode only)
//
// This is the key function that prevents duplicate work in multi-threaded mode.
// It asks background.js for the next available patient ID.
// Background.js maintains locks to ensure no two threads work on the same patient.
//
async function requestNextWork(clinicName) {
  if (!threadMode) return;

  sendStatus(`🔄 [${threadId}] Requesting next assignment...`);
  await sleep(1000);

  try {
    chrome.runtime.sendMessage({ action: 'requestWork', threadId }, async (resp) => {
      if (resp && resp.status === 'assigned' && resp.patientId) {
        sendStatus(`📋 [${threadId}] Assigned patient ${resp.patientId}`);
        await sleep(500);
        // Process this ONE patient (processOnePatient will call requestNextWork again when done)
        await continueScrapingFromPatient(resp.clinicName || clinicName, resp.patientId, 0);
      } else if (resp && resp.status === 'done') {
        sendStatus(`✅ [${threadId}] No more work available`, 'success');
      } else {
        sendStatus(`⚠️ [${threadId}] Unexpected response: ${JSON.stringify(resp)}`, 'error');
      }
    });
  } catch (e) {
    sendStatus(`❌ [${threadId}] Failed to request work: ${e.message}`, 'error');
  }
}

async function startScraping(clinicName, email, password, startingIndex = STARTING_INDEX) {
  try {
    // Reset stop flag
    shouldStop = false;
    cancelAllTimeouts();

    sendStatus('🚀 Starting scraping process...');

    await sleep(500);

    // Check if already logged in
    if (window.location.href.includes('/admin#schedule') || window.location.href.includes('/admin#patients')) {
      sendStatus('✅ Already logged in, starting scrape...');
      await continueScrapingFromPatient(clinicName, startingIndex, 0);
      return;
    }

    // Save state before login (login causes page reload)
    await chrome.storage.local.set({
      [getStorageKey('scrapingState')]: {
        action: 'postLogin',
        clinicName,
        email,
        password,
        startingIndex
      }
    });

    // Login
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

// Listen for page loads to resume scraping (thread-aware)
chrome.storage.local.get(null, async (result) => {
  // Figure out if this tab is a thread worker first
  try {
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'getThreadAssignment' }, (resp) => {
        if (resp && resp.ok && resp.threadId) {
          threadMode = true;
          threadId = resp.threadId;
        }
        resolve();
      });
    });
  } catch (_) {}

  // If we're a thread tab, ignore any non-thread leftover state
  const scopedState = result[getStorageKey('scrapingState')];
  const globalState = result['scrapingState'];

  if (threadMode && globalState) {
    // hard-ignore old global state to avoid rogue resumes
    await chrome.storage.local.remove(['scrapingState']);
  }

  if (result.stopRequested || shouldStop) {
    chrome.storage.local.remove(['stopRequested', getStorageKey('scrapingState'), getStorageKey('credentials')]);
    sendStatus('⏹️ Scraping stopped', 'info');
    return;
  }

  if (scopedState) {
    // only resume thread-scoped state in thread mode
    if (document.readyState === 'loading') {
      await new Promise(r => document.addEventListener('DOMContentLoaded', r));
    }
    await sleep(500);
    if (scopedState.action === 'downloadChart') return await handleChartDownload(scopedState);
    if (scopedState.action === 'continuePatients') return await continuePatientScraping(scopedState);
    if (scopedState.action === 'postLogin') return await handlePostLogin(scopedState);
    if (scopedState.action === 'requestWork') {
      // Thread mode: request next work from coordinator
      await chrome.storage.local.remove([getStorageKey('scrapingState')]);
      return await requestNextWork(scopedState.clinicName);
    }
    return;
  }

  // In thread mode on admin pages, request work
  if (threadMode && (location.href.includes('/admin#schedule') || location.href.includes('/admin#patients'))) {
    await sleep(2000);
    try {
      chrome.runtime.sendMessage({ action: 'requestWork', threadId }, async (resp) => {
        if (resp && resp.status === 'assigned' && resp.patientId) {
          await sleep(500);
          await continueScrapingFromPatient(resp.clinicName || '', resp.patientId, 0);
        }
      });
    } catch (_) {}
    return;
  }

  // Non-thread single-run path (only if credentials exist)
  if (!threadMode && result.credentials) {
    const { clinicName, email, password } = result.credentials;
    await chrome.storage.local.remove(['credentials']);
    if (document.readyState === 'loading') {
      await new Promise(r => document.addEventListener('DOMContentLoaded', r));
    }
    await sleep(500);
    await startScraping(clinicName, email, password, STARTING_INDEX);
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
    // Initialize this tab as a worker; optionally delay login to avoid simultaneous sign-ins
    threadMode = true;
    threadId = request.threadId;
    const loginDelayMs = request.loginDelayMs || 0;
    (async () => {
      const clinicName = request.clinicName;
      const email = request.email;
      const password = request.password;
      await sleep(loginDelayMs);

      // If not logged in, perform login; otherwise request work
      if (!window.location.href.includes('/admin#schedule') && !window.location.href.includes('/admin#patients')) {
        await startScraping(clinicName, email, password, STARTING_INDEX);
        return;
      }
      await sleep(2000); // Wait for page to fully load
      try {
        chrome.runtime.sendMessage({ action: 'requestWork', threadId }, async (resp) => {
          if (resp && resp.status === 'assigned' && resp.patientId) {
            await sleep(500);
            await continueScrapingFromPatient(clinicName, resp.patientId, 0);
          }
        });
      } catch (_) {}
    })();
  }
  return true;
});

console.log('Jane Scraper loaded');
