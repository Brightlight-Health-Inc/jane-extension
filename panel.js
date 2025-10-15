/**
 * SIDE PANEL SCRIPT
 * 
 * This script manages the side panel UI for the Jane Scraper extension.
 * It provides a form for users to enter their credentials and controls
 * to start/stop the scraping process.
 * 
 * Key features:
 * - Collects clinic name, email, and password from the user
 * - Starts the scraping process by navigating to Jane App and passing credentials
 * - Displays real-time status updates from the content script
 * - Allows users to stop the scraping process at any time
 */

// DOM element references
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const statusMessages = document.getElementById('status-messages');
const statusCount = document.getElementById('status-count');
const formSection = document.getElementById('form-section');
const statusContainer = document.getElementById('status-container');
// Stats elements
const statsPdfs = document.getElementById('stats-pdfs');
const statsUsers = document.getElementById('stats-users');
const statsElapsed = document.getElementById('stats-elapsed');
const statsAvgUser = document.getElementById('stats-avg-user');
const statsAvgPdf = document.getElementById('stats-avg-pdf');

// Message history
let messageCount = 1; // Start at 1 for the initial "Ready" message

// Stats state
let runStartTime = null;
let pdfCount = 0;
let userCount = 0;
let userStartTime = null;
let totalUserDurationMs = 0;
let totalPdfDurationMs = 0;
let lastPdfTime = null;

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function resetStats() {
  runStartTime = Date.now();
  pdfCount = 0;
  userCount = 0;
  userStartTime = null;
  totalUserDurationMs = 0;
  totalPdfDurationMs = 0;
  lastPdfTime = null;
  statsPdfs.textContent = '0';
  statsUsers.textContent = '0';
  statsElapsed.textContent = '00:00:00';
  statsAvgUser.textContent = '-';
  statsAvgPdf.textContent = '-';
}

function tickElapsed() {
  if (!runStartTime) return;
  statsElapsed.textContent = formatDuration(Date.now() - runStartTime);
}

setInterval(tickElapsed, 1000);

/**
 * Updates the status message displayed in the side panel
 * Adds messages to history instead of replacing
 *
 * @param {string} message - The status message to display
 * @param {string} [type='info'] - The message type ('info', 'success', or 'error')
 * @returns {void}
 */
function updateStatus(message, type = 'info') {
  // Create timestamp
  const now = new Date();
  const timestamp = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  // Create new message element
  const messageEl = document.createElement('div');
  messageEl.className = `status-message ${type}`;
  messageEl.innerHTML = `<span class="timestamp">${timestamp}</span>${message}`;

  // Add to messages container
  statusMessages.appendChild(messageEl);

  // Update count
  messageCount++;
  statusCount.textContent = `${messageCount} message${messageCount !== 1 ? 's' : ''}`;

  // Auto-scroll to bottom
  statusMessages.scrollTop = statusMessages.scrollHeight;

  // Limit to 100 messages to prevent memory issues
  const messages = statusMessages.querySelectorAll('.status-message');
  if (messages.length > 100) {
    messages[0].remove();
  }
}

/**
 * Handles the Start button click event
 *
 * Validates form fields and starts scraping with specified number of threads.
 * - If thread count = 1: Works like single-threaded mode
 * - If thread count > 1: Creates multiple tabs coordinated by background.js
 */
