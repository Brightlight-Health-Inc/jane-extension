/**
 * PDF DOWNLOADER MODULE
 *
 * Handles PDF download operations:
 * - Fetch PDFs from Jane App with authentication
 * - Throttle requests to avoid rate limiting
 * - Save PDFs to organized folder structure
 * - Track download progress
 * - Handle download errors
 */

import { THROTTLE, TIMEOUTS } from '../../shared/constants.js';
import { sleep } from '../../shared/utils/async-utils.js';
import { cleanFilename } from '../../shared/utils/string-utils.js';

/**
 * Custom error for PDF download failures
 */
export class PdfDownloadError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'PdfDownloadError';
    this.cause = cause;
  }
}

/**
 * PDF Downloader class
 * Manages PDF fetching and downloading with throttling
 */
export class PdfDownloader {
  constructor(options = {}) {
    const {
      logger = null,
      getThreadKey = null, // Function to get thread-scoped storage key
      minFetchGap = THROTTLE.MIN_PDF_FETCH_GAP_MS
    } = options;

    this.logger = logger;
    this.getThreadKey = getThreadKey;
    this.minFetchGap = minFetchGap;
    this.currentPatientFiles = []; // Track files for current patient
    this.currentPatientDownloadIds = []; // Track download IDs
  }

  /**
   * Enforce minimum gap between PDF fetches (throttling)
   * Prevents rate limiting by Jane App
   *
   * @param {Function} shouldStop - Stop check function
   * @returns {Promise<void>}
   */
  async enforceThrottle(shouldStop = null) {
    try {
      const storageKey = this.getThreadKey ? this.getThreadKey('lastPdfFetchTs') : 'lastPdfFetchTs';

      // Global rate-limit gate: if any thread recently hit Jane's rate limit,
      // every thread waits until the pause window expires. Prevents cascades.
      const gate = await chrome.storage.local.get(['rateLimitUntil', storageKey]);
      const rateLimitUntil = Number(gate.rateLimitUntil || 0);
      const gateWait = rateLimitUntil - Date.now();
      if (gateWait > 0) {
        if (this.logger) {
          this.logger.info(`Global rate-limit gate: waiting ${Math.ceil(gateWait / 1000)}s`);
        }
        await sleep(gateWait, { shouldStop });
      }

      const lastTs = Number(gate[storageKey] || 0);
      const delta = Date.now() - lastTs;

      if (delta < this.minFetchGap) {
        const waitTime = this.minFetchGap - delta;

        if (this.logger) {
          this.logger.debug(`Throttling: waiting ${waitTime}ms before next fetch`);
        }

        await sleep(waitTime, { shouldStop });
      }

      // Update last fetch timestamp
      await chrome.storage.local.set({ [storageKey]: Date.now() });

    } catch (error) {
      if (this.logger) {
        this.logger.error('Failed to enforce throttle', error);
      }
      // Continue anyway, throttling is not critical
    }
  }

  /**
   * Fetch PDF from Jane App
   * Uses credentials included in cookies
   *
   * @param {string} pdfUrl - URL to fetch PDF from
   * @param {Function} shouldStop - Stop check function
   * @returns {Promise<Blob>} PDF blob
   * @throws {PdfDownloadError} If fetch fails
   */
  async fetchPdf(pdfUrl, shouldStop = null) {
    try {
      if (this.logger) {
        this.logger.info('Fetching PDF from server');
      }

      // Enforce throttling before fetch
      await this.enforceThrottle(shouldStop);

      const response = await this.fetchPdfResponse(pdfUrl, shouldStop);

      // Convert response to a blob (binary data)
      const blob = await response.blob();

      if (blob.size === 0) {
        throw new PdfDownloadError('Downloaded PDF is empty');
      }

      if (this.logger) {
        this.logger.debug(`Fetched PDF: ${blob.size} bytes`);
      }

      return blob;

    } catch (error) {
      if (error.message === 'Stopped' || error.message.includes('Stopped while')) {
        throw error; // Re-throw stop errors
      }

      if (error instanceof PdfDownloadError) {
        throw error;
      } else {
        throw new PdfDownloadError(`Failed to fetch PDF: ${error.message}`, error);
      }
    }
  }

