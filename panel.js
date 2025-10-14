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
const startMtBtn = document.getElementById('start-mt-btn');
const stopBtn = document.getElementById('stop-btn');
const statusMessages = document.getElementById('status-messages');
const statusCount = document.getElementById('status-count');
const formSection = document.getElementById('form-section');
const statusContainer = document.getElementById('status-container');

// Message history
let messageCount = 1; // Start at 1 for the initial "Ready" message

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
 * Validates the form fields, saves credentials to Chrome storage,
 * navigates the active tab to Jane App, and shows the status container.
 * The content script will automatically start scraping when it loads.
 */
startBtn.addEventListener('click', async () => {
  const clinicName = document.getElementById('clinic-name').value.trim();
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value.trim();

  if (!clinicName || !email || !password) {
    updateStatus('Please fill in all fields', 'error');
    return;
  }

  // Hide form and expand status
  formSection.classList.add('hidden');
  statusContainer.classList.add('expanded');

  // Show stop button, hide start button
  startBtn.style.display = 'none';
  stopBtn.style.display = 'block';

  updateStatus('Starting...');

  // Get active tab and navigate to Jane App
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const targetUrl = `https://${clinicName}.janeapp.com/admin`;

  // Navigate the tab to Jane App
  await chrome.tabs.update(tab.id, { url: targetUrl });

  // Save credentials for content script
  await chrome.storage.local.set({
    credentials: { clinicName, email, password }
  });

  updateStatus('Navigating to Jane App...');
});

// Start Multi-Thread button
startMtBtn.addEventListener('click', async () => {
  const clinicName = document.getElementById('clinic-name').value.trim();
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value.trim();

  if (!clinicName || !email || !password) {
    updateStatus('Please fill in all fields', 'error');
    return;
  }

  formSection.classList.add('hidden');
  statusContainer.classList.add('expanded');
  startBtn.style.display = 'none';
  startMtBtn.style.display = 'none';
  stopBtn.style.display = 'block';
  updateStatus('Starting multi-threaded scraping (2 tabs)...');

  // Ask background to start N threads and coordinate work
  chrome.runtime.sendMessage({
    action: 'startThreads',
    clinicName,
    email,
    password,
    startingIndex: 1,
    numThreads: 2,
    resume: false  // start clean; set true only when resuming a run
  }, (resp) => {
    if (chrome.runtime.lastError) {
      updateStatus('❌ Error: ' + chrome.runtime.lastError.message, 'error');
      return;
    }
    if (!resp || !resp.ok) {
      updateStatus('❌ Could not start threads: ' + (resp?.error || 'unknown'), 'error');
    } else {
      updateStatus('✅ Threads started');
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
  stopBtn.disabled = true;

  // Send stop message to content script
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { action: 'stopScraping' }, (response) => {
    if (chrome.runtime.lastError) {
      updateStatus('❌ Error stopping: ' + chrome.runtime.lastError.message, 'error');
    } else {
      updateStatus('⏹️ Scraping stopped', 'info');
    }

    // Reset UI
    stopBtn.style.display = 'none';
    startBtn.style.display = 'block';
    stopBtn.disabled = false;
    formSection.classList.remove('hidden');
    statusContainer.classList.remove('expanded');
  });
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
    updateStatus(request.status.message, request.status.type);

    // If scraping is complete, reset UI
    if (request.status.message.includes('complete') || request.status.message.includes('stopped')) {
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