startBtn.addEventListener('click', async () => {
  const clinicName = document.getElementById('clinic-name').value.trim();
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value.trim();
  const threadCount = parseInt(document.getElementById('thread-count').value, 10);

  if (!clinicName || !email || !password) {
    updateStatus('Please fill in all fields', 'error');
    return;
  }

  if (!threadCount || threadCount < 1 || threadCount > 8) {
    updateStatus('Thread count must be between 1 and 8', 'error');
    return;
  }

  // Hide form and expand status
  formSection.classList.add('hidden');
  statusContainer.classList.add('expanded');

  // Show stop button, hide start button
  startBtn.style.display = 'none';
  stopBtn.style.display = 'block';
  stopBtn.disabled = false;

  // Reset stats for new run
  resetStats();

  updateStatus(`Starting with ${threadCount} thread${threadCount > 1 ? 's' : ''}...`);

  // Start threads via background coordinator
  chrome.runtime.sendMessage({
    action: 'startThreads',
    clinicName,
    email,
    password,
    startingIndex: 1,
    numThreads: threadCount,
    resume: false
  }, (resp) => {
    if (chrome.runtime.lastError) {
      updateStatus('❌ Error: ' + chrome.runtime.lastError.message, 'error');
      return;
    }
    if (!resp || !resp.ok) {
      updateStatus('❌ Could not start: ' + (resp?.error || 'unknown'), 'error');
    } else {
      updateStatus(`✅ ${threadCount} thread${threadCount > 1 ? 's' : ''} started`);
    }
  });
});

/**
 * Handles the Stop button click event
 * 
 * Sends a message to the content script to stop the scraping process,
 * then resets the UI back to the initial state.
 */
stopBtn.addEventListener('click', async () => {
  updateStatus('Stopping scraping...', 'info');

  // Request background to broadcast stop to all worker tabs
  chrome.runtime.sendMessage({ action: 'broadcastStop' }, (resp) => {
    if (!resp || resp.ok !== true) {
      updateStatus('❌ Error stopping: ' + (resp?.error || chrome.runtime.lastError?.message || 'unknown'), 'error');
      return;
    }
    updateStatus('⏹️ Stop signal sent to all workers', 'info');
  });
});

// Auto-stop if the side panel closes
window.addEventListener('beforeunload', () => {
  try {
    chrome.storage.local.set({ stopRequested: true });
    chrome.runtime.sendMessage({ action: 'broadcastStop' });
  } catch (_) {}
});

/**
 * Listens for status updates from the content script
 * 
 * Updates the status display in real-time as the scraping progresses.
 * Automatically resets the UI when scraping completes or is stopped.
 * 
 * @param {Object} request - The message request object
 * @param {string} request.action - The action type ('statusUpdate')
 * @param {Object} request.status - The status object containing message and type
 */
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'statusUpdate') {
    const msg = request.status.message || '';
    updateStatus(msg, request.status.type);

    // Detect user start/end
    if (msg.startsWith('📋 Processing patient ')) {
      // starting a new user
      userStartTime = Date.now();
    }
    if (msg.startsWith('✅ Completed patient ')) {
      // finished current user
      userCount += 1;
      statsUsers.textContent = String(userCount);
      if (userStartTime) {
        totalUserDurationMs += (Date.now() - userStartTime);
        userStartTime = null;
      }
    }

    // Detect successful PDF download lines
    if (msg.startsWith('✅ Downloaded: ')) {
      pdfCount += 1;
      statsPdfs.textContent = String(pdfCount);
      if (lastPdfTime) totalPdfDurationMs += (Date.now() - lastPdfTime);
      lastPdfTime = Date.now();
    }

    // Update averages
    if (userCount > 0) {
      statsAvgUser.textContent = formatDuration(Math.floor(totalUserDurationMs / userCount));
    }
    if (pdfCount > 0) {
      statsAvgPdf.textContent = formatDuration(Math.floor(totalPdfDurationMs / pdfCount));
    }

    // Only reset UI on global done or explicit stopped
    const isGlobalDone = msg.includes('No more work available');
    const isExplicitStopped = msg.includes('Scraping stopped');
    if (isGlobalDone || isExplicitStopped) {
      setTimeout(() => {
        stopBtn.style.display = 'none';
        startBtn.style.display = 'block';
        formSection.classList.remove('hidden');
        statusContainer.classList.remove('expanded');
      }, 2000);
    }
  }
});

console.log('Side panel loaded');
