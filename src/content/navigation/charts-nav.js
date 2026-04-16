/**
 * CHARTS NAVIGATION MODULE
 *
 * Handles navigation to patient charts pages:
 * - Navigate to charts page
 * - Wait for charts to load
 * - Click "Load More" button to load all charts
 * - Detect freeze states
 */

import { TIMEOUTS, SELECTORS } from '../../shared/constants.js';
import { sleep } from '../../shared/utils/async-utils.js';
import { hasVisibleElement, getVisibleElements } from '../../shared/utils/dom-utils.js';
import { buildChartsUrl } from '../../shared/utils/url-utils.js';

/**
 * Custom error for charts navigation failures
 */
export class ChartsNavigationError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'ChartsNavigationError';
    this.cause = cause;
  }
}

/**
 * Wait for the charts page to finish loading
 * Returns true if charts loaded, false if timeout
 *
 * @param {Object} options - Configuration
 * @param {number} options.maxWaitMs - Max time to wait in ms (default: 60000)
 * @param {Function} options.shouldStop - Stop check function
 * @param {Object} options.logger - Logger instance
 * @returns {Promise<boolean>} True if charts loaded successfully
 */
export async function waitForChartsLoaded(options = {}) {
  const {
    maxWaitMs = 60000,
    shouldStop = null,
    logger = null
  } = options;

  const startTime = Date.now();

  // What we're looking for on the page
  const chartPanelSelector = 'div.panel.panel-default.chart-entry.panel-no-gap';
  const loadingSpinnerSelector = 'i.icon-spinner.text-muted.icon-spin';
  const chartsContainerSelector = '#charts, [data-test-id="charts_container"]';

  if (logger) {
    logger.debug('Waiting for charts to load');
  }

  // Keep checking until we timeout
  while (Date.now() - startTime < maxWaitMs) {
    if (shouldStop && shouldStop()) {
      throw new Error('Stopped while waiting for charts');
    }

    // Check what's on the page
    const hasChartPanels = getVisibleElements(chartPanelSelector).length > 0;
    const hasChartsContainer = hasVisibleElement(chartsContainerSelector);
    const isStillLoading = hasVisibleElement(loadingSpinnerSelector);

    // Charts are loaded if we see chart panels OR we see the container without a spinner
    const chartsAreLoaded = hasChartPanels || (hasChartsContainer && !isStillLoading);

    if (chartsAreLoaded) {
      if (logger) {
        logger.debug('Charts loaded successfully');
      }
      return true;
    }

    await sleep(500, { shouldStop }); // Wait half a second before checking again
  }

  if (logger) {
    logger.warn('Charts load timed out');
  }
  return false; // Timed out
}

/**
 * Click "Load More" button to load all charts
 * Returns count of how many times button was clicked
 *
 * @param {Object} options - Configuration
 * @param {number} options.maxClicks - Maximum times to click (default: 10)
 * @param {Function} options.shouldStop - Stop check function
 * @param {Object} options.logger - Logger instance
 * @returns {Promise<number>} Number of times "Load More" was clicked
 */
export async function loadAllCharts(options = {}) {
  const {
    maxClicks = 10,
    shouldStop = null,
    logger = null
  } = options;

  let loadMoreCount = 0;

  while (loadMoreCount < maxClicks) {
    if (shouldStop && shouldStop()) {
      throw new Error('Stopped while loading charts');
    }

    // Look for the "Load More" button
    const loadMoreButton = Array.from(document.querySelectorAll('button.btn.btn-link'))
      .find(btn => (btn.textContent || '').trim().toLowerCase() === 'load more');

    if (!loadMoreButton) {
      // No more "Load More" button, we're done
      if (logger) {
        const plural = loadMoreCount !== 1 ? 's' : '';
        logger.info(`All charts loaded (clicked ${loadMoreCount} "Load More" button${plural})`);
      }
      break;
    }

    // Click the button
    loadMoreButton.click();
    loadMoreCount++;

    if (logger) {
      logger.debug(`Clicked "Load More" button #${loadMoreCount}`);
    }

    // Wait for charts to load
    const maxWaitIterations = 10;
    for (let i = 0; i < maxWaitIterations; i++) {
      if (shouldStop && shouldStop()) {
        throw new Error('Stopped while waiting for more charts');
      }

      await sleep(1000, { shouldStop });

      // Check if the button says "Loading..."
      const loadingButton = Array.from(document.querySelectorAll('button.btn.btn-link[disabled]'))
        .find(btn => (btn.textContent || '').trim().toLowerCase().startsWith('loading'));

      if (!loadingButton) {
        // Not loading anymore, break out of wait loop
        break;
      }
    }
  }

  return loadMoreCount;
}

