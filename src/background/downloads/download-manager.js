/**
 * DOWNLOAD MANAGER MODULE
 *
 * Handles PDF download operations via Chrome Downloads API:
 * - Start downloads with conflict resolution
 * - Check download status
 * - Delete downloads
 */

/**
 * Start a PDF download
 *
 * @param {string} url - Blob URL or remote URL
 * @param {string} filename - Relative path for download (e.g., "jane-scraper/123_John/chart.pdf")
 * @param {boolean} saveAs - Show save dialog (default: false)
 * @returns {Promise<Object>} Result {success: boolean, downloadId?: number, error?: string}
 */
export async function downloadPdf(url, filename, saveAs = false) {
  return new Promise((resolve) => {
    chrome.downloads.download({
      url,
      filename,
      saveAs,
      conflictAction: 'overwrite'
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        resolve({
          success: false,
          error: chrome.runtime.lastError.message
        });
      } else {
        resolve({
          success: true,
          downloadId
        });
      }
    });
  });
}

/**
 * Check download status
 *
 * @param {number} downloadId - Chrome download ID
 * @returns {Promise<Object>} Result {state: string, mime?: string, filename?: string, finalUrl?: string, error?: string}
 */
export async function checkDownloadStatus(downloadId) {
  return new Promise((resolve) => {
    chrome.downloads.search({ id: downloadId }, (results) => {
      if (results && results.length > 0) {
        const item = results[0];
        resolve({
          state: item.state,
          mime: item.mime || '',
          filename: item.filename || '',
          finalUrl: item.finalUrl || item.url || '',
          error: item.error || ''
        });
      } else {
        resolve({ state: 'interrupted' });
      }
    });
  });
}

/**
 * Delete a downloaded file
 *
 * @param {number} downloadId - Chrome download ID
 * @returns {Promise<Object>} Result {success: boolean, error?: string}
 */
export async function deleteDownload(downloadId) {
  return new Promise((resolve) => {
    chrome.downloads.removeFile(downloadId, () => {
      if (chrome.runtime.lastError) {
        resolve({
          success: false,
          error: chrome.runtime.lastError.message
        });
      } else {
        // Also remove from download history
        chrome.downloads.erase({ id: downloadId }, () => {
          resolve({ success: true });
        });
      }
    });
  });
}

/**
 * Handle download-related messages
 *
 * @param {Object} request - Message request
 * @param {Object} sender - Message sender
 * @param {Function} sendResponse - Response callback
 * @returns {boolean} True if async response
 */
export function handleDownloadMessage(request, sender, sendResponse) {
  switch (request.action) {
    case 'downloadPDF':
      downloadPdf(request.url, request.filename, request.saveAs)
        .then((result) => {
          if (result.success) {
            sendResponse({ downloadId: result.downloadId });
          } else {
            sendResponse({ error: result.error });
          }
        });
      return true;

    case 'checkDownload':
      checkDownloadStatus(request.downloadId)
        .then((result) => sendResponse(result));
      return true;

    case 'deleteFile':
      deleteDownload(request.downloadId)
        .then((result) => sendResponse(result));
      return true;

    default:
      return false;
  }
}
