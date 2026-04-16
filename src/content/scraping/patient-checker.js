/**
 * PATIENT CHECKER MODULE
 *
 * Validates that a patient exists and extracts basic info:
 * - Check if patient page loaded successfully
 * - Wait for loading spinners to disappear
 * - Detect error pages
 * - Extract patient name
 */

import { TIMEOUTS, SELECTORS } from '../../shared/constants.js';
import { sleep } from '../../shared/utils/async-utils.js';
import { hasVisibleElement } from '../../shared/utils/dom-utils.js';

/**
 * Custom error for patient checking failures
 */
export class PatientCheckError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'PatientCheckError';
    this.cause = cause;
  }
}

/**
 * Check if the patient exists on their page
 *
 * @param {Object} options - Configuration
 * @param {Function} options.shouldStop - Stop check function
 * @param {Object} options.logger - Logger instance
 * @param {Function} options.onFreeze - Callback when page freeze detected
 * @returns {Promise<Object>} Result {exists: boolean, reason?: string, paused?: boolean}
 */
export async function checkPatientExists(options = {}) {
  const {
    shouldStop = null,
    logger = null,
    onFreeze = null
  } = options;

  try {
    if (logger) {
      logger.info('Checking if patient exists');
    }

    // Wait for initial page load
    await sleep(TIMEOUTS.PATIENT_PAGE_LOAD, { shouldStop });

    // Check if page is frozen
    try {
      const freeze = await chrome.storage.local.get('frozen');
      if (freeze && freeze.frozen) {
        if (logger) {
          logger.warn('Page appears frozen during patient check');
        }

        // Call freeze callback if provided
        if (onFreeze) {
          await onFreeze();
        }

        return { exists: false, reason: 'frozen', paused: true };
      }
    } catch (error) {
      if (logger) {
        logger.error('Failed to check freeze status', error);
      }
    }

    // Wait for loading spinner to disappear
    const spinnerWaitResult = await waitForSpinnerToDisappear({
      maxWaitTime: TIMEOUTS.PATIENT_CHECK_TIMEOUT,
      shouldStop,
      logger
    });

    if (!spinnerWaitResult.success) {
      if (logger) {
        logger.warn('Patient check timed out waiting for spinner');
      }
      return { exists: false, reason: 'timeout' };
    }

    // Check for error messages on the page
    const hasError = checkForErrorMessages();
    if (hasError) {
      if (logger) {
        logger.warn('Patient not found (error message shown)');
      }
      return { exists: false, reason: 'not_found' };
    }

    // Check if patient name element is on the page
    const nameElement = document.querySelector(SELECTORS.PATIENT_NAME);

    if (nameElement) {
      if (logger) {
        logger.success('Patient found');
      }
      return { exists: true };
    } else {
      if (logger) {
        logger.warn('Patient not found (no name element)');
      }
      return { exists: false, reason: 'not_found' };
    }

  } catch (error) {
    if (error.message === 'Stopped' || error.message.includes('Stopped while')) {
      if (logger) {
        logger.warn('Patient check stopped by user');
      }
      throw error; // Re-throw stop errors
    }

    if (logger) {
      logger.error('Patient check failed', error);
    }

    throw new PatientCheckError(`Failed to check patient existence: ${error.message}`, error);
  }
}

/**
 * Wait for loading spinner to disappear
 *
 * @param {Object} options - Configuration
 * @param {number} options.maxWaitTime - Max time to wait in ms (default: 20000)
 * @param {Function} options.shouldStop - Stop check function
 * @param {Object} options.logger - Logger instance
 * @returns {Promise<Object>} Result {success: boolean}
 */
async function waitForSpinnerToDisappear(options = {}) {
  const {
    maxWaitTime = 20000,
    shouldStop = null,
    logger = null
  } = options;

  const spinnerSelector = SELECTORS.LOADING_SPINNER;
  const startTime = Date.now();

  if (logger) {
    logger.debug('Waiting for loading spinner to disappear');
  }

  while (hasVisibleElement(spinnerSelector)) {
    if (shouldStop && shouldStop()) {
      throw new Error('Stopped while waiting for spinner');
    }

    if (Date.now() - startTime > maxWaitTime) {
      if (logger) {
        logger.warn('Spinner wait timed out');
      }
      return { success: false }; // Spinner never went away
    }

    await sleep(500, { shouldStop });
  }

  if (logger) {
    logger.debug('Loading spinner disappeared');
  }

  return { success: true };
}

/**
 * Check for error messages on the page
 *
 * @returns {boolean} True if error message found
 */
function checkForErrorMessages() {
  const errorElement = document.querySelector('.alert-danger, .error-message');
  return !!errorElement;
}

/**
 * Get the patient's name from the page
 *
 * @param {Object} options - Configuration
 * @param {Object} options.logger - Logger instance
 * @returns {Promise<string>} Patient name or empty string
 */
export async function getPatientName(options = {}) {
  const { logger = null } = options;

  try {
    await sleep(500);

    const nameElement = document.querySelector(SELECTORS.PATIENT_NAME);
    const name = nameElement ? nameElement.textContent.trim() : '';

    if (logger && name) {
      logger.debug(`Patient name: ${name}`);
    }

    return name;

  } catch (error) {
    if (logger) {
      logger.error('Failed to get patient name', error);
    }
    return '';
  }
}

/**
 * Validate patient data completeness
 * Checks if we have minimum required information
 *
 * @param {string} patientName - Patient name to validate
 * @param {number} patientId - Patient ID to validate
 * @returns {boolean} True if data is complete
 */
export function validatePatientData(patientName, patientId) {
  return !!(patientName && patientName.length > 0 && patientId && patientId > 0);
}

/**
 * Extract patient info from current page
 * Convenience function that gets both name and validates
 *
 * @param {number} patientId - Patient ID
 * @param {Object} options - Configuration
 * @param {Object} options.logger - Logger instance
 * @returns {Promise<Object>} Result {name: string, id: number, valid: boolean}
 */
export async function extractPatientInfo(patientId, options = {}) {
  const { logger = null } = options;

  try {
    const name = await getPatientName({ logger });
    const valid = validatePatientData(name, patientId);

    return {
      name,
      id: patientId,
      valid
    };

  } catch (error) {
    if (logger) {
      logger.error('Failed to extract patient info', error);
    }

    return {
      name: '',
      id: patientId,
      valid: false
    };
  }
}