/**
 * Navigate to a patient's charts page and load all charts
 *
 * @param {string} clinicName - Clinic subdomain
 * @param {number} patientId - Patient ID
 * @param {Object} options - Configuration
 * @param {Function} options.shouldStop - Stop check function
 * @param {Object} options.logger - Logger instance
 * @param {Function} options.onFreeze - Callback when page freeze detected (receives {clinicName, patientId})
 * @returns {Promise<Object>} Result {success: boolean, reason?: string, paused?: boolean, loadMoreCount?: number}
 * @throws {ChartsNavigationError} If navigation fails
 */
export async function navigateToCharts(clinicName, patientId, options = {}) {
  const {
    shouldStop = null,
    logger = null,
    onFreeze = null
  } = options;

  try {
    if (logger) {
      logger.info(`Navigating to charts page for patient ${patientId}`);
    }

    // Small delay before navigation
    await sleep(TIMEOUTS.PRE_NAVIGATION_DELAY, { shouldStop });

    // Build URL and navigate
    const url = buildChartsUrl(clinicName, patientId);
    window.location.href = url;

    // Wait for Jane's single-page app to load the charts view
    await sleep(TIMEOUTS.CHARTS_PAGE_LOAD, { shouldStop });

    if (logger) {
      logger.debug('Waiting for charts to render');
    }

    const chartsLoaded = await waitForChartsLoaded({
      maxWaitMs: 40000,
      shouldStop,
      logger
    });

    // Check if there are any charts on the page
    const chartPanels = document.querySelectorAll('div.panel.panel-default.chart-entry.panel-no-gap');

    if (!chartsLoaded || chartPanels.length === 0) {
      // Check if page is marked as frozen
      try {
        const freeze = await chrome.storage.local.get('frozen');
        if (freeze && freeze.frozen) {
          if (logger) {
            logger.warn('Charts view appears frozen. Triggering freeze recovery');
          }

          // Call freeze callback if provided
          if (onFreeze) {
            await onFreeze({ clinicName, patientId });
          }

          return { success: false, paused: true, reason: 'frozen' };
        }
      } catch (error) {
        if (logger) {
          logger.error('Failed to check freeze status', error);
        }
      }

      if (!chartsLoaded) {
        if (logger) {
          logger.warn(`Charts load timed out for patient ${patientId}`);
        }
        return { success: false, reason: 'timeout' };
      }

      if (logger) {
        logger.info(`No charts found for patient ${patientId}`);
      }
      return { success: false, reason: 'no_charts' };
    }

    if (logger) {
      logger.success('Charts page loaded successfully');
    }

    // Click "Load More" button until all charts are loaded
    const loadMoreCount = await loadAllCharts({
      maxClicks: 10,
      shouldStop,
      logger
    });

    return {
      success: true,
      alreadyComplete: false,
      loadMoreCount
    };

  } catch (error) {
    if (error.message === 'Stopped' || error.message.includes('Stopped while')) {
      if (logger) {
        logger.warn('Charts navigation stopped by user');
      }
      throw error; // Re-throw stop errors
    }

    if (logger) {
      logger.error(`Failed to navigate to charts for patient ${patientId}`, error);
    }

    throw new ChartsNavigationError(
      `Failed to navigate to charts for patient ${patientId}: ${error.message}`,
      error
    );
  }
}

/**
 * Check if current page is a charts page
 *
 * @returns {boolean} True if on charts page
 */
export function isOnChartsPage() {
  try {
    const url = window.location.href;
    return url.includes('/admin') && url.includes('/charts');
  } catch (error) {
    return false;
  }
}

/**
 * Count visible charts on the page
 *
 * @returns {number} Number of chart panels found
 */
export function getVisibleChartCount() {
  try {
    return document.querySelectorAll('div.panel.panel-default.chart-entry.panel-no-gap').length;
  } catch (error) {
    return 0;
  }
}
