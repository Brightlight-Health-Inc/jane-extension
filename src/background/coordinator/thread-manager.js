/**
 * THREAD MANAGER MODULE
 *
 * Manages worker thread lifecycle:
 * - Create worker tabs
 * - Initialize threads with credentials
 * - Stop and cleanup threads
 * - Track thread status
 */

import { THREADING } from '../../shared/constants.js';
import { findPatientFolders, findLegacyZipFiles } from '../downloads/file-queries.js';

const MAX_THREAD_SLOTS = THREADING.MAX_THREADS;
const THREAD_SCOPED_SUFFIXES = [
  'scrapingState',
  'credentials',
  'retryCounts',
  'lastHeartbeat',
  'watchdogActive',
  'lastPdfFetchTs'
];

function getThreadScopedKeys(threadId) {
  return THREAD_SCOPED_SUFFIXES.map((suffix) => `${threadId}_${suffix}`);
}

function getAllThreadScopedKeys() {
  const keys = [];
  for (let i = 1; i <= MAX_THREAD_SLOTS; i++) {
    keys.push(...getThreadScopedKeys(`T${i}`));
  }
  return keys;
}

/**
 * Send a message to a tab with retry logic
 * Content scripts take time to load, so we retry until they respond
 *
 * @param {number} tabId - Tab ID
 * @param {Object} message - Message to send
 * @param {number} maxAttempts - Max retry attempts (default: 30)
 * @param {number} delayMs - Delay between attempts (default: 1000ms)
 * @returns {Promise<boolean>} True if successful
 */
export async function sendMessageWithRetry(tabId, message, maxAttempts = 30, delayMs = 1000) {
  return new Promise((resolve) => {
    let attempt = 0;

    const trySend = () => {
      attempt++;

      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          // Content script not ready yet, try again
          if (attempt >= maxAttempts) {
            console.warn(`Failed to send message to tab ${tabId} after ${maxAttempts} attempts`);
            return resolve(false);
          }
          setTimeout(trySend, delayMs);
        } else {
          resolve(true);
        }
      });
    };

    trySend();
  });
}

/**
 * Stop all active threads
 *
 * @returns {Promise<Object>} Result {ok: boolean, error?: string}
 */
export async function stopAllThreads() {
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
    await chrome.storage.local.remove([...getAllThreadScopedKeys(), 'patientFolders']);

    // Close all worker tabs after a short delay (give them time to process stop)
    setTimeout(() => {
      tabIds.forEach((tabId) => {
        try {
          chrome.tabs.remove(tabId);
        } catch (error) {
          console.warn(`Failed to close tab ${tabId}:`, error);
        }
      });
    }, 1000);

    // Auto-clear globalStop shortly after to allow clean restarts
    setTimeout(async () => {
      try {
        const nowData = await chrome.storage.local.get('workRegistry');
        const wr = nowData.workRegistry || {};

        if (wr.globalStop) {
          await chrome.storage.local.set({
            workRegistry: { ...wr, globalStop: false }
          });
        }
      } catch (error) {
        console.warn('Failed to clear globalStop flag:', error);
      }
    }, 1500);

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error)
    };
  }
}

/**
 * Cleanup existing threads from previous run
 *
 * @returns {Promise<void>}
 */
async function cleanupExistingThreads() {
  try {
    const existing = await chrome.storage.local.get(['activeThreads', 'patientLocks']);
    const existingThreads = existing.activeThreads || {};
    const existingTabIds = Object.values(existingThreads)
      .map((t) => t.tabId)
      .filter((id) => typeof id === 'number');

    if (existingTabIds.length > 0) {
      // Signal stop to all existing worker tabs
      await chrome.storage.local.set({
        stopRequested: true,
        userRequestedStop: true
      });

      await Promise.all(existingTabIds.map((tabId) => new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { action: 'stopScraping' }, () => resolve(true));
      })));

      // Close tabs
      await Promise.all(existingTabIds.map((tabId) => new Promise((resolve) => {
        try {
          chrome.tabs.remove(tabId, () => resolve(true));
        } catch (error) {
          resolve(false);
        }
      })));
    }

    // Clear coordinator state
    await chrome.storage.local.set({
      activeThreads: {},
      patientLocks: {},
      stopRequested: false,
      userRequestedStop: false
    });
    await chrome.storage.local.remove([...getAllThreadScopedKeys(), 'patientFolders']);
  } catch (error) {
    console.warn('Failed to cleanup existing threads:', error);
  }
}

/**
 * Initialize completed patients from existing downloads
 *
 * @param {boolean} resume - Include legacy ZIP files
 * @returns {Promise<Object>} Completed patients map
 */
async function initializeCompletedPatients(resume = false, clinicName = null) {
  const completedPatients = {};

  try {
    const data = await chrome.storage.local.get(['completedPatients', 'workRegistry']);
    const existingCompletedPatients = data.completedPatients || {};
    const previousClinicName = data.workRegistry?.clinicName || null;

    if (clinicName && previousClinicName === clinicName) {
      Object.assign(completedPatients, existingCompletedPatients);
    }
  } catch (error) {
    console.warn('Failed to restore completed patients from previous run:', error);
  }

  // Check for legacy ZIP files if resuming
  if (resume) {
    const legacyZips = await findLegacyZipFiles();
    Object.assign(completedPatients, legacyZips);
  }

  return completedPatients;
}

