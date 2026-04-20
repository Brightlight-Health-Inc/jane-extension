/**
 * SHARED CONSTANTS
 *
 * All magic numbers, timeouts, retry limits, and selectors centralized here.
 * Each constant is documented to explain its purpose and rationale.
 */

// ============================================================================
// TIMEOUTS & DELAYS
// ============================================================================

export const TIMEOUTS = {
  // Page navigation and loading
  MAX_WAIT_TIME: 60000,           // 60s - Maximum time to wait for page loads
  PAGE_DELAY: 1000,               // 1s - Standard delay between actions
  PATIENT_PAGE_LOAD: 3000,        // 3s - Wait after navigating to patient page
  CHARTS_PAGE_LOAD: 3500,         // 3.5s - Wait after navigating to charts page (Jane SPA needs time to load)
  CHARTS_RENDER: 40000,           // 40s - Max time to wait for charts to render on page

  // Element-specific waits
  PATIENT_CHECK_WAIT: 3000,       // 3s - Wait before checking if patient exists
  SPINNER_MAX_WAIT: 20000,        // 20s - Max time to wait for loading spinner to disappear

  // Recovery and pauses
  FREEZE_RECOVERY_PAUSE: 100000,  // 100s - Pause when page appears frozen (conservative, allows SPA to recover)
  RATE_LIMIT_PAUSE: 60000,        // 60s - Pause when Jane rate limits us ("Whoa there friend")
  REQUEST_WORK_DELAY: 1500,       // 1.5s - Delay between finishing one patient and requesting next
  BETWEEN_CHARTS_MIN: 800,        // 0.8s - Minimum delay between downloading chart PDFs
  BETWEEN_CHARTS_MAX: 2000,       // 2s - Maximum delay between downloading chart PDFs (adds jitter)

  // Download timeouts
  DOWNLOAD_COMPLETE_TIMEOUT: 30000,  // 30s - Max time to wait for PDF download to complete (60 attempts x 500ms)
  DOWNLOAD_CHECK_INTERVAL: 500,      // 0.5s - How often to check download status

  // Login delays
  LOGIN_FORM_WAIT: 500,              // 0.5s - Wait for login page to load
  POST_EMAIL_DELAY: 200,             // 0.2s - Delay after entering email
  POST_PASSWORD_DELAY: 300,          // 0.3s - Delay after entering password before clicking

  // Chart-specific
  CHART_LOAD_CHECK_INTERVAL: 500,    // 0.5s - How often to check if charts have loaded (polling interval)
  LOAD_MORE_WAIT_INTERVAL: 1000,     // 1s - How often to check if "Load More" button is still loading
  PDF_BUTTON_WAIT: 2000,             // 2s - Wait for PDF preview button to appear

  // State persistence
  STATE_SAVE_DELAY: 800,             // 0.8s - Wait before navigating after saving state (give browser time)
  NAVIGATION_START_DELAY: 500,       // 0.5s - Wait before redirect for stabilization
};

// ============================================================================
// THROTTLING
// ============================================================================

export const THROTTLE = {
  MIN_PDF_FETCH_GAP_MS: 4000,     // 4s - Minimum gap between PDF fetches per thread (avoid overwhelming server)
};

// ============================================================================
// RETRY CONFIGURATION
// ============================================================================

