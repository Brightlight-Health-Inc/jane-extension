/**
 * ROUTE DETECTOR MODULE
 *
 * Detects and handles Jane App navigation issues:
 * - Rate limit detection ("Whoa there friend" page)
 * - Freeze/timeout recovery
 * - Route validation
 */

import { TIMEOUTS } from '../../shared/constants.js';
import { sleep } from '../../shared/utils/async-utils.js';
import { getClinicNameFromUrl } from '../../shared/utils/url-utils.js';

/**
 * Check if we hit Jane's rate limit page
 * Jane shows a "Whoa there friend, please take a moment" page when you're going too fast
 *
 * @param {Object} options - Configuration
 * @param {Object} options.logger - Logger instance
 * @returns {Promise<boolean>} True if rate limit page detected
 */
export async function detectRateLimit(options = {}) {
  const { logger = null } = options;

  try {
    // Look for rate limit text in the page
    const bodyText = (document.body?.innerText || '').toLowerCase();
    const isRateLimitPage = bodyText.includes('whoa there friend') &&
                           bodyText.includes('please take a moment');

    if (isRateLimitPage) {
      if (logger) {
        logger.warn('Rate limit page detected');
      }
      return true;
    }

    return false;
  } catch (error) {
    if (logger) {
      logger.error('Failed to detect rate limit', error);
    }
    return false;
  }
}

/**
 * Handle rate limit detection
 * Pauses the current thread and schedules recovery
 *
 * @param {Object} options - Configuration
 * @param {string} options.clinicName - Clinic name
 * @param {Object} options.resumeState - State to resume from
 * @param {number} options.pauseDuration - How long to pause in ms (default: 60000)
 * @param {Function} options.onPause - Callback when pause starts (receives {duration, resumeState})
 * @param {Object} options.logger - Logger instance
 * @returns {Promise<Object>} Result {paused: true, duration: number}
 */
export async function handleRateLimit(options = {}) {
  const {
    clinicName = null,
    resumeState = null,
    pauseDuration = 60000,
    onPause = null,
    logger = null
  } = options;

  try {
    if (logger) {
      logger.warn(`Rate limit detected. Pausing for ${pauseDuration / 1000} seconds`);
    }

    let pauseHandled = false;

    // Call pause callback if provided
    if (onPause) {
      const pauseResult = await onPause({ duration: pauseDuration, resumeState });
      pauseHandled = !!pauseResult?.pauseHandled;
    }

    // Wait for the pause duration unless the callback already handled it.
    if (!pauseHandled) {
      await sleep(pauseDuration);
    }

    if (logger) {
      logger.info('Rate limit pause complete, resuming');
    }

    return {
      paused: true,
      duration: pauseDuration
    };

  } catch (error) {
    if (logger) {
      logger.error('Failed to handle rate limit', error);
    }
    throw error;
  }
}

/**
 * Check if page appears frozen
 * Checks chrome.storage for freeze flag
 *
 * @param {Object} options - Configuration
 * @param {Object} options.logger - Logger instance
 * @returns {Promise<boolean>} True if page is frozen
 */
export async function detectFreeze(options = {}) {
  const { logger = null } = options;

  try {
    const freeze = await chrome.storage.local.get('frozen');
    const isFrozen = freeze && freeze.frozen;

    if (isFrozen && logger) {
      logger.warn('Page freeze detected');
    }

    return isFrozen;
  } catch (error) {
    if (logger) {
      logger.error('Failed to check freeze status', error);
    }
    return false;
  }
}

/**
 * Handle page freeze
 * Pauses for recovery period then triggers navigation refresh
 *
 * @param {Object} options - Configuration
 * @param {string} options.clinicName - Clinic name
 * @param {number} options.patientId - Patient ID to resume
 * @param {string} options.threadId - Thread ID
 * @param {string} options.action - Action to resume ('requestWork', 'downloadChart', etc.)
 * @param {Function} options.onFreeze - Callback when freeze starts (receives {clinicName, patientId, action})
 * @param {Function} options.shouldStop - Stop check function
 * @param {Object} options.logger - Logger instance
 * @returns {Promise<Object>} Result {paused: true, willRefresh: boolean}
 */
