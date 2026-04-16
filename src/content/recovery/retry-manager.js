/**
 * RETRY MANAGER MODULE
 *
 * Handles retry logic with exponential backoff:
 * - Configurable retry limits
 * - Exponential backoff with jitter
 * - Per-operation retry tracking
 * - Success/failure callbacks
 */

import { RETRY } from '../../shared/constants.js';
import { sleep } from '../../shared/utils/async-utils.js';

/**
 * Retry Manager class
 * Manages retry attempts with exponential backoff
 */
export class RetryManager {
  constructor(options = {}) {
    const {
      logger = null,
      maxRetries = RETRY.DEFAULT_MAX_RETRIES,
      baseDelay = RETRY.BASE_DELAY_MS,
      maxDelay = RETRY.MAX_DELAY_MS,
      onRetry = null, // Callback before each retry
      onSuccess = null, // Callback on success
      onFailure = null // Callback on final failure
    } = options;

    this.logger = logger;
    this.maxRetries = maxRetries;
    this.baseDelay = baseDelay;
    this.maxDelay = maxDelay;
    this.onRetry = onRetry;
    this.onSuccess = onSuccess;
    this.onFailure = onFailure;

    // Track retry attempts per operation
    this.retryAttempts = new Map();
  }

  /**
   * Execute an operation with retry logic
   *
   * @param {Function} operation - Async function to execute
   * @param {Object} options - Configuration
   * @param {string} options.operationId - Unique identifier for tracking
   * @param {Function} options.shouldStop - Function that returns true to stop
   * @param {Object} options.context - Additional context for logging
   * @param {number} options.maxRetries - Override max retries
   * @returns {Promise<any>} Result of operation
   * @throws {Error} Last error if all retries exhausted
   */
  async execute(operation, options = {}) {
    const {
      operationId = null,
      shouldStop = null,
      context = {},
      maxRetries = this.maxRetries
    } = options;

    let lastError;
    const attempts = [];

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // Check if we should stop
      if (shouldStop && shouldStop()) {
        throw new Error('Stopped during retry');
      }

      try {
        // Execute the operation
        const result = await operation(attempt);

        // Success! Track and return
        if (operationId) {
          this.trackSuccess(operationId, attempt, attempts);
        }

        if (this.onSuccess) {
          await this.onSuccess(result, {
            attempt,
            operationId,
            context
          });
        }

        return result;

      } catch (error) {
        lastError = error;
        attempts.push({
          attempt,
          error: error.message,
          timestamp: Date.now()
        });

        // If this was the last attempt, fail
        if (attempt >= maxRetries) {
          if (operationId) {
            this.trackFailure(operationId, maxRetries, attempts);
          }

          if (this.onFailure) {
            await this.onFailure(error, {
              attempts: maxRetries,
              operationId,
              context
            });
          }

          if (this.logger) {
            this.logger.error(
              `Operation failed after ${maxRetries} attempts`,
              { error, operationId, context, attempts }
            );
          }

          throw error;
        }

        // Calculate exponential backoff with jitter
        const delay = this.calculateDelay(attempt);

        // Log retry attempt
        if (this.logger) {
          this.logger.warn(
            `Retry ${attempt}/${maxRetries} after ${delay}ms: ${error.message}`,
            { operationId, context }
          );
        }

        // Call retry callback if provided
        if (this.onRetry) {
          await this.onRetry(error, {
            attempt,
            maxRetries,
            delay,
            operationId,
            context
          });
        }

        // Wait before retrying
        await sleep(delay, { shouldStop });
      }
    }