export const RETRY = {
  // Default retry settings
  DEFAULT_MAX_RETRIES: 3,         // Default max retries for most operations
  BASE_DELAY_MS: 2000,            // 2s - Base delay for exponential backoff
  MAX_DELAY_MS: 10000,            // 10s - Maximum delay for exponential backoff

  // Operation-specific retries
  PATIENT_CHECK_MAX_RETRIES: 3,   // Max retries for checking if patient exists
  CHARTS_CHECK_MAX_RETRIES: 3,    // Max retries for loading charts page
  PDF_DOWNLOAD_MAX_RETRIES: 3,    // Max retries for downloading a single PDF (chart entry page)
  PDF_LINK_MAX_RETRIES: 3,        // Max retries for finding PDF download link on preview page

  // Message passing retries
  MESSAGE_RETRY_MAX_ATTEMPTS: 30, // Max retries for sending message to content script (30 * 1s = 30s)
  MESSAGE_RETRY_DELAY: 1000,      // 1s - Delay between message retry attempts

  // Backoff increment
  RETRY_INCREMENT_MS: 1000,       // 1s - How much to increase delay with each retry (linear backoff)
  MAX_RETRY_INCREMENT_MS: 5000,   // 5s - Maximum backoff increment per attempt
};

// ============================================================================
// THREADING CONFIGURATION
// ============================================================================

export const THREADING = {
  MAX_THREADS: 8,                    // Maximum concurrent worker threads
  THREAD_STAGGER_DELAY_MS: 10000,    // 10s - Delay between starting each thread (prevent stampede)
  WATCHDOG_CHECK_INTERVAL_MS: 15000, // 15s - How often watchdog checks for idle threads
  WATCHDOG_IDLE_THRESHOLD_MS: 120000,// 120s - Thread considered idle after this long without heartbeat
  COORDINATOR_CLEANUP_DELAY: 1000,   // 1s - Delay before closing worker tabs after stop signal
  AUTO_CLEAR_STOP_DELAY: 1500,       // 1.5s - Auto-clear globalStop flag after this delay
};

// ============================================================================
// LIMITS
// ============================================================================

export const LIMITS = {
  LOAD_MORE_MAX_REPEATS: 10,      // Maximum times to click "Load More" button (prevents infinite loop)
  MAX_DOWNLOAD_ATTEMPTS: 60,      // 60 attempts - Maximum attempts to check download completion
  PATIENT_PROBE_LIMIT: 5000,      // Maximum number of patients to probe when looking for next unassigned patient
};

// ============================================================================
// DOM SELECTORS
// ============================================================================

export const SELECTORS = {
  // Patient page
  PATIENT_NAME: '.row .col-xs-10.col-sm-11 .sensitive.text-selectable',
  ERROR_MESSAGE: '.alert-danger, .error-message',
  LOADING_SPINNER: 'i.icon-spinner.text-muted.icon-spin',

  // Charts page
  CHART_PANEL: 'div.panel.panel-default.chart-entry.panel-no-gap',
  CHART_HEADER_CONTAINER: 'div.ellipsis-after-3-lines.flex-order-sm-2.flex-item.flex-pull-left',
  CHART_DATE: 'span[data-test-id="chart_entry_header_date"]',
  CHART_TITLE: 'span[data-test-id="chart_entry_header_title"]',
  CHART_PRINT_LINK: 'a[href*="/admin/patients/"][href*="/chart_entries/"][target="_blank"]',
  CHARTS_CONTAINER: '#charts, [data-test-id="charts_container"]',
  LOAD_MORE_BUTTON: 'button.btn.btn-link',
  LOAD_MORE_LOADING: 'button.btn.btn-link[disabled]',

  // Chart entry page (PDF preview)
  PDF_BUTTON: 'a#pdf_button[href*=".pdf"]',
  PDF_DOWNLOAD_LINK: 'a.btn.btn-default[href*=".pdf"]',  // On PDF preview page
  ERROR_MODAL_HEADER: 'div.modal-header h3',

  // Login page
  EMAIL_INPUT: 'input[name="auth_key"], input#auth_key',
  PASSWORD_INPUT: 'input[name="password"], input#password',
  SIGN_IN_BUTTON: 'button#log_in, form button[type="submit"], button:has([data-test="sign-in"])',

  // Admin shell (logged in state)
  ADMIN_SHELL: '#ember-basic-dropdown-wormhole, header, nav',
};

// ============================================================================
// REGEX PATTERNS
// ============================================================================