/**
 * Start multiple worker threads
 *
 * @param {Object} options - Configuration
 * @param {string} options.clinicName - Clinic subdomain
 * @param {string} options.email - Login email
 * @param {string} options.password - Login password
 * @param {number} options.startingIndex - Starting patient ID (default: 1)
 * @param {number} options.numThreads - Number of threads to create (default: 2)
 * @param {boolean} options.resume - Resume from previous run (default: false)
 * @param {number} options.maxId - Maximum patient ID to process (optional)
 * @returns {Promise<Object>} Result {ok: boolean, error?: string}
 */
export async function startThreads(options = {}) {
  try {
    const {
      clinicName,
      email,
      password,
      startingIndex = 1,
      numThreads = 2,
      resume = false,
      maxId = null
    } = options;

    if (!Number.isInteger(numThreads) || numThreads < 1 || numThreads > MAX_THREAD_SLOTS) {
      return {
        ok: false,
        error: `Thread count must be between 1 and ${MAX_THREAD_SLOTS}`
      };
    }

    // Clean up any existing threads from a previous run
    await cleanupExistingThreads();

    // Initialize completed patients
    const completedPatients = await initializeCompletedPatients(resume, clinicName);

    // Find existing patient folders
    const patientFolders = await findPatientFolders();

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
      } catch (error) {
        console.warn('Failed to send status update:', error);
      }
    }

    // Initialize the work coordinator
    const activeThreads = {};
    const patientLocks = {};

    await chrome.storage.local.set({
      workRegistry: {
        clinicName,
        startingIndex,
        nextPatientId: startingIndex,
        maxId: (Number.isInteger(maxId) && maxId > 0) ? maxId : null,
        globalStop: false,
        failedPatients: [],
        retriedPatients: {}
      },
      activeThreads,
      patientLocks,
      completedPatients
    });

    // Create N worker tabs
    for (let i = 1; i <= numThreads; i++) {
      const threadId = `T${i}`;

      // Create a new tab for this worker
      const tab = await chrome.tabs.create({
        url: `https://${clinicName}.janeapp.com/admin`
      });

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
      const delayMs = (i - 1) * THREADING.THREAD_STAGGER_DELAY_MS;

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

    return { ok: true };
  } catch (error) {
    console.error('startThreads error:', error);
    return {
      ok: false,
      error: error?.message || String(error)
    };
  }
}

/**
 * Remove a thread from tracking and close its tab
 *
 * @param {string} threadId - Thread ID (e.g., "T1")
 * @returns {Promise<Object>} Result {ok: boolean, error?: string}
 */
export async function removeThread(threadId) {
  try {
    const data = await chrome.storage.local.get(['activeThreads']);
    const activeThreads = data.activeThreads || {};

    const tabId = activeThreads[threadId]?.tabId;

    // Remove thread from active list
    if (activeThreads[threadId]) {
      delete activeThreads[threadId];
      await chrome.storage.local.set({ activeThreads });
      console.log(`Thread ${threadId} removed`);
    }

    await chrome.storage.local.remove(getThreadScopedKeys(threadId));

    // Close the worker tab
    if (tabId && typeof tabId === 'number') {
      setTimeout(() => {
        try {
          chrome.tabs.remove(tabId);
          console.log(`Closed tab ${tabId} for thread ${threadId}`);
        } catch (error) {
          console.warn(`Failed to close tab ${tabId}:`, error);
        }
      }, 1000);
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error)
    };
  }
}

/**
 * Get thread assignment for a tab
 *
 * @param {number} tabId - Tab ID
 * @returns {Promise<Object>} Result {ok: boolean, threadId?: string, error?: string}
 */
export async function getThreadAssignment(tabId) {
  try {
    const data = await chrome.storage.local.get('activeThreads');
    const activeThreads = data.activeThreads || {};

    // Find which thread ID owns this tab
    const entry = Object.entries(activeThreads).find(([, v]) => v.tabId === tabId);

    if (entry) {
      const [threadId] = entry;
      return { ok: true, threadId };
    } else {
      return { ok: false };
    }
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error)
    };
  }
}

/**
 * Handle thread management messages
 *
 * @param {Object} request - Message request
 * @param {Object} sender - Message sender
 * @param {Function} sendResponse - Response callback
 * @returns {boolean} True if async response
 */
export function handleThreadMessage(request, sender, sendResponse) {
  switch (request.action) {
    case 'broadcastStop':
      stopAllThreads()
        .then((result) => sendResponse(result));
      return true;

    case 'startThreads':
      startThreads(request)
        .then((result) => sendResponse(result));
      return true;

    case 'threadComplete':
      removeThread(request.threadId)
        .then((result) => sendResponse(result));
      return true;

    case 'getThreadAssignment':
      getThreadAssignment(sender?.tab?.id)
        .then((result) => sendResponse(result));
      return true;

    default:
      return false;
  }
}
