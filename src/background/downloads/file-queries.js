/**
 * FILE QUERIES MODULE
 *
 * Query Chrome Downloads for existing files:
 * - Count PDFs for a patient
 * - Check if specific file exists
 * - Find patient folders
 */

/**
 * Count how many PDFs exist for a patient
 *
 * @param {number} patientId - Patient ID
 * @param {string} folderName - Optional folder name (e.g., "John_Doe")
 * @returns {Promise<Object>} Result {ok: boolean, count?: number, error?: string}
 */
export async function countPatientPdfs(patientId, folderName = null) {
  try {
    const regex = folderName
      ? `jane-scraper/${patientId}_${folderName}/.*\\.pdf$`
      : `jane-scraper/${patientId}_[^/]+/.*\\.pdf$`;

    const results = await chrome.downloads.search({
      filenameRegex: regex,
      exists: true
    });

    return {
      ok: true,
      count: (results || []).length
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error)
    };
  }
}

/**
 * Check if a specific file exists in patient folder
 *
 * @param {number} patientId - Patient ID
 * @param {string} filenamePrefix - Filename to check (e.g., "2024-01-15_Chart.pdf")
 * @returns {Promise<Object>} Result {ok: boolean, exists?: boolean, error?: string}
 */
export async function fileExistsInPatientFolder(patientId, filenamePrefix) {
  try {
    // Escape special regex characters in filename
    const escaped = (filenamePrefix || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Pattern matches: jane-scraper/123_PatientName/filename.pdf
    const regex = `jane-scraper/${patientId}_[^/]+/${escaped}$`;

    const results = await chrome.downloads.search({
      filenameRegex: regex,
      exists: true
    });

    return {
      ok: true,
      exists: !!(results && results.length > 0)
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error)
    };
  }
}

/**
 * Find all patient folders with existing downloads
 *
 * @returns {Promise<Object>} Patient folders map {patientId: {patientId, folderName, pdfCount}}
 */
export async function findPatientFolders() {
  try {
    // Search for all PDFs in jane-scraper folders
    const downloads = await chrome.downloads.search({
      filenameRegex: 'jane-scraper/\\d+_[^/]+/.*\\.pdf$',
      exists: true
    });

    // Group PDFs by patient folder
    const patientFolders = {};

    for (const download of downloads || []) {
      // Extract patient ID and folder name from path
      // Example: jane-scraper/123_JohnDoe/chart.pdf
      const match = download.filename && download.filename.match(/jane-scraper\/(\d+)_([^/]+)\//);

      if (match) {
        const patientId = parseInt(match[1], 10);

        if (!Number.isNaN(patientId) && download.filename.endsWith('.pdf')) {
          if (!patientFolders[patientId]) {
            patientFolders[patientId] = {
              patientId: patientId,
              folderName: match[2],
              pdfCount: 0
            };
          }
          patientFolders[patientId].pdfCount++;
        }
      }
    }

    return patientFolders;
  } catch (error) {
    console.error('Failed to find patient folders:', error);
    return {};
  }
}

/**
 * Find legacy ZIP files (old format)
 *
 * @returns {Promise<Object>} Completed patients map {patientId: {filename, endTime}}
 */
export async function findLegacyZipFiles() {
  try {
    const zips = await chrome.downloads.search({
      filenameRegex: 'jane-scraper/\\d+_.+\\.zip$',
      exists: true
    });

    const completedPatients = {};

    for (const download of zips || []) {
      const match = download.filename && download.filename.match(/\/(\d+)_[^/]+\.zip$/);

      if (match) {
        const patientId = parseInt(match[1], 10);

        if (!Number.isNaN(patientId)) {
          completedPatients[patientId] = {
            filename: download.filename,
            endTime: download.endTime
          };
        }
      }
    }

    return completedPatients;
  } catch (error) {
    console.error('Failed to find legacy ZIP files:', error);
    return {};
  }
}

/**
 * Handle file query messages
 *
 * @param {Object} request - Message request
 * @param {Object} sender - Message sender
 * @param {Function} sendResponse - Response callback
 * @returns {boolean} True if async response
 */
export function handleFileQueryMessage(request, sender, sendResponse) {
  switch (request.action) {
    case 'countPatientPdfs':
      countPatientPdfs(request.patientId, request.folderName)
        .then((result) => sendResponse(result));
      return true;

    case 'fileExistsInPatientFolder':
      fileExistsInPatientFolder(request.patientId, request.filenamePrefix)
        .then((result) => sendResponse(result));
      return true;

    default:
      return false;
  }
}
