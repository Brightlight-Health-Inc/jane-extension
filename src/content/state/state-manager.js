/**
 * STATE MANAGER
 *
 * Centralized state management for the Jane scraper.
 * Wraps chrome.storage.local with:
 * - Thread-scoped state isolation (auto-namespaces keys with threadId)
 * - Proper error handling (no more silent failures)
 * - Type-safe helpers for common state operations
 * - Single source of truth for all state access
 */

import { STORAGE_KEYS } from '../../shared/constants.js';

/**
 * Custom error class for state operations
 */
export class StateError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'StateError';
    this.cause = cause;
  }
}

/**
 * StateManager class - centralized chrome.storage.local wrapper
 */
export class StateManager {
  /**
   * @param {Function} getThreadId - Function that returns current threadId (e.g., "T1", "T2")
   */
  constructor(getThreadId) {
    if (typeof getThreadId !== 'function') {
      throw new Error('StateManager requires getThreadId function');
    }
    this.getThreadId = getThreadId;
  }

  // ============================================================================
  // THREAD-SCOPED HELPERS
  // ============================================================================

  /**
   * Get storage key with thread namespace
   * @param {string} key - Base key name
   * @returns {string} Namespaced key (e.g., "T1_scrapingState")
   */
  getThreadKey(key) {
    const threadId = this.getThreadId();
    return threadId ? `${threadId}_${key}` : key;
  }

  /**
   * Get thread-scoped value from storage
   * @param {string} key - Base key name (will be auto-namespaced)
   * @returns {Promise<any>} Value from storage
   * @throws {StateError} If read fails
   */
  async getThreadScoped(key) {
    try {
      const scopedKey = this.getThreadKey(key);
      const result = await chrome.storage.local.get([scopedKey]);
      return result[scopedKey];
    } catch (error) {
      console.error(`Failed to get thread-scoped state for key "${key}":`, error);
      throw new StateError(`Failed to get thread-scoped key: ${key}`, error);
    }
  }

  /**
   * Set thread-scoped value in storage
   * @param {string} key - Base key name (will be auto-namespaced)
   * @param {any} value - Value to store
   * @throws {StateError} If write fails
   */
  async setThreadScoped(key, value) {
    try {
      const scopedKey = this.getThreadKey(key);
      await chrome.storage.local.set({ [scopedKey]: value });
    } catch (error) {
      console.error(`Failed to set thread-scoped state for key "${key}":`, error);
      throw new StateError(`Failed to set thread-scoped key: ${key}`, error);
    }
  }

  /**
   * Remove thread-scoped value from storage
   * @param {string} key - Base key name (will be auto-namespaced)
   * @throws {StateError} If removal fails
   */
  async removeThreadScoped(key) {
    try {
      const scopedKey = this.getThreadKey(key);
      await chrome.storage.local.remove([scopedKey]);
    } catch (error) {
      console.error(`Failed to remove thread-scoped state for key "${key}":`, error);
      throw new StateError(`Failed to remove thread-scoped key: ${key}`, error);
    }
  }

  // ============================================================================
  // GLOBAL STATE HELPERS (not namespaced)
  // ============================================================================

  /**
   * Get global (non-thread-scoped) values from storage
   * @param {string|string[]} keys - Key or array of keys to retrieve
   * @returns {Promise<Object>} Object with key-value pairs
   * @throws {StateError} If read fails
   */
  async getGlobal(keys) {
    try {
      const keysArray = Array.isArray(keys) ? keys : [keys];
      const result = await chrome.storage.local.get(keysArray);
      return result;
    } catch (error) {
      console.error('Failed to get global state:', error);
      throw new StateError('Failed to get global state', error);
    }
  }

  /**
   * Set global (non-thread-scoped) values in storage
   * @param {Object} data - Key-value pairs to store
   * @throws {StateError} If write fails
   */
  async setGlobal(data) {
    try {
      await chrome.storage.local.set(data);
    } catch (error) {
      console.error('Failed to set global state:', error);
      throw new StateError('Failed to set global state', error);
    }
  }

  /**
   * Remove global (non-thread-scoped) values from storage
   * @param {string|string[]} keys - Key or array of keys to remove
   * @throws {StateError} If removal fails
   */
  async removeGlobal(keys) {
    try {
      const keysArray = Array.isArray(keys) ? keys : [keys];
      await chrome.storage.local.remove(keysArray);
    } catch (error) {
      console.error('Failed to remove global state:', error);
      throw new StateError('Failed to remove global state', error);
    }
  }

