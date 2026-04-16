/**
 * ERROR HANDLER MODULE
 *
 * Centralized error handling and recovery:
 * - Classify errors (recoverable vs fatal)
 * - Log errors with full context
 * - Determine recovery strategy
 * - Schedule recovery actions
 */

/**
 * Error severity levels
 */
export const ErrorSeverity = {
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  FATAL: 'fatal'
};

/**
 * Error categories
 */
export const ErrorCategory = {
  NETWORK: 'network',
  NAVIGATION: 'navigation',
  SCRAPING: 'scraping',
  DOWNLOAD: 'download',
  STATE: 'state',
  AUTHENTICATION: 'authentication',
  RATE_LIMIT: 'rate_limit',
  TIMEOUT: 'timeout',
  USER_STOP: 'user_stop',
  UNKNOWN: 'unknown'
};

/**
 * Error Handler class
 * Provides centralized error handling and recovery logic
 */
export class ErrorHandler {
  constructor(options = {}) {
    const {
      logger = null,
      onRecovery = null, // Callback for recovery actions
      maxRecoveryAttempts = 3
    } = options;

    this.logger = logger;
    this.onRecovery = onRecovery;
    this.maxRecoveryAttempts = maxRecoveryAttempts;
    this.errorCounts = new Map(); // Track error counts per category
  }

  /**
   * Handle an error with full context
   *
   * @param {Error} error - The error that occurred
   * @param {Object} context - Additional context about the error
   * @param {string} context.function - Function where error occurred
   * @param {string} context.action - Action being performed
   * @param {Object} context.data - Relevant data (patientId, chartId, etc.)
   * @returns {Object} Result {handled: boolean, recoverable: boolean, category: string, severity: string}
   */
  handleError(error, context = {}) {
    try {
      // Classify the error
      const classification = this.classifyError(error, context);

      // Log the error with context
      this.logError(error, context, classification);

      // Track error count
      this.trackError(classification.category);

      // Determine if recoverable
      const recoveryStrategy = this.determineRecoveryStrategy(error, context, classification);

      return {
        handled: true,
        recoverable: recoveryStrategy.recoverable,
        category: classification.category,
        severity: classification.severity,
        strategy: recoveryStrategy
      };

    } catch (handlingError) {
      // Error while handling error - log and return
      if (this.logger) {
        this.logger.error('Error handler failed', handlingError);
      }

      return {
        handled: false,
        recoverable: false,
        category: ErrorCategory.UNKNOWN,
        severity: ErrorSeverity.FATAL
      };
    }
  }

  /**
   * Classify an error into category and severity
   *
   * @param {Error} error - The error to classify
   * @param {Object} context - Error context
   * @returns {Object} Classification {category: string, severity: string}
   */
  classifyError(error, context = {}) {
    const message = error?.message || '';

    // User stopped - not really an error
    if (message.includes('Stopped') || message.includes('stopped')) {
      return {
        category: ErrorCategory.USER_STOP,
        severity: ErrorSeverity.INFO
      };
    }

    // Rate limit
    if (message.includes('rate limit') || message.includes('too many requests')) {
      return {
        category: ErrorCategory.RATE_LIMIT,
        severity: ErrorSeverity.WARNING
      };
    }

    // Timeout
    if (message.includes('timeout') || message.includes('timed out')) {
      return {
        category: ErrorCategory.TIMEOUT,
        severity: ErrorSeverity.WARNING
      };
    }

    // Network errors
    if (message.includes('fetch') || message.includes('network') ||
        message.includes('HTTP') || message.includes('connection')) {
      return {
        category: ErrorCategory.NETWORK,
        severity: ErrorSeverity.ERROR
      };
    }

    // Navigation errors
    if (message.includes('navigate') || message.includes('navigation') ||
        context.function?.includes('navigate')) {
      return {
        category: ErrorCategory.NAVIGATION,
        severity: ErrorSeverity.ERROR
      };
    }

    // Scraping errors
    if (message.includes('extract') || message.includes('scraping') ||
        context.function?.includes('extract') || context.function?.includes('scrape')) {
      return {
        category: ErrorCategory.SCRAPING,
        severity: ErrorSeverity.ERROR
      };
    }

    // Download errors
    if (message.includes('download') || message.includes('PDF') ||
        context.function?.includes('download')) {
      return {
        category: ErrorCategory.DOWNLOAD,
        severity: ErrorSeverity.ERROR
      };
    }

    // Authentication errors
    if (message.includes('login') || message.includes('auth') ||
        message.includes('credential')) {
      return {
        category: ErrorCategory.AUTHENTICATION,
        severity: ErrorSeverity.FATAL
      };
    }

    // State errors
    if (message.includes('state') || message.includes('storage')) {
      return {
        category: ErrorCategory.STATE,
        severity: ErrorSeverity.ERROR
      };
    }

    // Unknown
    return {
      category: ErrorCategory.UNKNOWN,
      severity: ErrorSeverity.ERROR
    };
  }