  /**
   * Fetch a PDF response, retrying preview URLs when Jane serves HTML wrappers.
   *
   * @param {string} pdfUrl - URL to fetch
   * @param {Function} shouldStop - Stop check function
   * @param {Set<string>} visited - Tracks already-attempted URLs
   * @returns {Promise<Response>} Successful PDF response
   */
  async fetchPdfResponse(pdfUrl, shouldStop = null, visited = new Set()) {
    const urlToFetch = this.normalizePdfUrlInput(pdfUrl);

    if (!urlToFetch) {
      throw new PdfDownloadError('PDF URL is empty');
    }

    if (shouldStop && shouldStop()) {
      throw new Error('Stopped while fetching PDF');
    }

    if (visited.has(urlToFetch)) {
      throw new PdfDownloadError(`PDF fetch retry loop detected for ${urlToFetch}`);
    }

    visited.add(urlToFetch);

    const response = await fetch(urlToFetch, {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow',
      headers: {
        'Accept': 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': window.location.href,
        'User-Agent': navigator.userAgent
      }
    });

    const finalUrl = response.url || urlToFetch;
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const requestedPreviewUrl = this.isPreviewUrl(urlToFetch);
    const finalPreviewUrl = this.isPreviewUrl(finalUrl);

    if (!response.ok) {
      if (response.status === 406 && requestedPreviewUrl) {
        const directUrl = this.stripPreviewSuffix(urlToFetch);
        if (directUrl !== urlToFetch) {
          if (this.logger) {
            this.logger.debug(`PDF preview fetch returned 406, retrying direct file URL: ${directUrl}`);
          }
          return this.fetchPdfResponse(directUrl, shouldStop, visited);
        }
      }

      throw new PdfDownloadError(`PDF fetch failed: HTTP ${response.status}`);
    }

    if ((requestedPreviewUrl || finalPreviewUrl) && this.isHtmlContentType(contentType)) {
      const directUrl = this.stripPreviewSuffix(finalUrl);
      if (directUrl !== finalUrl) {
        if (this.logger) {
          this.logger.debug(`PDF preview returned HTML, retrying direct file URL: ${directUrl}`);
        }
        return this.fetchPdfResponse(directUrl, shouldStop, visited);
      }
    }

    if (this.isHtmlContentType(contentType)) {
      throw new PdfDownloadError(`PDF fetch returned HTML instead of a PDF (content-type: ${contentType || 'unknown'})`);
    }

    return response;
  }

  /**
   * Normalize an incoming PDF URL into an absolute string.
   *
   * @param {string} pdfUrl - Input URL
   * @returns {string} Absolute URL string
   */
  normalizePdfUrlInput(pdfUrl) {
    try {
      return new URL(pdfUrl, window.location.href).toString();
    } catch (error) {
      return pdfUrl || '';
    }
  }