export async function handleFreeze(options = {}) {
  const {
    clinicName = null,
    patientId = null,
    threadId = null,
    action = 'requestWork',
    onFreeze = null,
    shouldStop = null,
    logger = null
  } = options;

  try {
    if (logger) {
      logger.warn(`Page appears frozen. Waiting ${TIMEOUTS.FREEZE_RECOVERY_PAUSE / 1000}s then refreshing`);
    }

    // Call freeze callback if provided
    if (onFreeze) {
      await onFreeze({ clinicName, patientId, action });
    }

    // Save state to resume after refresh
    if (threadId && patientId && clinicName) {
      try {
        const scopedKey = `${threadId}_scrapingState`;
        await chrome.storage.local.set({
          [scopedKey]: {
            action,
            clinicName,
            resumePatientId: patientId,
            savedThreadId: threadId
          }
        });
      } catch (error) {
        if (logger) {
          logger.error('Failed to save freeze recovery state', error);
        }
      }
    }

    // Wait for freeze recovery pause
    await sleep(TIMEOUTS.FREEZE_RECOVERY_PAUSE, { shouldStop });

    // Refresh current route
    if (clinicName && patientId) {
      const url = `https://${clinicName}.janeapp.com/admin#patients/${patientId}`;
      window.location.href = url;

      if (logger) {
        logger.info('Refreshing route after freeze recovery');
      }

      return { paused: true, willRefresh: true };
    }

    return { paused: true, willRefresh: false };

  } catch (error) {
    if (error.message === 'Stopped' || error.message.includes('Stopped while')) {
      if (logger) {
        logger.warn('Freeze recovery stopped by user');
      }
      throw error;
    }

    if (logger) {
      logger.error('Failed to handle freeze', error);
    }
    throw error;
  }
}

/**
 * Detect and handle both rate limits and freezes
 * Convenience function that checks for both issues
 *
 * @param {Object} options - Configuration
 * @param {string} options.clinicName - Clinic name
 * @param {number} options.patientId - Patient ID
 * @param {string} options.threadId - Thread ID
 * @param {Object} options.resumeState - State to resume from
 * @param {Function} options.onRateLimit - Callback for rate limit
 * @param {Function} options.onFreeze - Callback for freeze
 * @param {Function} options.shouldStop - Stop check function
 * @param {Object} options.logger - Logger instance
 * @returns {Promise<Object|null>} Detection result or null if nothing detected
 */
export async function detectAndHandleIssues(options = {}) {
  const {
    clinicName = null,
    patientId = null,
    threadId = null,
    resumeState = null,
    onRateLimit = null,
    onFreeze = null,
    shouldStop = null,
    logger = null
  } = options;

  try {
    // Check for rate limit first (more critical)
    const isRateLimited = await detectRateLimit({ logger });
    if (isRateLimited) {
      return await handleRateLimit({
        clinicName: clinicName || getClinicNameFromUrl(),
        resumeState,
        onPause: onRateLimit,
        logger
      });
    }

    // Check for freeze
    const isFrozen = await detectFreeze({ logger });
    if (isFrozen) {
      return await handleFreeze({
        clinicName: clinicName || getClinicNameFromUrl(),
        patientId,
        threadId,
        action: resumeState?.action || 'requestWork',
        onFreeze,
        shouldStop,
        logger
      });
    }

    // No issues detected
    return null;

  } catch (error) {
    if (logger) {
      logger.error('Failed to detect/handle navigation issues', error);
    }
    throw error;
  }
}

/**
 * Validate that we're on the expected page
 *
 * @param {Object} options - Configuration
 * @param {string} options.expectedPath - Expected URL path pattern (e.g., 'patients/42')
 * @param {number} options.timeout - Max time to wait for correct page (ms)
 * @param {Object} options.logger - Logger instance
 * @returns {Promise<boolean>} True if on expected page
 */
export async function validateCurrentRoute(options = {}) {
  const {
    expectedPath = null,
    timeout = 5000,
    logger = null
  } = options;

  if (!expectedPath) {
    if (logger) {
      logger.warn('No expected path provided for route validation');
    }
    return true; // No validation needed
  }

  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const currentUrl = window.location.href;

    if (currentUrl.includes(expectedPath)) {
      if (logger) {
        logger.debug(`Route validated: ${expectedPath}`);
      }
      return true;
    }

    await sleep(500);
  }

  if (logger) {
    logger.warn(`Route validation failed: expected ${expectedPath}, current ${window.location.href}`);
  }
  return false;
}