    // This should never be reached, but just in case
    throw lastError;
  }

  /**
   * Calculate delay for retry attempt
   * Uses exponential backoff with jitter
   *
   * @param {number} attempt - Current attempt number (1-based)
   * @returns {number} Delay in milliseconds
   */
  calculateDelay(attempt) {
    // Exponential backoff: baseDelay * 2^(attempt - 1)
    const exponentialDelay = this.baseDelay * Math.pow(2, attempt - 1);

    // Add jitter (0-1000ms)
    const jitter = Math.random() * 1000;

    // Cap at maxDelay
    return Math.min(exponentialDelay + jitter, this.maxDelay);
  }

  /**
   * Track successful operation
   *
   * @param {string} operationId - Operation identifier
   * @param {number} attempts - Number of attempts taken
   * @param {Array} attemptHistory - History of attempts
   */
  trackSuccess(operationId, attempts, attemptHistory) {
    this.retryAttempts.set(operationId, {
      success: true,
      attempts,
      history: attemptHistory,
      timestamp: Date.now()
    });

    if (this.logger && attempts > 1) {
      this.logger.info(`Operation succeeded on attempt ${attempts}/${attempts}`, {
        operationId
      });
    }
  }

  /**
   * Track failed operation
   *
   * @param {string} operationId - Operation identifier
   * @param {number} maxAttempts - Max attempts allowed
   * @param {Array} attemptHistory - History of attempts
   */
  trackFailure(operationId, maxAttempts, attemptHistory) {
    this.retryAttempts.set(operationId, {
      success: false,
      attempts: maxAttempts,
      history: attemptHistory,
      timestamp: Date.now()
    });
  }

  /**
   * Get retry statistics for an operation
   *
   * @param {string} operationId - Operation identifier
   * @returns {Object|null} Statistics or null if not found
   */
  getStats(operationId) {
    return this.retryAttempts.get(operationId) || null;
  }

  /**
   * Clear retry tracking for an operation
   *
   * @param {string} operationId - Operation identifier
   */
  clearStats(operationId) {
    this.retryAttempts.delete(operationId);
  }

  /**
   * Clear all retry tracking
   */
  clearAllStats() {
    this.retryAttempts.clear();
  }

  /**
   * Get total number of tracked operations
   *
   * @returns {number} Count
   */
  getTrackedCount() {
    return this.retryAttempts.size;
  }

  /**
   * Get success rate across all operations
   *
   * @returns {number} Success rate (0-1)
   */
  getSuccessRate() {
    if (this.retryAttempts.size === 0) return 0;

    let successCount = 0;
    for (const [, stats] of this.retryAttempts) {
      if (stats.success) successCount++;
    }

    return successCount / this.retryAttempts.size;
  }
}

/**
 * Convenience function to execute with retry
 * Simplified API for one-off retries
 *
 * @param {Function} operation - Async function to execute
 * @param {Object} options - Configuration options
 * @returns {Promise<any>} Result of operation
 */
export async function executeWithRetry(operation, options = {}) {
  const retryManager = new RetryManager(options);
  return await retryManager.execute(operation, options);
}

/**
 * Create a retry manager with preset configuration
 *
 * @param {string} preset - Preset name ('patient', 'charts', 'download', 'default')
 * @param {Object} options - Additional options to override
 * @returns {RetryManager} Configured retry manager
 */
export function createRetryManager(preset = 'default', options = {}) {
  const presets = {
    patient: {
      maxRetries: RETRY.PATIENT_CHECK_MAX_RETRIES,
      baseDelay: 2000,
      maxDelay: 10000
    },
    charts: {
      maxRetries: RETRY.CHARTS_CHECK_MAX_RETRIES,
      baseDelay: 2000,
      maxDelay: 10000
    },
    download: {
      maxRetries: RETRY.DEFAULT_MAX_RETRIES,
      baseDelay: 1000,
      maxDelay: 5000
    },
    default: {
      maxRetries: RETRY.DEFAULT_MAX_RETRIES,
      baseDelay: RETRY.BASE_DELAY_MS,
      maxDelay: RETRY.MAX_DELAY_MS
    }
  };

  const presetConfig = presets[preset] || presets.default;
  return new RetryManager({ ...presetConfig, ...options });
}
