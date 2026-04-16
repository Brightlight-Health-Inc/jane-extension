/**
 * LOGGER
 *
 * Centralized logging system with:
 * - Thread-aware logging (includes threadId in all messages)
 * - Multiple log levels (debug, info, success, warn, error)
 * - Automatic status updates to side panel
 * - Proper error formatting with stack traces
 */

/**
 * Logger class for thread-aware logging
 */
export class Logger {
  constructor(options = {}) {
    this.threadId = options.threadId || null;
    this.context = options.context || {};
    this.enableConsole = options.enableConsole !== false; // Default: true
    this.enablePanel = options.enablePanel !== false;     // Default: true
    this.minConsoleLevel = options.minConsoleLevel || 'error';
    this.minPanelLevel = options.minPanelLevel || 'info';
  }

  _levelValue(level) {
    switch ((level || '').toLowerCase()) {
      case 'debug': return 10;
      case 'info': return 20;
      case 'success': return 25;
      case 'warn':
      case 'warning': return 30;
      case 'error': return 40;
      default: return 20;
    }
  }

  _shouldEmit(level, target) {
    if (target === 'console' && !this.enableConsole) return false;
    if (target === 'panel' && !this.enablePanel) return false;

    const threshold = target === 'console' ? this.minConsoleLevel : this.minPanelLevel;
    return this._levelValue(level) >= this._levelValue(threshold);
  }

  _withPrefix(prefix, message) {
    const text = String(message || '');
    return /^[✅⚠️❌]/.test(text) ? text : `${prefix} ${text}`;
  }

  /**
   * Set the thread ID for this logger
   */
  setThreadId(threadId) {
    this.threadId = threadId;
  }

  /**
   * Set additional context that will be included in all logs
   */
  setContext(context) {
    this.context = { ...this.context, ...context };
  }

  /**
   * Format a message with timestamp and thread prefix
   */
  _formatMessage(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const threadPrefix = this.threadId ? `[${this.threadId}] ` : '';

    let formatted = `${timestamp} [${level}] ${threadPrefix}${message}`;

    if (data) {
      if (typeof data === 'object') {
        // Pretty-print objects
        formatted += '\n' + JSON.stringify(data, null, 2);
      } else {
        formatted += ` ${data}`;
      }
    }

    return formatted;
  }

  /**
   * Send status message to side panel
   */
  _sendToPanel(message, type) {
    if (!this._shouldEmit(type, 'panel')) return;

    try {
      chrome.runtime.sendMessage({
        action: 'statusUpdate',
        status: {
          message,
          type,
          threadId: this.threadId
        }
      });
    } catch (error) {
      // If we can't send to panel, log to console instead
      if (this.enableConsole) {
        console.error('Failed to send status to panel:', error);
      }
    }
  }

  /**
   * Update heartbeat timestamp (for watchdog)
   */
  async _updateHeartbeat() {
    if (!this.threadId) return;

    try {
      const key = `${this.threadId}_lastHeartbeat`;
      await chrome.storage.local.set({ [key]: Date.now() });
    } catch (error) {
      // Silently fail heartbeat updates (not critical)
      if (this._shouldEmit('warn', 'console')) {
        console.warn('Failed to update heartbeat:', error);
      }
    }
  }

  /**
   * Log debug message (console only, not sent to panel)
   */
  debug(message, data = null) {
    if (!this._shouldEmit('debug', 'console')) return;

    const formatted = this._formatMessage('DEBUG', message, data);
    console.debug(formatted);
  }

  /**
   * Log info message
   */
  info(message, data = null) {
    const formatted = this._formatMessage('INFO', message, data);

    if (this._shouldEmit('info', 'console')) {
      console.log(formatted);
    }

    // Send to panel without emoji (will be plain text)
    this._sendToPanel(message, 'info');

    // Update heartbeat
    this._updateHeartbeat();
  }

  /**
   * Log success message
   */
  success(message, data = null) {
    const formatted = this._formatMessage('SUCCESS', message, data);

    if (this._shouldEmit('success', 'console')) {
      console.log(formatted);
    }

    // Send to panel with success emoji
    this._sendToPanel(this._withPrefix('✅', message), 'success');

    // Update heartbeat
    this._updateHeartbeat();
  }

  /**
   * Log warning message
   */
  warn(message, data = null) {
    const formatted = this._formatMessage('WARN', message, data);

    if (this._shouldEmit('warn', 'console')) {
      console.warn(formatted);
    }

    // Send to panel with warning emoji
    this._sendToPanel(this._withPrefix('⚠️', message), 'warning');

    // Update heartbeat
    this._updateHeartbeat();
  }

  /**
   * Log error message with optional Error object
   */
  error(message, error = null) {
    let data = null;

    // If error is an Error object, extract its details
    if (error instanceof Error) {
      data = {
        message: error.message,
        stack: error.stack,
        name: error.name,
        cause: error.cause
      };
    } else if (error) {
      data = error;
    }

    const formatted = this._formatMessage('ERROR', message, data);

    if (this._shouldEmit('error', 'console')) {
      console.error(formatted);
    }

    // Send to panel with error emoji
    this._sendToPanel(this._withPrefix('❌', message), 'error');

    // Update heartbeat
    this._updateHeartbeat();
  }

  /**
   * Log with custom emoji
   */
  custom(emoji, message, type = 'info', data = null) {
    const formatted = this._formatMessage(type.toUpperCase(), message, data);

    if (this._shouldEmit(type, 'console')) {
      console.log(formatted);
    }

    // Send to panel with custom emoji
    this._sendToPanel(`${emoji} ${message}`, type);

    // Update heartbeat
    this._updateHeartbeat();
  }
}

/**
 * Create a logger instance
 * @param {Object} options - Logger options
 * @param {string} options.threadId - Thread ID for namespacing
 * @param {Object} options.context - Additional context to include
 * @returns {Logger} Logger instance
 */
export function createLogger(options = {}) {
  return new Logger(options);
}

/**
 * Default logger instance (no thread context)
 */
export const logger = new Logger();
