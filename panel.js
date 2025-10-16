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
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const testBtn = document.getElementById('test-btn');
const statusMessages = document.getElementById('status-messages');
const statusCount = document.getElementById('status-count');
const formSection = document.getElementById('form-section');
const statusContainer = document.getElementById('status-container');

// Stats display elements
const statsPdfs = document.getElementById('stats-pdfs');
const statsUsers = document.getElementById('stats-users');
const statsElapsed = document.getElementById('stats-elapsed');
const statsAvgUser = document.getElementById('stats-avg-user');
const statsAvgPdf = document.getElementById('stats-avg-pdf');

// ============================================================================
// STATE TRACKING
// ============================================================================

// Message counter
let messageCount = 1; // Start at 1 for the initial "Ready" message

// Stats tracking
let runStartTime = null;        // When did the run start?
let pdfCount = 0;                // How many PDFs have we downloaded?
let userCount = 0;               // How many patients have we processed?
let userStartTime = null;        // When did we start the current patient?
let totalUserDurationMs = 0;     // Total time spent on all patients
let totalPdfDurationMs = 0;      // Total time spent on all PDFs
let lastPdfTime = null;          // When was the last PDF downloaded?

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Format milliseconds as HH:MM:SS
 */
function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

/**
 * Reset all stats to zero for a new run
 */
function resetStats() {
  runStartTime = Date.now();
  pdfCount = 0;
  userCount = 0;
  userStartTime = null;
  totalUserDurationMs = 0;
  totalPdfDurationMs = 0;
  lastPdfTime = null;
  
  // Update UI
  statsPdfs.textContent = '0';
  statsUsers.textContent = '0';
  statsElapsed.textContent = '00:00:00';
  statsAvgUser.textContent = '-';
  statsAvgPdf.textContent = '-';
}

/**
 * Update the elapsed time display (called every second)
 */
function tickElapsed() {
  if (!runStartTime) return;
  statsElapsed.textContent = formatDuration(Date.now() - runStartTime);
}

// Update elapsed time every second
setInterval(tickElapsed, 1000);

/**
 * Add a status message to the log
 */
function updateStatus(message, type = 'info') {
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

  // Update message counter
  messageCount++;
  const plural = messageCount !== 1 ? 's' : '';
  statusCount.textContent = `${messageCount} message${plural}`;

  // Auto-scroll to show the newest message
  statusMessages.scrollTop = statusMessages.scrollHeight;
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

/**
 * Start button - validates form and starts scraping
 */
startBtn.addEventListener('click', async () => {
  // Get form values
  const clinicName = document.getElementById('clinic-name').value.trim();
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value.trim();
  const threadCount = parseInt(document.getElementById('thread-count').value, 10);
  const maxIdInput = document.getElementById('max-id').value.trim();
  const maxId = maxIdInput ? parseInt(maxIdInput, 10) : null;

  // Validate inputs
  if (!clinicName || !email || !password) {
    updateStatus('Please fill in all fields', 'error');
    return;
  }

  if (!threadCount || threadCount < 1 || threadCount > 5) {
    updateStatus('Thread count must be between 1 and 5', 'error');
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
  updateStatus(`Starting with ${threadCount} thread${plural}...`);

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
 * Test button - runs a short test from ID 1 to 5
 */
testBtn.addEventListener('click', async () => {
  // Get form values
  const clinicName = document.getElementById('clinic-name').value.trim();
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value.trim();
  const threadCount = parseInt(document.getElementById('thread-count').value, 10) || 1;

  // Validate inputs
  if (!clinicName || !email || !password) {
    updateStatus('Please fill in all fields to run the test', 'error');
    return;
  }

  // Validate threads
  if (!threadCount || threadCount < 1 || threadCount > 5) {
    updateStatus('Thread count must be between 1 and 5', 'error');
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
  updateStatus(`Starting test run (IDs 1–5) with ${threadCount} thread${plural}...`);

  chrome.runtime.sendMessage({
    action: 'startThreads',
    clinicName,
    email,
    password,
    startingIndex: 1,
    numThreads: threadCount,
    maxId: 5,
    resume: false
  }, (response) => {
    if (chrome.runtime.lastError) {
      updateStatus('❌ Error: ' + chrome.runtime.lastError.message, 'error');
      return;
    }
    if (!response || !response.ok) {
      updateStatus('❌ Could not start: ' + (response?.error || 'unknown'), 'error');
    } else {
      updateStatus('✅ Test run started');
    }
  });
});

/**
 * Auto-stop if user closes the side panel
 */
window.addEventListener('beforeunload', () => {
  try {
    chrome.storage.local.set({ stopRequested: true });
    chrome.runtime.sendMessage({ action: 'broadcastStop' });
  } catch (_) {
    // Ignore errors on unload
  }
});

/**
 * Listen for status messages from worker threads
 * Updates the UI with progress and calculates stats
 */
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'statusUpdate') {
    const message = request.status.message || '';
    
    // Display the message
    updateStatus(message, request.status.type);

    // Track stats based on message content
    // (Messages include [T1], [T2] prefixes from different threads)
    
    // New patient started
    if (message.includes('📋 Processing patient ')) {
      userStartTime = Date.now();
    }
    
    // Patient completed
    if (message.includes('✅ Completed patient ')) {
      userCount++;
      statsUsers.textContent = String(userCount);
      
      if (userStartTime) {
        totalUserDurationMs += (Date.now() - userStartTime);
        userStartTime = null;
      }
    }

    // PDF downloaded
    if (message.includes('✅ Downloaded: ')) {
      pdfCount++;
      statsPdfs.textContent = String(pdfCount);
      
      if (lastPdfTime) {
        totalPdfDurationMs += (Date.now() - lastPdfTime);
      }
      lastPdfTime = Date.now();
    }

    // Update average times
    if (userCount > 0) {
      const avgUserTime = Math.floor(totalUserDurationMs / userCount);
      statsAvgUser.textContent = formatDuration(avgUserTime);
    }
    if (pdfCount > 0) {
      const avgPdfTime = Math.floor(totalPdfDurationMs / pdfCount);
      statsAvgPdf.textContent = formatDuration(avgPdfTime);
    }

    // Check if scraping is done
    const isDone = message.includes('No more work available') || 
                   message.includes('Scraping stopped');
    
    if (isDone) {
      // Wait 2 seconds then reset UI
      setTimeout(() => {
        stopBtn.style.display = 'none';
        startBtn.style.display = 'block';
        formSection.classList.remove('hidden');
        statusContainer.classList.remove('expanded');
      }, 2000);
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
