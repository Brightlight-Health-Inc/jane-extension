/**
 * BACKGROUND SERVICE WORKER
 * 
 * This is the main background script for the Jane Scraper extension.
 * It handles extension lifecycle events, manages the side panel, and 
 * coordinates PDF downloads from the Jane App platform.
 * 
 * Key responsibilities:
 * - Opens the side panel when the extension icon is clicked
 * - Handles PDF download requests from content scripts
 * - Checks download status for in-progress downloads
 */

/**
 * Handles extension installation event
 * Logs a confirmation message when the extension is first installed or updated
 */
chrome.runtime.onInstalled.addListener(() => {
  console.log('Jane Scraper installed');
});

/**
 * Opens the side panel when the extension icon is clicked
 * 
 * @param {chrome.tabs.Tab} tab - The currently active tab where the icon was clicked
 * @returns {Promise<void>} Resolves when the side panel is opened
 */
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

/**
 * Handles messages from other parts of the extension (content scripts, side panel)
 * 
 * Supported actions:
 * - 'downloadPDF': Downloads a PDF file to the tmp directory
 * - 'checkDownload': Checks the status of a download by ID
 * 
 * @param {Object} request - The message request object
 * @param {string} request.action - The action to perform ('downloadPDF' or 'checkDownload')
 * @param {string} [request.url] - The blob URL to download (for downloadPDF action)
 * @param {string} [request.filename] - The filename to save as (for downloadPDF action)
 * @param {number} [request.downloadId] - The download ID to check (for checkDownload action)
 * @param {chrome.runtime.MessageSender} sender - Information about the message sender
 * @param {Function} sendResponse - Function to call with the response
 * @returns {boolean} True to indicate the response will be sent asynchronously
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Message:', request.action);

  if (request.action === 'downloadPDF') {
    // Download PDF to specific directory
    chrome.downloads.download({
      url: request.url,
      filename: request.filename,
      saveAs: false,
      conflictAction: 'overwrite'
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ downloadId: downloadId });
      }
    });
    return true; // Keep channel open for async response
  }

  if (request.action === 'checkDownload') {
    // Check download status
    chrome.downloads.search({ id: request.downloadId }, (results) => {
      if (results && results.length > 0) {
        sendResponse({ state: results[0].state });
      } else {
        sendResponse({ state: 'interrupted' });
      }
    });
    return true;
  }

  if (request.action === 'deleteFile') {
    // Delete a downloaded file
    chrome.downloads.removeFile(request.downloadId, () => {
      if (chrome.runtime.lastError) {
        console.warn('Delete file error:', chrome.runtime.lastError.message);
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        // Also remove from download history
        chrome.downloads.erase({ id: request.downloadId }, () => {
          sendResponse({ success: true });
        });
      }
    });
    return true;
  }

  // ========================= Threaded Coordinator Actions =========================
  if (request.action === 'startThreads') {
    (async () => {
      try {
        const { clinicName, email, password, startingIndex = 1, numThreads = 2, resume = false } = request;

        const completedPatients = {};
        if (resume) {
          // Scan completed zips to build completedPatients map
          const downloads = await chrome.downloads.search({ filenameRegex: 'jane-scraper/.+__PID\\d+\\.zip$', exists: true });
          for (const d of downloads || []) {
            const m = d.filename && d.filename.match(/__PID(\d+)\.zip$/);
            if (m) {
              const pid = parseInt(m[1], 10);
              if (!Number.isNaN(pid)) {
                completedPatients[pid] = { filename: d.filename, endTime: d.endTime };
              }
            }
          }
        }

        // Initialize registry state
        const activeThreads = {};
        const patientLocks = {};
        await chrome.storage.local.set({
          workRegistry: { clinicName, startingIndex, nextPatientId: startingIndex, globalStop: false },
          activeThreads,
          patientLocks,
          completedPatients
        });

        // Helper to send message to tab with retries until content script is ready
        const sendMessageWithRetry = (tabId, message, maxAttempts = 30, delayMs = 1000) => new Promise((resolve) => {
          let attempt = 0;
          const trySend = () => {
            attempt++;
            chrome.tabs.sendMessage(tabId, message, (resp) => {
              if (chrome.runtime.lastError) {
                if (attempt >= maxAttempts) return resolve(false);
                setTimeout(trySend, delayMs);
              } else {
                resolve(true);
              }
            });
          };
          trySend();
        });

        // Create N tabs and kick off workers with staggered init (20s apart)
        for (let i = 1; i <= numThreads; i++) {
          const threadId = `T${i}`;
          const tab = await chrome.tabs.create({ url: `https://${clinicName}.janeapp.com/admin` });
          activeThreads[threadId] = { tabId: tab.id, status: 'initializing', patientId: null };
          // Persist after each creation to keep state
          await chrome.storage.local.set({ activeThreads });
          // Initialize content script thread after offset
          const delayMs = (i - 1) * 20000;
          setTimeout(async () => {
            await sendMessageWithRetry(tab.id, { action: 'initThread', threadId, clinicName, email, password, loginDelayMs: delayMs });
          }, delayMs);
        }

        sendResponse({ ok: true });
      } catch (e) {
        console.warn('startThreads error:', e);
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (request.action === 'requestWork') {
    (async () => {
      try {
        const { threadId } = request;
        const data = await chrome.storage.local.get(['workRegistry', 'patientLocks', 'completedPatients', 'activeThreads']);
        const workRegistry = data.workRegistry || {};
        const patientLocks = data.patientLocks || {};
        const completedPatients = data.completedPatients || {};
        const activeThreads = data.activeThreads || {};

        let { nextPatientId = 1 } = workRegistry;

        // Find next available patient ID not locked and not completed
        let assignedId = null;
        let probeId = nextPatientId;
        for (let attempts = 0; attempts < 5000; attempts++) {
          if (!completedPatients[probeId] && (!patientLocks[probeId] || patientLocks[probeId].threadId === threadId)) {
            assignedId = probeId;
            break;
          }
          probeId++;
        }

        if (assignedId == null) {
          sendResponse({ status: 'done' });
          return;
        }

        // Lock and advance pointer
        patientLocks[assignedId] = { threadId, timestamp: Date.now(), status: 'locked' };
        workRegistry.nextPatientId = assignedId + 1;
        if (activeThreads[threadId]) {
          activeThreads[threadId].status = 'working';
          activeThreads[threadId].patientId = assignedId;
        }
        await chrome.storage.local.set({ patientLocks, workRegistry, activeThreads });

        sendResponse({ status: 'assigned', patientId: assignedId, clinicName: workRegistry.clinicName });
      } catch (e) {
        console.warn('requestWork error:', e);
        sendResponse({ status: 'error', error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (request.action === 'getThreadAssignment') {
    (async () => {
      try {
        const tabId = sender?.tab?.id;
        const data = await chrome.storage.local.get('activeThreads');
        const activeThreads = data.activeThreads || {};
        const entry = Object.entries(activeThreads).find(([, v]) => v.tabId === tabId);
        if (entry) {
          const [threadId] = entry;
          sendResponse({ ok: true, threadId });
        } else {
          sendResponse({ ok: false });
        }
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (request.action === 'patientNotFound' || request.action === 'patientNoCharts') {
    (async () => {
      try {
        const { threadId, patientId } = request;
        const data = await chrome.storage.local.get(['patientLocks', 'activeThreads']);
        const patientLocks = data.patientLocks || {};
        const activeThreads = data.activeThreads || {};
        if (patientLocks[patientId] && patientLocks[patientId].threadId === threadId) {
          delete patientLocks[patientId];
        }
        if (activeThreads[threadId]) {
          activeThreads[threadId].status = 'idle';
          activeThreads[threadId].patientId = null;
        }
        await chrome.storage.local.set({ patientLocks, activeThreads });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (request.action === 'completeWork') {
    (async () => {
      try {
        const { threadId, patientId, patientName, zipFilename, success } = request;
        const data = await chrome.storage.local.get(['patientLocks', 'activeThreads', 'completedPatients']);
        const patientLocks = data.patientLocks || {};
        const activeThreads = data.activeThreads || {};
        const completedPatients = data.completedPatients || {};

        if (patientLocks[patientId] && patientLocks[patientId].threadId === threadId) {
          delete patientLocks[patientId];
        }
        if (success) {
          completedPatients[patientId] = { patientName, filename: zipFilename, timestamp: Date.now(), threadId };
        }
        if (activeThreads[threadId]) {
          activeThreads[threadId].status = 'idle';
          activeThreads[threadId].patientId = null;
        }
        await chrome.storage.local.set({ patientLocks, activeThreads, completedPatients });

        sendResponse({ ok: true });
      } catch (e) {
        console.warn('completeWork error:', e);
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  sendResponse({ received: true });
  return true;
});
