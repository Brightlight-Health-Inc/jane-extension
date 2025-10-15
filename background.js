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
 * - Coordinates multi-threaded scraping across worker tabs
 */

/**
 * Handles extension installation event
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

  // ========================= Broadcast Stop to All Workers =========================
  if (request.action === 'broadcastStop') {
    (async () => {
      try {
        const data = await chrome.storage.local.get(['activeThreads', 'workRegistry']);
        const activeThreads = data.activeThreads || {};
        const tabIds = Object.values(activeThreads).map((t) => t.tabId).filter((id) => typeof id === 'number');

        await Promise.all(tabIds.map((tabId) => new Promise((resolve) => {
          chrome.tabs.sendMessage(tabId, { action: 'stopScraping' }, () => resolve(true));
        })));

        // Also set flags for any future page loads
        const workRegistry = data.workRegistry || {};
        await chrome.storage.local.set({ workRegistry: { ...workRegistry, globalStop: true }, stopRequested: true });

        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  // ========================= Global Cooldown & Recovery =========================
  // Triggered when any thread hits the Jane "Whoa there friend" throttle page.
  // 1) Broadcast stop to all workers
  // 2) Wait 15 seconds
  // 3) Redirect all worker tabs to /admin (which redirects to home)
  // 4) Clear stop flag and allow workers to resume from saved state
  if (request.action === 'globalCooldownAndRecover') {
    (async () => {
      try {
        const { clinicName, resumeState, threadId } = request;

        // Mark a global stop and broadcast to current workers
        const data = await chrome.storage.local.get(['activeThreads', 'workRegistry']);
        const activeThreads = data.activeThreads || {};
        const tabIds = Object.values(activeThreads)
          .map((t) => t.tabId)
          .filter((id) => typeof id === 'number');

        // Send stop to all tabs
        await Promise.all(tabIds.map((tabId) => new Promise((resolve) => {
          chrome.tabs.sendMessage(tabId, { action: 'stopScraping' }, () => resolve(true));
        })));

        // Persist global stop for any late listeners
        const workRegistry = data.workRegistry || {};
        await chrome.storage.local.set({ workRegistry: { ...workRegistry, globalStop: true }, stopRequested: true });

        // Optionally persist a best-effort recover hint per thread that triggered it
        if (threadId && resumeState) {
          await chrome.storage.local.set({ [threadId + '_recoverHint']: resumeState });
        }

        // Wait cooldown period (15s)
        await new Promise((r) => setTimeout(r, 15000));

        // Redirect all worker tabs to /admin
        const baseClinic = clinicName || workRegistry?.clinicName;
        if (baseClinic) {
          await Promise.all(tabIds.map((tabId) => chrome.tabs.update(tabId, { url: `https://${baseClinic}.janeapp.com/admin` })));
        }

        // After redirects, try sending a resume signal with retries so content is ready
        await chrome.storage.local.set({ stopRequested: false });

        const sendResumeWithRetry = async (tabId, attempts = 20) => {
          for (let i = 0; i < attempts; i++) {
            try {
              await new Promise((resolve) => setTimeout(resolve, 1000));
              await new Promise((resolve) => {
                chrome.tabs.sendMessage(tabId, { action: 'clearStopAndResume', clinicName: baseClinic }, () => resolve(true));
              });
              break;
            } catch (_) {
              // try again
            }
          }
        };

        await Promise.all(tabIds.map((tabId) => sendResumeWithRetry(tabId)));

        // Clear globalStop so future work can continue
        const latest = await chrome.storage.local.get(['workRegistry']);
        const wr = latest.workRegistry || {};
        await chrome.storage.local.set({ workRegistry: { ...wr, globalStop: false } });

        // Done
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
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
          const downloads = await chrome.downloads.search({ filenameRegex: 'jane-scraper/\\d+_.+\\.zip$', exists: true });
          for (const d of downloads || []) {
            const m = d.filename && d.filename.match(/\/(\d+)_[^/]+\.zip$/);
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

        // Create N tabs and initialize workers
        for (let i = 1; i <= numThreads; i++) {
          const threadId = `T${i}`;
          const tab = await chrome.tabs.create({ url: `https://${clinicName}.janeapp.com/admin` });
          activeThreads[threadId] = { tabId: tab.id, status: 'initializing', patientId: null };
          await chrome.storage.local.set({ activeThreads });

          // Initialize with delay (0s for first, 10s for second, etc.)
          const delayMs = (i - 1) * 10000;
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
