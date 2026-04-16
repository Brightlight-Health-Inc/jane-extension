/**
 * PATIENT NAVIGATION MODULE
 *
 * Handles navigation to patient pages in Jane App:
 * - Navigate to patient main page
 * - Wait for page to load
 * - Detect navigation errors
 */

import { TIMEOUTS } from '../../shared/constants.js';
import { sleep } from '../../shared/utils/async-utils.js';
import { buildPatientUrl } from '../../shared/utils/url-utils.js';

/**
 * Custom error for navigation failures
 */
export class NavigationError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'NavigationError';
    this.cause = cause;
  }
}

/**
 * Navigate to a patient's main page
 *
 * @param {string} clinicName - Clinic subdomain
 * @param {number} patientId - Patient ID to navigate to
 * @param {Object} options - Configuration
 * @param {Function} options.shouldStop - Function that returns true to stop navigation
 * @param {Object} options.logger - Logger instance for status updates
 * @returns {Promise<Object>} Result object {success: boolean}
 * @throws {NavigationError} If navigation fails
 */
export async function navigateToPatient(clinicName, patientId, options = {}) {
  const {
    shouldStop = null,
    logger = null
  } = options;

  try {
    if (logger) {
      logger.info(`Navigating to patient ${patientId}`);
    }

    // Small delay before navigation
    await sleep(TIMEOUTS.PRE_NAVIGATION_DELAY, { shouldStop });

    // Build patient URL and navigate
    const url = buildPatientUrl(clinicName, patientId);
    window.location.href = url;

    // Wait for page to load
    await sleep(TIMEOUTS.PATIENT_PAGE_LOAD, { shouldStop });

    if (logger) {
      logger.success(`Arrived at patient ${patientId} page`);
    }

    return { success: true };

  } catch (error) {
    if (error.message === 'Stopped' || error.message.includes('Stopped while')) {
      if (logger) {
        logger.warn('Navigation stopped by user');
      }
      throw error; // Re-throw stop errors
    }

    if (logger) {
      logger.error(`Failed to navigate to patient ${patientId}`, error);
    }

    throw new NavigationError(`Failed to navigate to patient ${patientId}: ${error.message}`, error);
  }
}

/**
 * Wait for patient page to be fully loaded
 * Checks for key elements that indicate the page is ready
 *
 * @param {Object} options - Configuration
 * @param {number} options.timeout - Max wait time in ms (default: 10000)
 * @param {Function} options.shouldStop - Stop check function
 * @returns {Promise<boolean>} True if page loaded successfully
 */
export async function waitForPatientPageLoad(options = {}) {
  const {
    timeout = TIMEOUTS.MAX_WAIT_TIME,
    shouldStop = null
  } = options;

  const startTime = Date.now();
  const patientNameSelector = '.row .col-xs-10.col-sm-11 .sensitive.text-selectable';

  while (Date.now() - startTime < timeout) {
    if (shouldStop && shouldStop()) {
      throw new Error('Stopped while waiting for patient page');
    }

    // Check if patient name element exists (indicates page loaded)
    const patientNameElement = document.querySelector(patientNameSelector);
    if (patientNameElement) {
      return true;
    }

    await sleep(500, { shouldStop });
  }

  return false; // Timed out
}

/**
 * Check if current page is a patient page
 *
 * @returns {boolean} True if on patient page
 */
export function isOnPatientPage() {
  try {
    const url = window.location.href;
    return url.includes('/admin') && url.match(/patients\/\d+/);
  } catch (error) {
    return false;
  }
}

/**
 * Get patient ID from current URL
 *
 * @returns {number|null} Patient ID or null if not on patient page
 */
export function getPatientIdFromUrl() {
  try {
    const url = window.location.href;
    const match = url.match(/patients\/(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  } catch (error) {
    return null;
  }
}