  // ============================================================================
  // SCRAPING STATE (thread-scoped)
  // ============================================================================

  /**
   * Get current scraping state for this thread
   * @returns {Promise<Object|null>} Scraping state object or null
   */
  async getScrapingState() {
    return await this.getThreadScoped(STORAGE_KEYS.SCRAPING_STATE);
  }

  /**
   * Set scraping state for this thread
   * @param {Object} state - State object to save
   */
  async setScrapingState(state) {
    const threadId = this.getThreadId();
    await this.setThreadScoped(STORAGE_KEYS.SCRAPING_STATE, {
      ...state,
      savedThreadId: threadId // Always save threadId for recovery
    });
  }

  /**
   * Clear scraping state for this thread
   */
  async clearScrapingState() {
    await this.removeThreadScoped(STORAGE_KEYS.SCRAPING_STATE);
  }

  // ============================================================================
  // CREDENTIALS (thread-scoped)
  // ============================================================================

  /**
   * Get stored credentials for this thread
   * @returns {Promise<Object|null>} Credentials object {clinicName, email, password}
   */
  async getCredentials() {
    return await this.getThreadScoped(STORAGE_KEYS.CREDENTIALS);
  }

  /**
   * Set credentials for this thread
   * @param {Object} credentials - {clinicName, email, password}
   */
  async setCredentials(credentials) {
    await this.setThreadScoped(STORAGE_KEYS.CREDENTIALS, credentials);
  }

  /**
   * Clear credentials for this thread
   */
  async clearCredentials() {
    await this.removeThreadScoped(STORAGE_KEYS.CREDENTIALS);
  }

  // ============================================================================
  // RETRY COUNTS (thread-scoped)
  // ============================================================================

  /**
   * Get retry counts for a specific patient
   * @param {number} patientId - Patient ID
   * @returns {Promise<Object>} {patientCheck: number, charts: number}
   */
  async getRetryCounts(patientId) {
    const map = await this.getThreadScoped(STORAGE_KEYS.RETRY_COUNTS) || {};
    return map[patientId] || { patientCheck: 0, charts: 0 };
  }

  /**
   * Set retry counts for a specific patient
   * @param {number} patientId - Patient ID
   * @param {Object} counts - {patientCheck: number, charts: number}
   */
  async setRetryCounts(patientId, counts) {
    const map = await this.getThreadScoped(STORAGE_KEYS.RETRY_COUNTS) || {};
    map[patientId] = counts;
    await this.setThreadScoped(STORAGE_KEYS.RETRY_COUNTS, map);
  }

  /**
   * Reset retry counts for a specific patient
   * @param {number} patientId - Patient ID
   */
  async resetRetryCounts(patientId) {
    const map = await this.getThreadScoped(STORAGE_KEYS.RETRY_COUNTS) || {};
    if (map[patientId]) {
      delete map[patientId];
      await this.setThreadScoped(STORAGE_KEYS.RETRY_COUNTS, map);
    }
  }

  // ============================================================================
  // HEARTBEAT (thread-scoped)
  // ============================================================================

  /**
   * Update heartbeat timestamp for watchdog
   */
  async updateHeartbeat() {
    await this.setThreadScoped(STORAGE_KEYS.LAST_HEARTBEAT, Date.now());
  }

  /**
   * Get last heartbeat timestamp
   * @returns {Promise<number>} Timestamp in milliseconds
   */
  async getLastHeartbeat() {
    return await this.getThreadScoped(STORAGE_KEYS.LAST_HEARTBEAT) || 0;
  }

  // ============================================================================
  // PDF FETCH THROTTLING (thread-scoped)
  // ============================================================================

  /**
   * Get last PDF fetch timestamp
   * @returns {Promise<number>} Timestamp in milliseconds
   */
  async getLastPdfFetchTime() {
    return await this.getThreadScoped(STORAGE_KEYS.LAST_PDF_FETCH_TS) || 0;
  }

  /**
   * Set last PDF fetch timestamp
   * @param {number} timestamp - Timestamp in milliseconds
   */
  async setLastPdfFetchTime(timestamp) {
    await this.setThreadScoped(STORAGE_KEYS.LAST_PDF_FETCH_TS, timestamp);
  }

  // ============================================================================
  // STOP FLAGS (global)
  // ============================================================================

