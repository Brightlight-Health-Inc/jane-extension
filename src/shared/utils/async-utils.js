/**
 * ASYNC UTILITIES
 *
 * Common async/await helpers:
 * - sleep: Promise-based delays
 * - sleepJitter: Random delays for human-like behavior
 * - cancelAllTimeouts: Clean up pending timeouts
 * - waitForElement: Wait for DOM element to appear
 */

/**
 * Sleep for specified milliseconds
 * Can be interrupted by checking shouldStop flag
 *
 * @param {number} milliseconds - Time to sleep in ms
 * @param {Object} options - Optional configuration
 * @param {Function} options.shouldStop - Function that returns true to interrupt sleep
 * @returns {Promise<void>}
 * @throws {Error} If shouldStop returns true
 */
export function sleep(milliseconds, options = {}) {
  return new Promise((resolve, reject) => {
    // If shouldStop check is provided and returns true, reject immediately
    if (options.shouldStop && options.shouldStop()) {
      reject(new Error('Stopped'));
      return;
    }

    const timeout = setTimeout(() => {
      resolve();
    }, milliseconds);

    // If tracking timeouts, add to array
    if (options.trackTimeout && typeof options.trackTimeout === 'function') {
      options.trackTimeout(timeout);
    }
  });
}

/**
 * Sleep for random time between minMs and maxMs
 * Useful for simulating human-like behavior and avoiding patterns
 *
 * @param {number} minMs - Minimum time to sleep in ms
 * @param {number} maxMs - Maximum time to sleep in ms
 * @param {Object} options - Optional configuration (passed to sleep)
 * @returns {Promise<void>}
 */
export function sleepJitter(minMs, maxMs, options = {}) {
  const min = Math.max(0, Number(minMs) || 0);
  const max = Math.max(min, Number(maxMs) || min);
  const duration = min + Math.floor(Math.random() * (max - min + 1));
  return sleep(duration, options);
}

/**
 * TimeoutManager class for tracking and canceling timeouts
 */
export class TimeoutManager {
  constructor() {
    this.activeTimeouts = [];
  }

  /**
   * Track a timeout so it can be canceled later
   */
  track(timeout) {
    this.activeTimeouts.push(timeout);
  }

  /**
   * Cancel all tracked timeouts
   */
  cancelAll() {
    this.activeTimeouts.forEach(timeout => clearTimeout(timeout));
    this.activeTimeouts = [];
  }

  /**
   * Get count of active timeouts
   */
  getCount() {
    return this.activeTimeouts.length;
  }
}

/**
 * Wait for a DOM element to appear
 *
 * @param {string} selector - CSS selector
 * @param {Object} options - Configuration
 * @param {number} options.timeout - Max time to wait in ms (default: 10000)
 * @param {number} options.pollInterval - How often to check in ms (default: 100)
 * @param {Function} options.shouldStop - Function that returns true to stop waiting
 * @returns {Promise<Element>} The element when found
 * @throws {Error} If timeout or shouldStop
 */
export async function waitForElement(selector, options = {}) {
  const {
    timeout = 10000,
    pollInterval = 100,
    shouldStop = null
  } = options;

  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    // Check if we should stop
    if (shouldStop && shouldStop()) {
      throw new Error('Stopped while waiting for element');
    }

    // Check if element exists
    const element = document.querySelector(selector);
    if (element) {
      return element;
    }

    // Wait before checking again
    await sleep(pollInterval, { shouldStop });
  }

  throw new Error(`Timeout waiting for element: ${selector}`);
}

/**
 * Wait for a condition to be true
 *
 * @param {Function} condition - Function that returns true when condition is met
 * @param {Object} options - Configuration
 * @param {number} options.timeout - Max time to wait in ms (default: 10000)
 * @param {number} options.pollInterval - How often to check in ms (default: 100)
 * @param {Function} options.shouldStop - Function that returns true to stop waiting
 * @returns {Promise<void>}
 * @throws {Error} If timeout or shouldStop
 */
export async function waitForCondition(condition, options = {}) {
  const {
    timeout = 10000,
    pollInterval = 100,
    shouldStop = null
  } = options;

  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    // Check if we should stop
    if (shouldStop && shouldStop()) {
      throw new Error('Stopped while waiting for condition');
    }

    // Check condition
    if (await condition()) {
      return;
    }

    // Wait before checking again
    await sleep(pollInterval, { shouldStop });
  }

  throw new Error('Timeout waiting for condition');
}

/**
 * Wait for multiple elements to appear
 *
 * @param {string[]} selectors - Array of CSS selectors
 * @param {Object} options - Configuration (same as waitForElement)
 * @returns {Promise<Element[]>} Array of elements when all found
 */
export async function waitForElements(selectors, options = {}) {
  const elements = await Promise.all(
    selectors.map(selector => waitForElement(selector, options))
  );
  return elements;
}

/**
 * Retry an operation with exponential backoff
 *
 * @param {Function} operation - Async function to retry
 * @param {Object} options - Configuration
 * @param {number} options.maxRetries - Maximum retry attempts (default: 3)
 * @param {number} options.baseDelay - Base delay in ms (default: 1000)
 * @param {number} options.maxDelay - Max delay in ms (default: 10000)
 * @param {Function} options.shouldStop - Function that returns true to stop retrying
 * @param {Function} options.onRetry - Callback(attempt, delay, error) called before each retry
 * @returns {Promise<any>} Result of operation
 * @throws {Error} Last error if all retries exhausted
 */
export async function retryWithBackoff(operation, options = {}) {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 10000,
    shouldStop = null,
    onRetry = null
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Check if we should stop
    if (shouldStop && shouldStop()) {
      throw new Error('Stopped during retry');
    }

    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;

      // If this was the last attempt, throw the error
      if (attempt >= maxRetries) {
        throw error;
      }

      // Calculate exponential backoff with jitter
      const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);
      const jitter = Math.random() * 1000; // 0-1000ms jitter
      const delay = Math.min(exponentialDelay + jitter, maxDelay);

      // Call retry callback if provided
      if (onRetry) {
        onRetry(attempt, delay, error);
      }

      // Wait before retrying
      await sleep(delay, { shouldStop });
    }
  }

  // This should never be reached, but just in case
  throw lastError;
}

/**
 * Create a promise that resolves after a timeout
 * Useful for adding timeouts to other promises
 *
 * @param {number} ms - Timeout in milliseconds
 * @param {string} message - Error message for timeout
 * @returns {Promise<never>} Promise that rejects after timeout
 */
export function timeout(ms, message = 'Operation timed out') {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

/**
 * Add a timeout to a promise
 *
 * @param {Promise} promise - Promise to add timeout to
 * @param {number} ms - Timeout in milliseconds
 * @param {string} message - Error message for timeout
 * @returns {Promise<any>} Original promise result or timeout error
 */
export function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    timeout(ms, message)
  ]);
}
