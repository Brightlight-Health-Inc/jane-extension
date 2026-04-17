/**
 * SIDE PANEL SCRIPT
 * 
 * This manages the UI side panel that the user interacts with.
 * 
 * What it does:
 * - Shows a form to enter Jane App credentials
 * - Has start/stop buttons
 * - Displays real-time status messages from worker threads
 * - Shows stats (PDFs downloaded, users processed, time elapsed, etc.)
 * - Automatically switches to "stop" mode when scraping is running
 */

// ============================================================================
// UI ELEMENTS
// ============================================================================

// Get references to all the UI elements we need
const chartsBtn = document.getElementById('charts-btn');
const migrationBtn = document.getElementById('appointments-btn');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const statusMessages = document.getElementById('status-messages');
const statusCount = document.getElementById('status-count');
const formSection = document.getElementById('form-section');
const statusContainer = document.getElementById('status-container');

// Form field groups
const chartsFields = document.getElementById('charts-fields');
const chartsFields2 = document.getElementById('charts-fields-2');
const appointmentsFields = document.getElementById('appointments-fields');
const appointmentsFields2 = document.getElementById('appointments-fields-2');

// Current export mode
let currentMode = null; // 'charts' or 'migration'
let pendingMigration = false;
const MAX_THREADS = 8;

// Stats display elements
const statsPdfs = document.getElementById('stats-pdfs');
const statsUsers = document.getElementById('stats-users');

// ============================================================================
// STATE TRACKING
// ============================================================================

// Message counter
let messageCount = 0; // Count error messages only
const MAX_ERROR_LOG_ENTRIES = 500;

// Stats tracking
let pdfCount = 0;   // How many PDFs have we downloaded?
let userCount = 0;  // How many patients have we processed?

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Reset all stats to zero for a new run
 */
function resetStats() {
  pdfCount = 0;
  userCount = 0;
  messageCount = 0;
  statusMessages.innerHTML = '';
  statusCount.textContent = '0 errors';
  
  // Update UI
  statsPdfs.textContent = '0';
  statsUsers.textContent = '0';
}

/**
 * Add a status message to the log
 */