  /**
   * Check whether a URL points at Jane's preview wrapper.
   *
   * @param {string} pdfUrl - URL to inspect
   * @returns {boolean} True if URL ends with /preview
   */
  isPreviewUrl(pdfUrl) {
    try {
      return new URL(pdfUrl, window.location.href).pathname.endsWith('/preview');
    } catch (error) {
      return /\/preview(?:$|[?#])/.test(pdfUrl || '');
    }
  }

  /**
   * Strip the trailing /preview segment from a Jane download URL.
   *
   * @param {string} pdfUrl - Preview URL
   * @returns {string} Direct download URL when possible
   */
  stripPreviewSuffix(pdfUrl) {
    try {
      const url = new URL(pdfUrl, window.location.href);
      url.pathname = url.pathname.replace(/\/preview$/, '');
      return url.toString();
    } catch (error) {
      return (pdfUrl || '').replace(/\/preview(?=$|[?#])/, '');
    }
  }

  /**
   * Check whether a response content type looks like HTML instead of a PDF.
   *
   * @param {string} contentType - Response content type header
   * @returns {boolean} True if content type is HTML-ish
   */
  isHtmlContentType(contentType) {
    return (
      contentType.includes('text/html') ||
      contentType.includes('application/xhtml') ||
      contentType.includes('text/plain')
    );
  }

  /**
   * Download PDF blob to disk via background script
   *
   * @param {Blob} blob - PDF blob to download
   * @param {string} filename - Filename to save as
   * @param {string} patientFolder - Folder path (e.g., "jane-scraper/123_John_Doe")
   * @param {Function} shouldStop - Stop check function
   * @returns {Promise<number>} Download ID
   * @throws {PdfDownloadError} If download fails
   */
  async downloadBlob(blob, filename, patientFolder, shouldStop = null) {
    try {
      if (this.logger) {
        this.logger.info('Saving PDF to Downloads folder');
      }

      // Create a temporary URL for the blob
      const blobUrl = URL.createObjectURL(blob);

      try {
        // Ask Chrome to download the file via background script
        const downloadId = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: 'downloadPDF',
            url: blobUrl,
            filename: `${patientFolder}/${filename}`,
            saveAs: false // Don't ask user where to save
          }, (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (response && response.error) {
              reject(new Error(response.error));
            } else if (response && response.downloadId) {
              resolve(response.downloadId);
            } else {
              reject(new Error('No download ID returned'));
            }
          });
        });

        // Wait for the download to complete
        await this.waitForDownloadComplete(downloadId, shouldStop);

        // Clean up the temporary blob URL
        URL.revokeObjectURL(blobUrl);

        if (this.logger) {
          this.logger.success('PDF saved successfully');
        }

        return downloadId;

      } catch (error) {
        // Make sure to clean up blob URL on error
        URL.revokeObjectURL(blobUrl);
        throw error;
      }

    } catch (error) {
      if (error.message === 'Stopped' || error.message.includes('Stopped while')) {
        throw error; // Re-throw stop errors
      }

      if (this.logger) {
        this.logger.error('PDF download failed', error);
      }

      throw new PdfDownloadError(`Failed to download PDF: ${error.message}`, error);
    }
  }

  /**
   * Download a remote PDF URL directly via Chrome's native download pipeline.
   * This is more reliable than fetch() for authenticated browser-style links.
   *
   * @param {string} downloadUrl - Direct PDF URL
   * @param {string} filename - Filename to save as
   * @param {string} patientFolder - Folder path
   * @param {Function} shouldStop - Stop check function
   * @returns {Promise<number>} Download ID
   */
  async downloadRemotePdf(downloadUrl, filename, patientFolder, shouldStop = null) {
    try {
      if (this.logger) {
        this.logger.info('Falling back to native browser download');
      }

      const downloadId = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: 'downloadPDF',
          url: downloadUrl,
          filename: `${patientFolder}/${filename}`,
          saveAs: false
        }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.error) {
            reject(new Error(response.error));
          } else if (response && response.downloadId) {
            resolve(response.downloadId);
          } else {
            reject(new Error('No download ID returned'));
          }
        });
      });

      await this.waitForDownloadComplete(downloadId, shouldStop, { expectPdf: true });

      if (this.logger) {
        this.logger.success('PDF saved successfully');
      }

      return downloadId;
    } catch (error) {
      if (error.message === 'Stopped' || error.message.includes('Stopped while')) {
        throw error;
      }

      throw new PdfDownloadError(`Native PDF download failed: ${error.message}`, error);
    }
  }

  /**
   * Wait for a download to complete
   *
   * @param {number} downloadId - Chrome download ID
   * @param {Function} shouldStop - Stop check function
   * @returns {Promise<void>}
   * @throws {PdfDownloadError} If download fails or times out
   */
  async waitForDownloadComplete(downloadId, shouldStop = null, options = {}) {
    const { expectPdf = false } = options;
    let downloadComplete = false;
    let attempts = 0;
    const maxAttempts = 60; // Try for up to 30 seconds

    while (!downloadComplete && attempts < maxAttempts) {
      if (shouldStop && shouldStop()) {
        throw new Error('Stopped while waiting for download');
      }

      // Check download status via background script
      const downloadState = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'checkDownload',
          downloadId: downloadId
        }, (response) => {
          resolve(response || { state: 'unknown' });
        });
      });

      if (downloadState.state === 'complete') {
        if (expectPdf && this.looksLikeHtmlDownload(downloadState)) {
          await this.deleteDownload(downloadId);
          throw new PdfDownloadError(
            `Native PDF download returned HTML instead of a PDF (content-type: ${downloadState.mime || 'unknown'})`
          );
        }
        downloadComplete = true;
      } else if (downloadState.state === 'interrupted') {
        throw new PdfDownloadError(`Download interrupted${downloadState.error ? `: ${downloadState.error}` : ''}`);
      }

      if (!downloadComplete) {
        await sleep(500, { shouldStop });
        attempts++;
      }
    }

    if (!downloadComplete) {
      throw new PdfDownloadError('Download timed out');
    }
  }

  /**
   * Delete an invalid download file and erase it from history.
   *
   * @param {number} downloadId - Chrome download ID
   * @returns {Promise<void>}
   */
  async deleteDownload(downloadId) {
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: 'deleteFile',
        downloadId
      }, () => resolve());
    });
  }

  /**
   * Check whether a completed download looks like HTML rather than a PDF.
   *
   * @param {Object} downloadState - Download status payload from background
   * @returns {boolean} True if the download appears to be HTML
   */
  looksLikeHtmlDownload(downloadState = {}) {
    const mime = (downloadState.mime || '').toLowerCase();
    const filename = (downloadState.filename || '').toLowerCase();

    return (
      this.isHtmlContentType(mime) ||
      filename.endsWith('.html') ||
      filename.endsWith('.htm')
    );
  }

  /**
   * Determine whether a fetch failure should fall back to native download.
   *
   * @param {Error} error - Fetch error
   * @returns {boolean} True if native download should be attempted
   */
  shouldUseNativeFallback(error) {
    const message = (error?.message || '').toLowerCase();

    return (
      message.includes('html instead of a pdf') ||
      message.includes('http 406') ||
      message.includes('http 401') ||
      message.includes('http 403') ||
      message.includes('failed to fetch') ||
      message.includes('pdf fetch failed')
    );
  }

  /**
   * Download a PDF file and save it to disk
   * Main entry point for PDF downloads
   *
   * @param {string} pdfUrl - URL to fetch PDF from
   * @param {string} filename - Filename to save as
   * @param {string} patientName - Patient name (for folder organization)
   * @param {number} patientId - Patient ID (for folder organization)
   * @param {Object} options - Configuration
   * @param {Function} options.shouldStop - Stop check function
   * @returns {Promise<Object>} Result {success: boolean, downloadId?: number}
   */
  async downloadPdfWithCookies(pdfUrl, filename, patientName, patientId, options = {}) {
    const { shouldStop = null } = options;

    try {
      // Clean patient name for folder
      const cleanPatientName = cleanFilename(patientName, {
        replacement: '_',
        collapseRepeats: true
      });

      const patientFolder = `jane-scraper/${patientId}_${cleanPatientName}`;

      let downloadId = null;

      try {
        // Fetch the PDF
        const blob = await this.fetchPdf(pdfUrl, shouldStop);

        // Store blob in memory for tracking
        this.currentPatientFiles.push({ filename, blob });

        // Download blob to disk
        downloadId = await this.downloadBlob(blob, filename, patientFolder, shouldStop);
      } catch (error) {
        if (error.message === 'Stopped' || error.message.includes('Stopped while')) {
          throw error;
        }

        if (!this.shouldUseNativeFallback(error)) {
          throw error;
        }

        const directUrl = this.stripPreviewSuffix(this.normalizePdfUrlInput(pdfUrl));
        downloadId = await this.downloadRemotePdf(directUrl, filename, patientFolder, shouldStop);
      }

      // Track this download
      this.currentPatientDownloadIds.push(downloadId);

      return {
        success: true,
        downloadId
      };

    } catch (error) {
      if (error.message === 'Stopped' || error.message.includes('Stopped while')) {
        if (this.logger) {
          this.logger.warn('PDF download stopped by user');
        }
        throw error; // Re-throw stop errors
      }

      if (this.logger) {
        this.logger.error('PDF download failed', error);
      }

      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Clear tracking for current patient
   * Call this when moving to next patient
   */
  clearPatientData() {
    this.currentPatientFiles = [];
    this.currentPatientDownloadIds = [];

    if (this.logger) {
      this.logger.debug('Cleared patient download data');
    }
  }

  /**
   * Get current patient file count
   */
  getFileCount() {
    return this.currentPatientFiles.length;
  }

  /**
   * Get current patient download IDs
   */
  getDownloadIds() {
    return [...this.currentPatientDownloadIds];
  }
}
