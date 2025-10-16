/**
 * BACKGROUND SERVICE WORKER
 * 
 * This coordinates everything for the Jane Scraper extension.
 * 
 * What it does:
 * - Opens the side panel when you click the extension icon
 * - Manages PDF downloads (starts them, checks their status)
 * - Coordinates multi-threaded scraping (assigns patients to worker tabs)
 * - Handles rate limiting (pauses all tabs when Jane slows us down)
 * 
 * Threading: When you run multiple threads, this script makes sure each
 * worker tab gets a different patient ID so there's no duplicate work.
 */

// ============================================================================
// EXTENSION SETUP
// ============================================================================

/**
 * Runs when extension is first installed
 */
chrome.runtime.onInstalled.addListener(() => {
  console.log('Jane Scraper installed');
});

/**
 * Open the side panel when user clicks the extension icon
 */
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

// ============================================================================
// MESSAGE HANDLER
// ============================================================================
//
// This handles all messages from content scripts and the side panel.
// Messages include: download PDF, check download status, manage threads, etc.
// ============================================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Message:', request.action);

  // ========================= PDF Download Actions =========================
  
  /**
   * Download a PDF file
   */
  if (request.action === 'downloadPDF') {
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

  /**
   * Check if a download is complete
   */
  if (request.action === 'checkDownload') {
    chrome.downloads.search({ id: request.downloadId }, (results) => {
      if (results && results.length > 0) {
        sendResponse({ state: results[0].state });
      } else {
        sendResponse({ state: 'interrupted' });
      }
    });
    return true;
  }

  // ========================= File Utility Actions =========================
  
  /**
   * Count how many PDFs we've downloaded for a patient
   */
  if (request.action === 'countPatientPdfs') {
    (async () => {
      try {
        const { patientId, folderName } = request;
        const regex = folderName
          ? `jane-scraper/${patientId}_${folderName}/.*\\.pdf$`
          : `jane-scraper/${patientId}_[^/]+/.*\\.pdf$`;
        const results = await chrome.downloads.search({ filenameRegex: regex, exists: true });
        sendResponse({ ok: true, count: (results || []).length });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  /**
   * Check if a specific PDF file already exists for a patient
   */
  if (request.action === 'fileExistsInPatientFolder') {
    (async () => {
      try {
        const { patientId, filenamePrefix } = request;
        
        // Escape special regex characters in filename
        const escaped = (filenamePrefix || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        
        // Pattern matches: jane-scraper/123_PatientName/filename.pdf
        const regex = `jane-scraper/${patientId}_[^/]+/${escaped}$`;
        
        const results = await chrome.downloads.search({ filenameRegex: regex, exists: true });
        sendResponse({ ok: true, exists: !!(results && results.length > 0) });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  // ========================= Thread Control Actions =========================
  
  /**
   * Stop all worker threads (called when user clicks stop button)
   */
  if (request.action === 'broadcastStop') {
    (async () => {
      try {
        // Get list of all active worker tabs
        const data = await chrome.storage.local.get(['activeThreads', 'workRegistry']);
        const activeThreads = data.activeThreads || {};
        const tabIds = Object.values(activeThreads)
          .map((t) => t.tabId)
          .filter((id) => typeof id === 'number');

        // Tell each worker tab to stop
        await Promise.all(tabIds.map((tabId) => new Promise((resolve) => {
          chrome.tabs.sendMessage(tabId, { action: 'stopScraping' }, () => resolve(true));
        })));

        // Clear all threading state and set a short-lived global stop
        await chrome.storage.local.set({
          activeThreads: {},
          stopRequested: true,
          workRegistry: { ...(data.workRegistry || {}), globalStop: true }
        });

        // Close all worker tabs after a short delay (give them time to process stop)
        setTimeout(() => {
          tabIds.forEach((tabId) => {
            try {
              chrome.tabs.remove(tabId);
            } catch (e) {
              console.warn(`Failed to close tab ${tabId}:`, e);
            }
          });
        }, 1000);

        // Auto-clear globalStop shortly after to allow clean restarts
        setTimeout(async () => {
          try {
            const nowData = await chrome.storage.local.get('workRegistry');
            const wr = nowData.workRegistry || {};
            if (wr.globalStop) {
              await chrome.storage.local.set({ workRegistry: { ...wr, globalStop: false } });
            }
          } catch (_) {}
        }, 1500);

        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  /**
   * Handle rate limiting or missing PDF controls
   * Pauses all threads, waits, then refreshes tabs to recover
   */
  if (request.action === 'globalCooldownAndRecover') {
    (async () => {
      try {
        const { clinicName, threadId } = request;
        
        // Default to 2 minutes pause, but allow override (1 second to 2 minutes)
        const pauseMs = Math.max(1000, Math.min(100000, Number(request.pauseMs) || 100000));
        const cooldownUntil = Date.now() + pauseMs;

        // Get all active worker tabs
        const data = await chrome.storage.local.get(['activeThreads', 'workRegistry']);
        const activeThreads = data.activeThreads || {};
        const tabIds = Object.values(activeThreads)
          .map((t) => t.tabId)
          .filter((id) => typeof id === 'number');

        // Save cooldown end time so new content scripts know to wait
        await chrome.storage.local.set({ globalCooldownUntil: cooldownUntil });

        // Send status update to UI
        const seconds = Math.floor(pauseMs / 1000);
        const triggerMsg = threadId ? ` by ${threadId}` : '';
        try {
          chrome.runtime.sendMessage({
            action: 'statusUpdate',
            status: {
              message: `⚠️ Global pause${triggerMsg}. Waiting ${seconds}s...`,
              type: 'warning'
            }
          });
        } catch (_) {}

        // Tell all tabs to pause
        await Promise.all(tabIds.map((tabId) => new Promise((resolve) => {
          chrome.tabs.sendMessage(tabId, { action: 'pauseForCooldown' }, () => resolve(true));
        })));

        // Wait for the cooldown period
        await new Promise((resolve) => setTimeout(resolve, pauseMs));

        // Check if user clicked stop during cooldown
        const flags = await chrome.storage.local.get(['stopRequested', 'userRequestedStop']);
        if (flags && (flags.stopRequested || flags.userRequestedStop)) {
          try {
            chrome.runtime.sendMessage({
              action: 'statusUpdate',
              status: { message: `⏹️ Cooldown canceled - user stopped`, type: 'info' }
            });
          } catch (_) {}
          sendResponse({ ok: true, canceled: true });
          return;
        }

        // Clear cooldown flag
        await chrome.storage.local.set({ stopRequested: false, globalCooldownUntil: 0 });

        // Send status update
        try {
          chrome.runtime.sendMessage({
            action: 'statusUpdate',
            status: { message: `🔄 Cooldown complete. Re-entering current URLs...`, type: 'info' }
          });
        } catch (_) {}

        // Re-enter the same URL for all worker tabs (more reliable than reload for SPA)
        await Promise.all(
          tabIds.map((tabId) => new Promise((resolve) => {
            try {
              chrome.tabs.get(tabId, (tab) => {
                // Fallback to reload if we cannot read the URL
                if (chrome.runtime.lastError || !tab || !tab.url) {
                  try {
                    chrome.tabs.reload(tabId, {}, () => resolve(true));
                  } catch (_) {
                    resolve(false);
                  }
                  return;
                }
                // Navigate to the exact same URL to force a fresh app route load
                chrome.tabs.update(tabId, { url: tab.url }, () => resolve(true));
              });
            } catch (e) {
              resolve(false);
            }
          }))
        );

        // After navigation, explicitly signal all tabs to clear stop and resume saved state
        const wrNow = await chrome.storage.local.get('workRegistry');
        const clinicNameNow = (wrNow.workRegistry && wrNow.workRegistry.clinicName) || '';
        await Promise.all(
          tabIds.map((tabId) => new Promise((resolve) => {
            try {
              chrome.tabs.sendMessage(tabId, { action: 'clearStopAndResume', clinicName: clinicNameNow }, () => resolve(true));
            } catch (_) {
              resolve(false);
            }
          }))
        );

        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  /**
   * Delete a downloaded file (legacy, not currently used)
   */
  if (request.action === 'deleteFile') {
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

  // ========================= Threading Coordinator Actions =========================
  //
  // These actions manage the worker tabs that do the actual scraping.
  // Each worker tab is assigned a thread ID (T1, T2, etc.) and requests work
  // from this coordinator to avoid duplicate work.
  // ========================= Threading Coordinator Actions =========================
  
  /**
   * Start multiple worker threads to scrape patients in parallel
   * Creates N tabs and assigns each one a thread ID
   */
  if (request.action === 'startThreads') {
    (async () => {
      try {
        const { clinicName, email, password, startingIndex = 1, numThreads = 2, resume = false, maxId = null } = request;

        // Clean up any existing threads from a previous run to avoid ghosts
        try {
          const existing = await chrome.storage.local.get(['activeThreads', 'patientLocks']);
          const existingThreads = existing.activeThreads || {};
          const existingTabIds = Object.values(existingThreads)
            .map((t) => t.tabId)
            .filter((id) => typeof id === 'number');

          if (existingTabIds.length > 0) {
            // Signal stop to all existing worker tabs
            await chrome.storage.local.set({ stopRequested: true, userRequestedStop: true });
            await Promise.all(existingTabIds.map((tabId) => new Promise((resolve) => {
              chrome.tabs.sendMessage(tabId, { action: 'stopScraping' }, () => resolve(true));
            })));

            // Close tabs
            await Promise.all(existingTabIds.map((tabId) => new Promise((resolve) => {
              try {
                chrome.tabs.remove(tabId, () => resolve(true));
              } catch (_) {
                resolve(false);
              }
            })));
          }

          // Clear coordinator state
          await chrome.storage.local.set({ activeThreads: {}, patientLocks: {}, stopRequested: false, userRequestedStop: false });
        } catch (_) {}

        const completedPatients = {};

        // Step 1: Check what patients we've already downloaded
        // Look for existing patient folders in Downloads/jane-scraper/
        const downloads = await chrome.downloads.search({
          filenameRegex: 'jane-scraper/\\d+_[^/]+/.*\\.pdf$',
          exists: true
        });

        // Group PDFs by patient folder
        const patientFolders = {};
        for (const download of downloads || []) {
          // Extract patient ID and folder name from path
          // Example: jane-scraper/123_JohnDoe/chart.pdf
          const match = download.filename && download.filename.match(/jane-scraper\/(\d+)_([^/]+)\//);
          if (match) {
            const patientId = parseInt(match[1], 10);
            if (!Number.isNaN(patientId) && download.filename.endsWith('.pdf')) {
              if (!patientFolders[patientId]) {
                patientFolders[patientId] = {
                  patientId: patientId,
                  folderName: match[2],
                  files: []
                };
              }
              patientFolders[patientId].files.push(download.filename);
            }
          }
        }

        // Save patient folders info so worker threads can check for already-downloaded files
        await chrome.storage.local.set({ patientFolders });

        // Tell the user how many patients we found
        const patientCount = Object.keys(patientFolders).length;
        if (patientCount > 0) {
          const plural = patientCount !== 1 ? 's' : '';
          try {
            chrome.runtime.sendMessage({
              action: 'statusUpdate',
              status: {
                message: `📂 Found ${patientCount} patient${plural} with existing downloads`,
                type: 'info'
              }
            });
          } catch (_) {}
        }

        // Legacy: Check for old zip files (we used to zip PDFs, now we just save to folders)
        if (resume) {
          const zips = await chrome.downloads.search({
            filenameRegex: 'jane-scraper/\\d+_.+\\.zip$',
            exists: true
          });
          for (const download of zips || []) {
            const match = download.filename && download.filename.match(/\/(\d+)_[^/]+\.zip$/);
            if (match) {
              const patientId = parseInt(match[1], 10);
              if (!Number.isNaN(patientId)) {
                completedPatients[patientId] = {
                  filename: download.filename,
                  endTime: download.endTime
                };
              }
            }
          }
        }

        // Step 2: Initialize the work coordinator
        // Set up the state that tracks which patients need to be done
        const activeThreads = {};
        const patientLocks = {};
        await chrome.storage.local.set({
          workRegistry: {
            clinicName,
            startingIndex,
            nextPatientId: startingIndex,
            maxId: (Number.isInteger(maxId) && maxId > 0) ? maxId : null,
            globalStop: false
          },
          activeThreads,
          patientLocks,
          completedPatients
        });

        // Helper function to send a message to a tab and keep retrying until it responds
        // (Content scripts take time to load)
        const sendMessageWithRetry = (tabId, message, maxAttempts = 30, delayMs = 1000) => {
          return new Promise((resolve) => {
            let attempt = 0;
            const trySend = () => {
              attempt++;
              chrome.tabs.sendMessage(tabId, message, (response) => {
                if (chrome.runtime.lastError) {
                  // Content script not ready yet, try again
                  if (attempt >= maxAttempts) return resolve(false);
                  setTimeout(trySend, delayMs);
                } else {
                  resolve(true);
                }
              });
            };
            trySend();
          });
        };

        // Step 3: Create N worker tabs
        for (let i = 1; i <= numThreads; i++) {
          const threadId = `T${i}`;
          
          // Create a new tab for this worker
          const tab = await chrome.tabs.create({ url: `https://${clinicName}.janeapp.com/admin` });
          
          // Track this worker
          activeThreads[threadId] = {
            tabId: tab.id,
            status: 'initializing',
            patientId: null
          };
          await chrome.storage.local.set({ activeThreads });

          // Initialize this worker with a staggered delay
          // First thread starts immediately, second after 10s, etc.
          // This prevents all threads from hammering Jane at once
          const delayMs = (i - 1) * 10000;
          setTimeout(async () => {
            await sendMessageWithRetry(tab.id, {
              action: 'initThread',
              threadId,
              clinicName,
              email,
              password,
              loginDelayMs: delayMs
            });
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

  /**
   * Assign the next patient to a worker thread
   * This is the core of the work coordination system
   */
  if (request.action === 'requestWork') {
    (async () => {
      try {
        const { threadId } = request;
        const originTabId = sender?.tab?.id;
        
        // Get current state
        const data = await chrome.storage.local.get([
          'workRegistry',
          'patientLocks',
          'completedPatients',
          'activeThreads'
        ]);
        const workRegistry = data.workRegistry || {};
        const patientLocks = data.patientLocks || {};
        const completedPatients = data.completedPatients || {};
        const activeThreads = data.activeThreads || {};

        // If a global stop is in effect, do not assign work
        if (workRegistry.globalStop) {
          sendResponse({ status: 'done' });
          return;
        }

        let { nextPatientId = 1, maxId = null } = workRegistry;

        // Find the next patient that:
        // 1. Hasn't been completed already
        // 2. Isn't locked by another thread
        let assignedId = null;
        let probeId = nextPatientId;
        
        for (let attempts = 0; attempts < 5000; attempts++) {
          // Respect maxId limit if provided
          if (Number.isInteger(maxId) && probeId > maxId) {
            assignedId = null;
            break;
          }
          const isCompleted = !!completedPatients[probeId];
          const isLocked = patientLocks[probeId] && patientLocks[probeId].threadId !== threadId;
          
          if (!isCompleted && !isLocked) {
            assignedId = probeId;
            break;
          }
          probeId++;
        }

        // No more patients to assign
        if (assignedId == null) {
          sendResponse({ status: 'done' });
          return;
        }

        // Lock this patient for this thread
        patientLocks[assignedId] = {
          threadId,
          timestamp: Date.now(),
          status: 'locked'
        };
        
        // Advance the pointer for next request
        workRegistry.nextPatientId = assignedId + 1;
        
        // Update thread status and ensure we track the tabId for this thread
        activeThreads[threadId] = activeThreads[threadId] || {};
        if (!activeThreads[threadId].tabId && typeof originTabId === 'number') {
          activeThreads[threadId].tabId = originTabId;
        }
        activeThreads[threadId].status = 'working';
        activeThreads[threadId].patientId = assignedId;
        
        // Save all the updates
        await chrome.storage.local.set({ patientLocks, workRegistry, activeThreads });

        // Tell the thread which patient to work on
        sendResponse({
          status: 'assigned',
          patientId: assignedId,
          clinicName: workRegistry.clinicName
        });
      } catch (e) {
        console.warn('requestWork error:', e);
        sendResponse({ status: 'error', error: e?.message || String(e) });
      }
    })();
    return true;
  }

  /**
   * Get which thread ID is assigned to a tab
   */
  if (request.action === 'getThreadAssignment') {
    (async () => {
      try {
        const tabId = sender?.tab?.id;
        const data = await chrome.storage.local.get('activeThreads');
        const activeThreads = data.activeThreads || {};
        
        // Find which thread ID owns this tab
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

  /**
   * Patient not found or has no charts - unlock it and let thread request next work
   */
  if (request.action === 'patientNotFound' || request.action === 'patientNoCharts') {
    (async () => {
      try {
        const { threadId, patientId } = request;
        const data = await chrome.storage.local.get(['patientLocks', 'activeThreads']);
        const patientLocks = data.patientLocks || {};
        const activeThreads = data.activeThreads || {};
        
        // Unlock the patient
        if (patientLocks[patientId] && patientLocks[patientId].threadId === threadId) {
          delete patientLocks[patientId];
        }
        
        // Mark thread as idle
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

  /**
   * Thread finished a patient successfully
   */
  if (request.action === 'completeWork') {
    (async () => {
      try {
        const { threadId, patientId, patientName, zipFilename, success } = request;
        const data = await chrome.storage.local.get([
          'patientLocks',
          'activeThreads',
          'completedPatients'
        ]);
        const patientLocks = data.patientLocks || {};
        const activeThreads = data.activeThreads || {};
        const completedPatients = data.completedPatients || {};

        // Unlock the patient
        if (patientLocks[patientId] && patientLocks[patientId].threadId === threadId) {
          delete patientLocks[patientId];
        }
        
        // Mark patient as completed
        if (success) {
          completedPatients[patientId] = {
            patientName,
            filename: zipFilename,
            timestamp: Date.now(),
            threadId
          };
        }
        
        // Mark thread as idle
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

  /**
   * Thread is completely done (no more work available)
   * Remove it from tracking and close its tab
   */
  if (request.action === 'threadComplete') {
    (async () => {
      try {
        const { threadId } = request;
        const data = await chrome.storage.local.get(['activeThreads']);
        const activeThreads = data.activeThreads || {};

        const tabId = activeThreads[threadId]?.tabId;

        // Remove thread from active list
        if (activeThreads[threadId]) {
          delete activeThreads[threadId];
          await chrome.storage.local.set({ activeThreads });
          console.log(`Thread ${threadId} removed`);
        }

        // Close the worker tab
        if (tabId && typeof tabId === 'number') {
          setTimeout(() => {
            try {
              chrome.tabs.remove(tabId);
              console.log(`Closed tab ${tabId} for thread ${threadId}`);
            } catch (e) {
              console.warn(`Failed to close tab ${tabId}:`, e);
            }
          }, 1000);
        }

        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  // Default response for unknown actions
  sendResponse({ received: true });
  return true;
});