function updateStatus(message, type = 'info') {
  // Only show errors in the log
  if (type !== 'error') return;

  // Create a timestamp for this message
  const now = new Date();
  const timestamp = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  // Create the message element
  const messageElement = document.createElement('div');
  messageElement.className = `status-message ${type}`;
  messageElement.innerHTML = `<span class="timestamp">${timestamp}</span>${message}`;

  // Add it to the log
  statusMessages.appendChild(messageElement);

  while (statusMessages.children.length > MAX_ERROR_LOG_ENTRIES) {
    statusMessages.removeChild(statusMessages.firstElementChild);
  }

  // Update message counter
  messageCount++;
  const plural = messageCount !== 1 ? 's' : '';
  statusCount.textContent = `${messageCount} error${plural}`;

  // Auto-scroll only if user is already at/near the bottom (not manually scrolled up)
  const isNearBottom = statusMessages.scrollHeight - statusMessages.scrollTop <= statusMessages.clientHeight + 50;
  if (isNearBottom) {
    statusMessages.scrollTop = statusMessages.scrollHeight;
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Show fields for charts export
 */
function showChartsFields() {
  chartsFields.style.display = 'block';
  chartsFields2.style.display = 'block';
  appointmentsFields.style.display = 'none';
  appointmentsFields2.style.display = 'none';
  currentMode = 'charts';
}

/**
 * Show fields for migration export (appointments + patients)
 */
function showMigrationFields() {
  chartsFields.style.display = 'none';
  chartsFields2.style.display = 'none';
  appointmentsFields.style.display = 'block';
  appointmentsFields2.style.display = 'block';
  currentMode = 'migration';
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

/**
 * Charts button - shows charts form fields
 */
chartsBtn.addEventListener('click', () => {
  showChartsFields();
  chartsBtn.style.display = 'none';
  migrationBtn.style.display = 'none';
  startBtn.style.display = 'block';
});

/**
 * Migration button - shows migration form fields
 */
migrationBtn.addEventListener('click', () => {
  showMigrationFields();
  chartsBtn.style.display = 'none';
  migrationBtn.style.display = 'none';
  startBtn.style.display = 'block';
});

/**
 * Ask Chrome for host permission on a specific clinic's janeapp.com subdomain.
 * The manifest declares the broad pattern under optional_host_permissions so
 * the extension ships with no standing access to any Jane clinic; this prompt
 * is the moment the user grants read/write for exactly the clinic they're
 * about to export. Chrome remembers the grant across sessions.
 *
 * Must be called synchronously from a user-gesture handler (click) — Chrome
 * silently returns false otherwise.
 */
async function ensureClinicPermission(clinicName) {
  const origin = `https://${clinicName}.janeapp.com/*`;
  try {
    const already = await chrome.permissions.contains({ origins: [origin] });
    if (already) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch (error) {
    updateStatus(`❌ Permission check failed: ${error.message}`, 'error');
    return false;
  }
}

/**
 * Start button - validates form and starts export
 */
startBtn.addEventListener('click', async () => {
  // Get common form values
  const clinicName = document.getElementById('clinic-name').value.trim();
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value.trim();

  if (!clinicName || !email || !password) {
    updateStatus('Please fill in clinic name, email, and password', 'error');
    return;
  }

  // Request host permission for this specific clinic subdomain. Must happen
  // inside the click handler (user gesture) and before any long async work
  // that would invalidate the gesture.
  const permitted = await ensureClinicPermission(clinicName);
  if (!permitted) {
    updateStatus(`❌ Permission required for ${clinicName}.janeapp.com — can't proceed`, 'error');
    return;
  }

  if (currentMode === 'charts') {
    // Validate charts-specific fields
    const threadCount = parseInt(document.getElementById('thread-count').value, 10);
    const maxIdInput = document.getElementById('max-id').value.trim();
    const maxId = maxIdInput ? parseInt(maxIdInput, 10) : null;

    if (!threadCount || threadCount < 1 || threadCount > MAX_THREADS) {
      updateStatus(`Thread count must be between 1 and ${MAX_THREADS}`, 'error');
      return;
    }

    // Switch UI to "running" mode
    formSection.classList.add('hidden');
    statusContainer.classList.add('expanded');
    startBtn.style.display = 'none';
    stopBtn.style.display = 'block';
    stopBtn.disabled = false;

    // Reset stats
    resetStats();

    const plural = threadCount > 1 ? 's' : '';
    updateStatus(`Starting charts export with ${threadCount} thread${plural}...`);

    // Tell background.js to start the worker threads
    chrome.runtime.sendMessage({
      action: 'startThreads',
      clinicName,
      email,
      password,
      startingIndex: 1,
      numThreads: threadCount,
      maxId,
      resume: false
    }, (response) => {
      if (chrome.runtime.lastError) {
        updateStatus('❌ Error: ' + chrome.runtime.lastError.message, 'error');
        return;
      }
      
      if (!response || !response.ok) {
        updateStatus('❌ Could not start: ' + (response?.error || 'unknown'), 'error');
      } else {
      updateStatus(`✅ ${threadCount} thread${plural} started`);
      }
    });

  } else if (currentMode === 'migration') {
    // Validate appointments-specific fields (used for migration appointments export)
    const startDate = document.getElementById('start-date').value;
    const endDate = document.getElementById('end-date').value;

    if (!startDate || !endDate) {
      updateStatus('Please select both start and end dates', 'error');
      return;
    }

    if (new Date(startDate) > new Date(endDate)) {
      updateStatus('Start date must be before end date', 'error');
      return;
    }

    // Switch UI to "running" mode
    formSection.classList.add('hidden');
    statusContainer.classList.add('expanded');
    startBtn.style.display = 'none';
    stopBtn.style.display = 'block';
    stopBtn.disabled = false;

    // Reset stats
    resetStats();

    updateStatus('Starting migration export (appointments then patients)...');

    pendingMigration = true;

    // Tell background.js to start migration flow
    // (clinicName, email, password are already set to hardcoded values above)
    chrome.runtime.sendMessage({
      action: 'startMigration',
      clinicName,
      email,
      password,
      startDate,
      endDate
    }, (response) => {
      if (chrome.runtime.lastError) {
        updateStatus('❌ Error: ' + chrome.runtime.lastError.message, 'error');
        pendingMigration = false;
        return;
      }
      if (!response || !response.ok) {
        updateStatus('❌ Could not start migration: ' + (response?.error || 'unknown'), 'error');
        pendingMigration = false;
      }
    });
  }
});

/**
 * Stop button - stops all worker threads
 */
stopBtn.addEventListener('click', async () => {
  updateStatus('Stopping...', 'info');

  // Set stop flags
  await chrome.storage.local.set({ stopRequested: true, userRequestedStop: true });

  // Tell background.js to stop all workers
  chrome.runtime.sendMessage({ action: 'broadcastStop' }, (response) => {
    if (!response || response.ok !== true) {
      const error = response?.error || chrome.runtime.lastError?.message || 'unknown';
      updateStatus('❌ Error stopping: ' + error, 'error');
      return;
    }
    updateStatus('⏹️ Stop signal sent', 'info');
  });
});


/**
 * Listen for status messages from worker threads
 * Updates the UI with progress and calculates stats
 */
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'statusUpdate') {
    const rawMessage = request.status.message || '';
    const threadId = request.status.threadId;
    // Prefix with the thread tag (e.g. "[T3]") so multi-thread logs are
    // traceable. Messages from single-tab flows (appointments/migration) have
    // no threadId and render unchanged.
    const message = threadId ? `[${threadId}] ${rawMessage}` : rawMessage;

    // Display the message (errors only)
    updateStatus(message, request.status.type);

    // Track stats based on message content
    // (Messages include [T1], [T2] prefixes from different threads)
    
    // Patient completed
    if (message.includes('✅ Completed patient ')) {
      userCount++;
      statsUsers.textContent = String(userCount);
    }

    // PDF downloaded
    if (message.includes('✅ Downloaded: ')) {
      pdfCount++;
      statsPdfs.textContent = String(pdfCount);
    }

    // Check if scraping is done
    const isDone = message.includes('No more work available') || 
                   message.includes('Scraping stopped');
    
    if (isDone) {
      // Wait 2 seconds then reset UI
      setTimeout(() => {
        stopBtn.style.display = 'none';
        startBtn.style.display = 'none';
        chartsBtn.style.display = 'block';
        migrationBtn.style.display = 'block';
        formSection.classList.remove('hidden');
        statusContainer.classList.remove('expanded');
        currentMode = null;
      }, 2000);
    }

    // Reset UI when migration flow finishes
    if (pendingMigration && message.includes('Migration completed')) {
      pendingMigration = false;
      stopBtn.style.display = 'none';
      startBtn.style.display = 'none';
      chartsBtn.style.display = 'block';
      migrationBtn.style.display = 'block';
      formSection.classList.remove('hidden');
      statusContainer.classList.remove('expanded');
      currentMode = null;
    }
  }
});

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Check if scraping is already running when panel opens
 * (This handles the case where user closes and reopens the panel while scraping)
 */
(async function initializePanel() {
  try {
    const data = await chrome.storage.local.get(['activeThreads']);
    const activeThreads = data.activeThreads || {};
    const threadCount = Object.keys(activeThreads).length;

    if (threadCount > 0) {
      // Scraping is running - switch to "stop" mode
      console.log('Scraping already running - showing stop UI');
      
      formSection.classList.add('hidden');
      statusContainer.classList.add('expanded');
    chartsBtn.style.display = 'none';
    migrationBtn.style.display = 'none';
    startBtn.style.display = 'none';
      stopBtn.style.display = 'block';
      stopBtn.disabled = false;
      
      resetStats();
      
      const plural = threadCount > 1 ? 's' : '';
      updateStatus(`Reconnected - ${threadCount} thread${plural} running`, 'info');
    }
  } catch (e) {
    console.error('Failed to check running state:', e);
  }
})();

console.log('Side panel loaded');