  /**
   * Log error with full context
   *
   * @param {Error} error - The error
   * @param {Object} context - Error context
   * @param {Object} classification - Error classification
   */
  logError(error, context, classification) {
    if (!this.logger) return;

    const logData = {
      message: error?.message || 'Unknown error',
      category: classification.category,
      severity: classification.severity,
      function: context.function,
      action: context.action,
      data: context.data,
      stack: error?.stack
    };

    switch (classification.severity) {
      case ErrorSeverity.INFO:
        this.logger.info(`${context.function || 'Unknown'}: ${error.message}`, logData);
        break;
      case ErrorSeverity.WARNING:
        this.logger.warn(`${context.function || 'Unknown'}: ${error.message}`, logData);
        break;
      case ErrorSeverity.ERROR:
        this.logger.error(`${context.function || 'Unknown'}: ${error.message}`, error);
        break;
      case ErrorSeverity.FATAL:
        this.logger.error(`FATAL - ${context.function || 'Unknown'}: ${error.message}`, error);
        break;
    }
  }

  /**
   * Track error occurrence
   *
   * @param {string} category - Error category
   */
  trackError(category) {
    const count = this.errorCounts.get(category) || 0;
    this.errorCounts.set(category, count + 1);
  }

  /**
   * Get error count for a category
   *
   * @param {string} category - Error category
   * @returns {number} Error count
   */
  getErrorCount(category) {
    return this.errorCounts.get(category) || 0;
  }

  /**
   * Reset error counts
   */
  resetErrorCounts() {
    this.errorCounts.clear();
  }

  /**
   * Determine recovery strategy for an error
   *
   * @param {Error} error - The error
   * @param {Object} context - Error context
   * @param {Object} classification - Error classification
   * @returns {Object} Recovery strategy
   */
  determineRecoveryStrategy(error, context, classification) {
    const errorCount = this.getErrorCount(classification.category);

    // User stopped - no recovery needed
    if (classification.category === ErrorCategory.USER_STOP) {
      return {
        recoverable: false,
        action: 'stop',
        reason: 'User stopped operation'
      };
    }

    // Fatal errors - no recovery
    if (classification.severity === ErrorSeverity.FATAL) {
      return {
        recoverable: false,
        action: 'fail',
        reason: 'Fatal error, cannot recover'
      };
    }

    // Too many errors in this category - give up
    if (errorCount >= this.maxRecoveryAttempts) {
      return {
        recoverable: false,
        action: 'fail',
        reason: `Too many ${classification.category} errors (${errorCount}/${this.maxRecoveryAttempts})`
      };
    }

    // Rate limit - pause and retry
    if (classification.category === ErrorCategory.RATE_LIMIT) {
      return {
        recoverable: true,
        action: 'pause_and_retry',
        pauseDuration: 60000, // 60 seconds
        reason: 'Rate limit detected'
      };
    }

    // Timeout - retry with backoff
    if (classification.category === ErrorCategory.TIMEOUT) {
      return {
        recoverable: true,
        action: 'retry_with_backoff',
        reason: 'Timeout, will retry'
      };
    }

    // Network errors - retry with backoff
    if (classification.category === ErrorCategory.NETWORK) {
      return {
        recoverable: true,
        action: 'retry_with_backoff',
        reason: 'Network error, will retry'
      };
    }

    // Navigation errors - retry navigation
    if (classification.category === ErrorCategory.NAVIGATION) {
      return {
        recoverable: true,
        action: 'retry_navigation',
        reason: 'Navigation failed, will retry'
      };
    }

    // Scraping errors - might be patient-specific, skip patient
    if (classification.category === ErrorCategory.SCRAPING) {
      return {
        recoverable: true,
        action: 'skip_item',
        reason: 'Scraping failed, skipping item'
      };
    }

    // Download errors - retry download
    if (classification.category === ErrorCategory.DOWNLOAD) {
      return {
        recoverable: true,
        action: 'retry_download',
        reason: 'Download failed, will retry'
      };
    }

    // Default - retry
    return {
      recoverable: true,
      action: 'retry',
      reason: 'Recoverable error, will retry'
    };
  }

  /**
   * Convenience method for handling errors with automatic logging
   *
   * @param {Function} fn - Function to wrap
   * @param {Object} context - Error context
   * @returns {Function} Wrapped function
   */
  wrap(fn, context = {}) {
    return async (...args) => {
      try {
        return await fn(...args);
      } catch (error) {
        const result = this.handleError(error, context);

        // Re-throw if not recoverable
        if (!result.recoverable) {
          throw error;
        }

        // Call recovery callback if provided
        if (this.onRecovery && result.strategy) {
          await this.onRecovery(error, result.strategy, context);
        }

        // Re-throw to let caller decide
        throw error;
      }
    };
  }
}

/**
 * Convenience function to create an error handler
 *
 * @param {Object} options - Configuration options
 * @returns {ErrorHandler} Error handler instance
 */
export function createErrorHandler(options = {}) {
  return new ErrorHandler(options);
}