  /**
   * Check if stop has been requested
   * @returns {Promise<boolean>} True if stop requested
   */
  async isStopRequested() {
    const data = await this.getGlobal([
      STORAGE_KEYS.STOP_REQUESTED,
      STORAGE_KEYS.USER_REQUESTED_STOP
    ]);
    return !!(data[STORAGE_KEYS.STOP_REQUESTED] || data[STORAGE_KEYS.USER_REQUESTED_STOP]);
  }

  /**
   * Set stop requested flag
   * @param {boolean} userRequested - True if user clicked stop button
   */
  async setStopRequested(userRequested = false) {
    const data = { [STORAGE_KEYS.STOP_REQUESTED]: true };
    if (userRequested) {
      data[STORAGE_KEYS.USER_REQUESTED_STOP] = true;
    }
    await this.setGlobal(data);
  }

  /**
   * Clear stop flags
   */
  async clearStopFlags() {
    await this.removeGlobal([
      STORAGE_KEYS.STOP_REQUESTED,
      STORAGE_KEYS.USER_REQUESTED_STOP
    ]);
  }

  /**
   * Check if page is marked as frozen
   * @returns {Promise<boolean>} True if frozen
   */
  async isFrozen() {
    const data = await this.getGlobal([STORAGE_KEYS.FROZEN]);
    return !!data[STORAGE_KEYS.FROZEN];
  }

  /**
   * Set frozen flag
   * @param {boolean} frozen - True to mark as frozen
   */
  async setFrozen(frozen) {
    await this.setGlobal({ [STORAGE_KEYS.FROZEN]: frozen });
  }

  // ============================================================================
  // WORK REGISTRY (global - used by coordinator)
  // ============================================================================

  /**
   * Get work registry (coordinator state)
   * @returns {Promise<Object>} Work registry object
   */
  async getWorkRegistry() {
    const data = await this.getGlobal([STORAGE_KEYS.WORK_REGISTRY]);
    return data[STORAGE_KEYS.WORK_REGISTRY] || {};
  }

  /**
   * Set work registry
   * @param {Object} registry - Work registry object
   */
  async setWorkRegistry(registry) {
    await this.setGlobal({ [STORAGE_KEYS.WORK_REGISTRY]: registry });
  }

  // ============================================================================
  // ACTIVE THREADS (global - used by coordinator)
  // ============================================================================

  /**
   * Get active threads map
   * @returns {Promise<Object>} Active threads object
   */
  async getActiveThreads() {
    const data = await this.getGlobal([STORAGE_KEYS.ACTIVE_THREADS]);
    return data[STORAGE_KEYS.ACTIVE_THREADS] || {};
  }

  /**
   * Set active threads
   * @param {Object} threads - Active threads object
   */
  async setActiveThreads(threads) {
    await this.setGlobal({ [STORAGE_KEYS.ACTIVE_THREADS]: threads });
  }

  // ============================================================================
  // PATIENT LOCKS (global - used by coordinator)
  // ============================================================================

  /**
   * Get patient locks map
   * @returns {Promise<Object>} Patient locks object
   */
  async getPatientLocks() {
    const data = await this.getGlobal([STORAGE_KEYS.PATIENT_LOCKS]);
    return data[STORAGE_KEYS.PATIENT_LOCKS] || {};
  }

  /**
   * Set patient locks
   * @param {Object} locks - Patient locks object
   */
  async setPatientLocks(locks) {
    await this.setGlobal({ [STORAGE_KEYS.PATIENT_LOCKS]: locks });
  }

  // ============================================================================
  // COMPLETED PATIENTS (global - used by coordinator)
  // ============================================================================

  /**
   * Get completed patients map
   * @returns {Promise<Object>} Completed patients object
   */
  async getCompletedPatients() {
    const data = await this.getGlobal([STORAGE_KEYS.COMPLETED_PATIENTS]);
    return data[STORAGE_KEYS.COMPLETED_PATIENTS] || {};
  }

  /**
   * Set completed patients
   * @param {Object} patients - Completed patients object
   */
  async setCompletedPatients(patients) {
    await this.setGlobal({ [STORAGE_KEYS.COMPLETED_PATIENTS]: patients });
  }
}

/**
 * Create a new StateManager instance
 * @param {Function} getThreadId - Function that returns current threadId
 * @returns {StateManager} StateManager instance
 */
export function createStateManager(getThreadId) {
  return new StateManager(getThreadId);
}
