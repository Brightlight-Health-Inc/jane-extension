/**
 * WORK SCHEDULER MODULE
 *
 * Coordinates patient assignment to worker threads:
 * - Assign next available patient to thread
 * - Track patient locks to prevent duplicate work
 * - Handle work completion
 * - Skip patients (not found, no charts)
 */

let schedulerMutationQueue = Promise.resolve();

function runSchedulerMutation(operation) {
  const task = schedulerMutationQueue.then(operation, operation);
  schedulerMutationQueue = task.catch(() => {});
  return task;
}

/**
 * Find next available patient ID
 * Skips completed and locked patients
 *
 * @param {number} startId - Starting patient ID
 * @param {number} maxId - Maximum patient ID (null for unlimited)
 * @param {Object} completedPatients - Map of completed patient IDs
 * @param {Object} patientLocks - Map of locked patient IDs
 * @param {string} threadId - Requesting thread ID (can reacquire own locks)
 * @returns {number|null} Next available patient ID or null
 */
function findNextAvailablePatient(startId, maxId, completedPatients, patientLocks, threadId) {
  let probeId = startId;
  const maxAttempts = Number.isInteger(maxId) && maxId >= startId
    ? (maxId - startId + 1)
    : 50000;

  // Probe the configured range, or a large fallback window when maxId is unknown.
  for (let attempts = 0; attempts < maxAttempts; attempts++) {
    // Respect maxId limit if provided
    if (Number.isInteger(maxId) && probeId > maxId) {
      return null;
    }

    const isCompleted = !!completedPatients[probeId];
    const isLocked = patientLocks[probeId] && patientLocks[probeId].threadId !== threadId;

    if (!isCompleted && !isLocked) {
      return probeId;
    }

    probeId++;
  }

  return null; // No available patients found
}

/**
 * Assign next patient to a thread
 *
 * @param {string} threadId - Thread ID requesting work
 * @param {number} originTabId - Tab ID of requesting thread
 * @returns {Promise<Object>} Result {status: string, patientId?: number, clinicName?: string, error?: string}
 */
export async function assignWork(threadId, originTabId) {
  return runSchedulerMutation(async () => {
    try {
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
        return { status: 'done' };
      }

      let { nextPatientId = 1, maxId = null } = workRegistry;

      // Find the next patient that:
      // 1. Hasn't been completed already
      // 2. Isn't locked by another thread
      const assignedId = findNextAvailablePatient(
        nextPatientId,
        maxId,
        completedPatients,
        patientLocks,
        threadId
      );

      // No more patients to assign
      if (assignedId == null) {
        return { status: 'done' };
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
      return {
        status: 'assigned',
        patientId: assignedId,
        clinicName: workRegistry.clinicName
      };
    } catch (error) {
      console.error('assignWork error:', error);
      return {
        status: 'error',
        error: error?.message || String(error)
      };
    }
  });
}

/**
 * Mark patient as not found or having no charts
 * Unlocks the patient so other threads don't try it
 *
 * @param {string} threadId - Thread ID
 * @param {number} patientId - Patient ID
 * @returns {Promise<Object>} Result {ok: boolean, error?: string}
 */
export async function skipPatient(threadId, patientId) {
  return runSchedulerMutation(async () => {
    try {
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

      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error?.message || String(error)
      };
    }
  });
}

/**
 * Mark patient as completed
 *
 * @param {string} threadId - Thread ID
 * @param {number} patientId - Patient ID
 * @param {string} patientName - Patient name
 * @param {string} zipFilename - ZIP filename (legacy)
 * @param {boolean} success - Whether processing was successful
 * @returns {Promise<Object>} Result {ok: boolean, error?: string}
 */
export async function completeWork(threadId, patientId, patientName, zipFilename, success) {
  return runSchedulerMutation(async () => {
    try {
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

      return { ok: true };
    } catch (error) {
      console.error('completeWork error:', error);
      return {
        ok: false,
        error: error?.message || String(error)
      };
    }
  });
}

/**
 * Handle work scheduling messages
 *
 * @param {Object} request - Message request
 * @param {Object} sender - Message sender
 * @param {Function} sendResponse - Response callback
 * @returns {boolean} True if async response
 */
export function handleWorkMessage(request, sender, sendResponse) {
  switch (request.action) {
    case 'requestWork':
      assignWork(request.threadId, sender?.tab?.id)
        .then((result) => sendResponse(result));
      return true;

    case 'patientNotFound':
    case 'patientNoCharts':
      skipPatient(request.threadId, request.patientId)
        .then((result) => sendResponse(result));
      return true;

    case 'completeWork':
      completeWork(
        request.threadId,
        request.patientId,
        request.patientName,
        request.zipFilename,
        request.success
      )
        .then((result) => sendResponse(result));
      return true;

    default:
      return false;
  }
}
