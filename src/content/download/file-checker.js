/**
 * FILE CHECKER MODULE
 *
 * Handles file existence checking and duplicate prevention:
 * - Check if file already downloaded
 * - Query downloads folder
 * - Coordinate with background script for file system access
 */

/**
 * Custom error for file checking failures
 */
export class FileCheckError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'FileCheckError';
    this.cause = cause;
  }
}

/**
 * File Checker class
 * Provides utilities for checking file existence
 */
export class FileChecker {
  constructor(options = {}) {
    const {
      logger = null
    } = options;

    this.logger = logger;
  }

  /**
   * Check if a file already exists in downloads
   * Queries background script for file system access
   *
   * @param {string} filename - Filename to check (relative path in downloads)
   * @param {Object} options - Configuration
   * @param {number} options.timeout - Max time to wait for response (ms)
   * @returns {Promise<boolean>} True if file exists
   */
  async fileExists(filename, options = {}) {
    const { timeout = 5000 } = options;

    try {
      if (this.logger) {
        this.logger.debug(`Checking if file exists: ${filename}`);
      }

      // Query background script for file existence
      const response = await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error('File check timed out'));
        }, timeout);

        chrome.runtime.sendMessage({
          action: 'checkFileExists',
          filename: filename
        }, (response) => {
          clearTimeout(timeoutId);

          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.error) {
            reject(new Error(response.error));
          } else {
            resolve(response?.exists || false);
          }
        });
      });

      return response;

    } catch (error) {
      if (this.logger) {
        this.logger.error(`Failed to check file existence: ${filename}`, error);
      }
      // Return false on error (assume file doesn't exist, will try to download)
      return false;
    }
  }

  /**
   * Check multiple files for existence
   *
   * @param {Array<string>} filenames - Array of filenames to check
   * @returns {Promise<Object>} Map of filename -> exists boolean
   */
  async checkMultipleFiles(filenames) {
    try {
      const results = {};

      // Check files in parallel
      const checks = filenames.map(async (filename) => {
        const exists = await this.fileExists(filename);
        results[filename] = exists;
      });

      await Promise.all(checks);

      return results;

    } catch (error) {
      if (this.logger) {
        this.logger.error('Failed to check multiple files', error);
      }
      throw new FileCheckError(`Failed to check multiple files: ${error.message}`, error);
    }
  }

  /**
   * Get count of files in a folder
   *
   * @param {string} folderPath - Folder path to count files in
   * @param {Object} options - Configuration
   * @param {number} options.timeout - Max time to wait for response (ms)
   * @returns {Promise<number>} Number of files in folder
   */
  async countFilesInFolder(folderPath, options = {}) {
    const { timeout = 5000 } = options;

    try {
      if (this.logger) {
        this.logger.debug(`Counting files in folder: ${folderPath}`);
      }

      // Query background script for file count
      const response = await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error('Folder count timed out'));
        }, timeout);

        chrome.runtime.sendMessage({
          action: 'countFilesInFolder',
          folderPath: folderPath
        }, (response) => {
          clearTimeout(timeoutId);

          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.error) {
            reject(new Error(response.error));
          } else {
            resolve(response?.count || 0);
          }
        });
      });

      return response;

    } catch (error) {
      if (this.logger) {
        this.logger.error(`Failed to count files in folder: ${folderPath}`, error);
      }
      // Return 0 on error
      return 0;
    }
  }

  /**
   * Check if patient folder already has files
   * Useful for resuming interrupted scrapes
   *
   * @param {number} patientId - Patient ID
   * @param {string} patientName - Patient name
   * @returns {Promise<Object>} Result {exists: boolean, count: number}
   */
  async checkPatientFolder(patientId, patientName) {
    try {
      // Build folder path (same format as PdfDownloader)
      const cleanPatientName = patientName.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_');
      const folderPath = `jane-scraper/${patientId}_${cleanPatientName}`;

      const count = await this.countFilesInFolder(folderPath);

      return {
        exists: count > 0,
        count
      };

    } catch (error) {
      if (this.logger) {
        this.logger.error(`Failed to check patient folder for ID ${patientId}`, error);
      }

      return {
        exists: false,
        count: 0
      };
    }
  }

  /**
   * Filter out already-downloaded files from a list
   *
   * @param {Array<string>} filenames - Array of filenames to filter
   * @returns {Promise<Array<string>>} Array of files that don't exist yet
   */
  async filterExistingFiles(filenames) {
    try {
      const existsMap = await this.checkMultipleFiles(filenames);

      const newFiles = filenames.filter(filename => !existsMap[filename]);

      if (this.logger) {
        const existingCount = filenames.length - newFiles.length;
        if (existingCount > 0) {
          this.logger.info(`${existingCount} files already exist, skipping`);
        }
      }

      return newFiles;

    } catch (error) {
      if (this.logger) {
        this.logger.error('Failed to filter existing files', error);
      }
      // On error, return all files (attempt to download them)
      return filenames;
    }
  }
}

/**
 * Convenience function to check if a file exists
 * Simplified API for one-off checks
 *
 * @param {string} filename - Filename to check
 * @param {Object} options - Configuration
 * @param {Object} options.logger - Logger instance
 * @returns {Promise<boolean>} True if file exists
 */
export async function checkFileExists(filename, options = {}) {
  const { logger = null } = options;

  const checker = new FileChecker({ logger });
  return await checker.fileExists(filename);
}
