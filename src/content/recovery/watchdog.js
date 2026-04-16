/**
 * WATCHDOG MODULE
 *
 * Monitors thread activity and recovers from idle/frozen states:
 * - Tracks heartbeat timestamps
 * - Detects idle threads (no activity for N seconds)
 * - Detects frozen pages
 * - Forces recovery navigation when needed
 */

import { TIMEOUTS } from '../../shared/constants.js';

/**
 * Watchdog class
 * Monitors thread activity and triggers recovery
 */
export class Watchdog {
  constructor(options = {}) {
    const {
      logger = null,
      getThreadKey = null, // Function to get thread-scoped storage key
      idleThreshold = 120000, // 2 minutes
      checkInterval = 15000, // 15 seconds
      onIdle = null, // Callback when idle detected
      onFrozen = null // Callback when frozen detected
    } = options;

    this.logger = logger;
    this.getThreadKey = getThreadKey;
    this.idleThreshold = idleThreshold;
    this.checkInterval = checkInterval;
    this.onIdle = onIdle;
    this.onFrozen = onFrozen;

    this.timerId = null;
    this.isRunning = false;
  }

  /**
   * Start watchdog monitoring
   */
  start() {
    if (this.isRunning) {
      if (this.logger) {
        this.logger.warn('Watchdog already running');
      }
      return;
    }

    this.isRunning = true;

    if (this.logger) {
      this.logger.info(`Watchdog started (idle threshold: ${this.idleThreshold}ms, check interval: ${this.checkInterval}ms)`);
    }

    // Start periodic checks
    this.scheduleCheck();
  }

  /**
   * Stop watchdog monitoring
   */
  stop() {
    if (!this.isRunning) return;

    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }

    this.isRunning = false;

    if (this.logger) {
      this.logger.info('Watchdog stopped');
    }
  }

  /**
   * Schedule next watchdog check
   */
  scheduleCheck() {
    if (!this.isRunning) return;

    this.timerId = setTimeout(async () => {
      await this.check();
      this.scheduleCheck(); // Schedule next check
    }, this.checkInterval);
  }

  /**
   * Perform watchdog check
   */
  async check() {
    if (!this.isRunning) return;

    try {
      // Get heartbeat and freeze status
      const heartbeatKey = this.getThreadKey ? this.getThreadKey('lastHeartbeat') : 'lastHeartbeat';

      const storage = await chrome.storage.local.get([heartbeatKey, 'frozen']);
      const lastHeartbeat = Number(storage[heartbeatKey] || 0);
      const isFrozen = !!storage.frozen;
      const idleMs = Date.now() - lastHeartbeat;

      // Check for frozen state
      if (isFrozen) {
        if (this.logger) {
          this.logger.warn('Watchdog detected frozen state');
        }

        if (this.onFrozen) {
          await this.onFrozen({ idleMs });
        } else {
          // Default recovery: refresh current URL
          await this.recoverFromFreeze();
        }

        return;
      }

      // Check for idle thread
      if (lastHeartbeat > 0 && idleMs > this.idleThreshold) {
        if (this.logger) {
          this.logger.warn(`Watchdog detected idle thread (${Math.round(idleMs / 1000)}s)`);
        }

        if (this.onIdle) {
          await this.onIdle({ idleMs });
        } else {
          // Default recovery: refresh current URL
          await this.recoverFromIdle(idleMs);
        }

        return;
      }

      // Everything is fine
      if (this.logger && lastHeartbeat > 0) {
        this.logger.debug(`Watchdog check OK (idle: ${Math.round(idleMs / 1000)}s)`);
      }

    } catch (error) {
      if (this.logger) {
        this.logger.error('Watchdog check failed', error);
      }
    }
  }

  /**
   * Recover from idle state
   * Default recovery: refresh current URL to restart scraping
   *
   * @param {number} idleMs - How long thread has been idle
   */
  async recoverFromIdle(idleMs) {
    try {
      if (this.logger) {
        this.logger.warn(`Recovering from idle state (${Math.round(idleMs / 1000)}s)`);
      }

      // Use reload() — hash-based URLs don't navigate when set to the same value
      window.location.reload();

    } catch (error) {
      if (this.logger) {
        this.logger.error('Failed to recover from idle', error);
      }
    }
  }

  /**
   * Recover from frozen state
   * Default recovery: reload page
   */
  async recoverFromFreeze() {
    try {
      if (this.logger) {
        this.logger.warn('Recovering from frozen state');
      }

      // Clear frozen flag
      try {
        await chrome.storage.local.set({ frozen: false });
      } catch (error) {
        if (this.logger) {
          this.logger.error('Failed to clear frozen flag', error);
        }
      }

      // Use reload() — hash-based URLs don't navigate when set to the same value
      window.location.reload();

    } catch (error) {
      if (this.logger) {
        this.logger.error('Failed to recover from freeze', error);
      }
    }
  }

  /**
   * Update heartbeat timestamp
   * Call this regularly during normal operation to show thread is alive
   */
  async updateHeartbeat() {
    try {
      const heartbeatKey = this.getThreadKey ? this.getThreadKey('lastHeartbeat') : 'lastHeartbeat';
      await chrome.storage.local.set({
        [heartbeatKey]: Date.now()
      });
    } catch (error) {
      if (this.logger) {
        this.logger.error('Failed to update heartbeat', error);
      }
    }
  }

  /**
   * Check if watchdog is running
   *
   * @returns {boolean} True if running
   */
  isActive() {
    return this.isRunning;
  }
}

/**
 * Create and start a watchdog
 * Convenience function for one-step setup
 *
 * @param {Object} options - Watchdog options
 * @returns {Watchdog} Running watchdog instance
 */
export function createAndStartWatchdog(options = {}) {
  const watchdog = new Watchdog(options);
  watchdog.start();
  return watchdog;
}

/**
 * Legacy watchdog implementation
 * Maintains backward compatibility with existing code
 *
 * @param {Object} options - Configuration
 * @param {Function} options.getThreadKey - Function to get thread-scoped key
 * @param {Function} options.getClinicNameFromUrl - Function to get clinic name
 * @param {Function} options.setShouldStop - Function to update shouldStop flag
 * @returns {Object} Watchdog control object
 */
export function startLegacyWatchdog(options = {}) {
  const {
    getThreadKey = null,
    getClinicNameFromUrl = null,
    setShouldStop = null
  } = options;

  let timerId = null;

  const check = async () => {
    try {
      const heartbeatKey = getThreadKey ? getThreadKey('lastHeartbeat') : 'lastHeartbeat';
      const nowWrap = await chrome.storage.local.get([heartbeatKey, 'frozen']);
      const last = Number(nowWrap[heartbeatKey] || 0);
      const frozen = !!nowWrap.frozen;
      const idleMs = Date.now() - last;

      // If no heartbeat for > 120s or page marked frozen, force reload
      if (idleMs > 120000 || frozen) {
        const clinic = getClinicNameFromUrl ? getClinicNameFromUrl() : null;
        if (clinic) {
          // Clear shouldStop to allow resumption after reload
          if (setShouldStop) {
            setShouldStop(false);
          }

          // Clear freeze flag before reload
          try { await chrome.storage.local.set({ frozen: false }); } catch (_) {}

          // Use reload() — hash-based URLs don't navigate when set to the same value
          window.location.reload();
          return; // Stop further checks; page is reloading
        }
      }
    } catch (error) {
      // Silent error for backward compatibility
    }

    // Schedule next check
    timerId = setTimeout(check, 15000);
  };

  // Start first check
  timerId = setTimeout(check, 15000);

  return {
    stop: () => {
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
    }
  };
}
