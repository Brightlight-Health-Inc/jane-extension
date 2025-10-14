/**
 * BACKGROUND SERVICE WORKER
 * 
 * This is the main background script for the Jane Scraper extension.
 * It handles extension lifecycle events, manages the side panel, and 
 * coordinates PDF downloads from the Jane App platform.
 * 
 * Key responsibilities:
 * - Opens the side panel when the extension icon is clicked
 * - Handles PDF download requests from content scripts
 * - Checks download status for in-progress downloads
 */

/**
 * Handles extension installation event
 * Logs a confirmation message when the extension is first installed or updated
 */
chrome.runtime.onInstalled.addListener(() => {
  console.log('Jane Scraper installed');
});

/**
 * Opens the side panel when the extension icon is clicked
 * 
 * @param {chrome.tabs.Tab} tab - The currently active tab where the icon was clicked
 * @returns {Promise<void>} Resolves when the side panel is opened
 */
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

/**
 * Handles messages from other parts of the extension (content scripts, side panel)
 * 
 * Supported actions:
 * - 'downloadPDF': Downloads a PDF file to the tmp directory
 * - 'checkDownload': Checks the status of a download by ID
 * 
 * @param {Object} request - The message request object
 * @param {string} request.action - The action to perform ('downloadPDF' or 'checkDownload')
 * @param {string} [request.url] - The blob URL to download (for downloadPDF action)
 * @param {string} [request.filename] - The filename to save as (for downloadPDF action)
 * @param {number} [request.downloadId] - The download ID to check (for checkDownload action)
 * @param {chrome.runtime.MessageSender} sender - Information about the message sender
 * @param {Function} sendResponse - Function to call with the response
 * @returns {boolean} True to indicate the response will be sent asynchronously
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Message:', request.action);

  if (request.action === 'downloadPDF') {
    // Download PDF to specific directory
    chrome.downloads.download({
      url: request.url,
      filename: request.filename,
      saveAs: false,
      conflictAction: 'overwrite'
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ downloadId: downloadId });
      }
    });
    return true; // Keep channel open for async response
  }

  if (request.action === 'checkDownload') {
    // Check download status
    chrome.downloads.search({ id: request.downloadId }, (results) => {
      if (results && results.length > 0) {
        sendResponse({ state: results[0].state });
      } else {
        sendResponse({ state: 'interrupted' });
      }
    });
    return true;
  }

  if (request.action === 'deleteFile') {
    // Delete a downloaded file
    chrome.downloads.removeFile(request.downloadId, () => {
      if (chrome.runtime.lastError) {
        console.warn('Delete file error:', chrome.runtime.lastError.message);
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        // Also remove from download history
        chrome.downloads.erase({ id: request.downloadId }, () => {
          sendResponse({ success: true });
        });
      }
    });
    return true;
  }

  sendResponse({ received: true });
  return true;
});