export const PATTERNS = {
  // Chart entry ID from URL
  CHART_ENTRY_ID: /\/chart_entries\/(\d+)/,

  // Patient folder in downloads
  PATIENT_FOLDER: /jane-scraper\/(\d+)_([^/]+)\//,

  // Zip filename
  PATIENT_ZIP: /\/(\d+)_[^/]+\.zip$/,

  // PDF filename
  PDF_FILENAME_REGEX: /jane-scraper\/\d+_[^/]+\/.*\.pdf$/,

  // Patient folder for counting
  PATIENT_FOLDER_COUNT: (patientId, folderName) =>
    folderName
      ? `jane-scraper/${patientId}_${folderName}/.*\\.pdf$`
      : `jane-scraper/${patientId}_[^/]+/.*\\.pdf$`,

  // File existence check
  PATIENT_FILE_EXISTS: (patientId, filenamePrefix) => {
    const escaped = (filenamePrefix || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return `jane-scraper/${patientId}_[^/]+/${escaped}$`;
  },

  // Clinic name from hostname
  CLINIC_NAME_FROM_HOSTNAME: /^([^\.]+)\.janeapp\.com$/,

  // Rate limit detection
  RATE_LIMIT_TEXT: /whoa there friend.*please take a moment/i,
};

// ============================================================================
// ERROR MESSAGES
// ============================================================================

export const ERROR_MESSAGES = {
  // Login errors
  LOGIN_FAILED: 'Login failed',
  EMAIL_FIELD_NOT_FOUND: 'Email field not found',
  PASSWORD_FIELD_NOT_FOUND: 'Password field not found',
  SIGN_IN_BUTTON_NOT_FOUND: 'Sign In button not found',

  // Patient errors
  PATIENT_NOT_FOUND: 'Patient not found',
  PATIENT_CHECK_TIMEOUT: 'Patient check timed out',
  PATIENT_NO_CHARTS: 'Patient has no charts',
  CHARTS_LOAD_TIMEOUT: 'Charts load timed out',

  // Download errors
  PDF_FETCH_FAILED: 'PDF fetch failed',
  PDF_EMPTY: 'Downloaded PDF is empty',
  DOWNLOAD_INTERRUPTED: 'Download interrupted',
  DOWNLOAD_TIMEOUT: 'Download timed out',
  PDF_BUTTON_NOT_FOUND: 'PDF button not found',
  PDF_LINK_NOT_FOUND: 'PDF download link not found',

  // State errors
  STATE_READ_FAILED: 'Failed to read state',
  STATE_WRITE_FAILED: 'Failed to write state',

  // Generic
  STOPPED: 'Stopped',
  UNKNOWN_ERROR: 'Unknown error',
};

// ============================================================================
// STORAGE KEYS
// ============================================================================

export const STORAGE_KEYS = {
  // Thread coordination (global, shared by all threads)
  ACTIVE_THREADS: 'activeThreads',
  PATIENT_LOCKS: 'patientLocks',
  WORK_REGISTRY: 'workRegistry',
  COMPLETED_PATIENTS: 'completedPatients',
  PATIENT_FOLDERS: 'patientFolders',

  // Stop flags
  STOP_REQUESTED: 'stopRequested',
  USER_REQUESTED_STOP: 'userRequestedStop',
  FROZEN: 'frozen',

  // Thread-scoped (will be prefixed with threadId)
  SCRAPING_STATE: 'scrapingState',
  CREDENTIALS: 'credentials',
  RETRY_COUNTS: 'retryCounts',
  LAST_HEARTBEAT: 'lastHeartbeat',
  LAST_PDF_FETCH_TS: 'lastPdfFetchTs',
  WATCHDOG_ACTIVE: 'watchdogActive',
};

// ============================================================================
// INDEXEDDB CONFIGURATION
// ============================================================================

export const INDEXEDDB = {
  DB_NAME: 'JaneScraperDB',
  STORE_NAME: 'patientFiles',
  VERSION: 1,
};
