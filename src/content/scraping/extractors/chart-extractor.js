/**
 * CHART EXTRACTOR MODULE
 *
 * Extracts chart entries from Jane App charts page:
 * - Parse chart panels from DOM
 * - Extract chart entry IDs
 * - Extract header text (date + title)
 * - Provide structured chart data
 *
 * This implements the extractor plugin pattern for future extensibility.
 */

/**
 * Custom error for chart extraction failures
 */
export class ChartExtractionError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'ChartExtractionError';
    this.cause = cause;
  }
}

/**
 * Extract all chart entries from the charts page
 * Returns an array of chart objects with header text, ID, and index
 *
 * @param {Object} options - Configuration
 * @param {Object} options.logger - Logger instance
 * @returns {Promise<Array>} Array of chart entry objects
 * @throws {ChartExtractionError} If extraction fails
 */
export async function extractChartEntries(options = {}) {
  const { logger = null } = options;

  try {
    const entries = [];
    const panels = document.querySelectorAll('div.panel.panel-default.chart-entry.panel-no-gap');

    if (logger) {
      logger.debug(`Found ${panels.length} chart panels to extract`);
    }

    for (let i = 0; i < panels.length; i++) {
      const panel = panels[i];

      try {
        const entry = extractSingleChartEntry(panel, i, { logger });
        entries.push(entry);
      } catch (error) {
        if (logger) {
          logger.error(`Failed to extract chart entry ${i}`, error);
        }
        // Continue with next entry even if one fails
      }
    }

    if (logger) {
      logger.info(`Extracted ${entries.length} chart entries`);
    }

    return entries;

  } catch (error) {
    if (logger) {
      logger.error('Chart extraction failed', error);
    }

    throw new ChartExtractionError(`Failed to extract chart entries: ${error.message}`, error);
  }
}

/**
 * Extract a single chart entry from a panel element
 *
 * @param {Element} panel - The panel DOM element
 * @param {number} index - Index in the list
 * @param {Object} options - Configuration
 * @param {Object} options.logger - Logger instance
 * @returns {Object} Chart entry {headerText, chartEntryId, index, dateText, titleText}
 */
function extractSingleChartEntry(panel, index, options = {}) {
  const { logger = null } = options;

  // Get the header container that has date and title
  const headerContainer = panel.querySelector('div.ellipsis-after-3-lines.flex-order-sm-2.flex-item.flex-pull-left');

  let dateText = '';
  let titleText = '';

  // Extract date and title from the header
  const dateSpan = headerContainer?.querySelector('span[data-test-id="chart_entry_header_date"]');
  const titleSpan = headerContainer?.querySelector('span[data-test-id="chart_entry_header_title"]');

  if (dateSpan) dateText = dateSpan.textContent.trim();
  if (titleSpan) titleText = titleSpan.textContent.trim();

  // Combine date and title for a readable header
  const headerText = `${dateText} ${titleText}`.trim();

  // Get the chart entry ID from the print/PDF link
  let chartEntryId = '';
  const printLink = panel.querySelector('a[href*="/admin/patients/"][href*="/chart_entries/"][target="_blank"]');

  if (printLink) {
    const href = printLink.getAttribute('href') || '';
    const match = href.match(/\/chart_entries\/(\d+)/);
    if (match) {
      chartEntryId = match[1];
    }
  }

  if (logger) {
    logger.debug(`Extracted chart entry ${index}: ID=${chartEntryId}, header="${headerText}"`);
  }

  return {
    headerText,
    chartEntryId,
    index,
    dateText,
    titleText
  };
}

/**
 * Validate chart entry data
 * Checks if chart entry has required fields
 *
 * @param {Object} entry - Chart entry object
 * @returns {boolean} True if entry is valid
 */
export function validateChartEntry(entry) {
  return !!(entry && entry.chartEntryId && entry.chartEntryId.length > 0);
}

/**
 * Filter out invalid chart entries
 *
 * @param {Array} entries - Array of chart entries
 * @param {Object} options - Configuration
 * @param {Object} options.logger - Logger instance
 * @returns {Array} Filtered array of valid entries
 */
export function filterValidEntries(entries, options = {}) {
  const { logger = null } = options;

  const validEntries = entries.filter(entry => validateChartEntry(entry));

  if (logger) {
    const invalidCount = entries.length - validEntries.length;
    if (invalidCount > 0) {
      logger.warn(`Filtered out ${invalidCount} invalid chart entries`);
    }
  }

  return validEntries;
}

/**
 * Get chart entry count from page
 * Quick check without extracting full data
 *
 * @returns {number} Number of chart panels found
 */
export function getChartCount() {
  try {
    return document.querySelectorAll('div.panel.panel-default.chart-entry.panel-no-gap').length;
  } catch (error) {
    return 0;
  }
}

/**
 * Check if charts page has any entries
 *
 * @returns {boolean} True if charts exist
 */
export function hasCharts() {
  return getChartCount() > 0;
}

/**
 * Build PDF URL for a chart entry
 *
 * @param {string} clinicName - Clinic subdomain
 * @param {number} patientId - Patient ID
 * @param {string} chartEntryId - Chart entry ID
 * @returns {string} PDF URL
 */
export function buildChartPdfUrl(clinicName, patientId, chartEntryId) {
  return `https://${clinicName}.janeapp.com/admin/patients/${patientId}/chart_entries/${chartEntryId}.pdf`;
}

/**
 * Generate safe filename for chart PDF
 * Removes special characters and ensures valid filename
 *
 * @param {Object} entry - Chart entry object
 * @param {number} index - Index in list (for uniqueness)
 * @param {Object} options - Configuration
 * @param {string} options.prefix - Optional prefix for filename
 * @param {string} options.extension - File extension (default: 'pdf')
 * @returns {string} Safe filename
 */
export function generateChartFilename(entry, index, options = {}) {
  const {
    prefix = 'chart',
    extension = 'pdf'
  } = options;

  // Use header text if available, otherwise use ID
  let baseName = entry.headerText || `entry_${entry.chartEntryId}`;

  // Clean the filename (remove special characters)
  baseName = baseName.replace(/[^a-z0-9\-_.]/gi, '_').replace(/_+/g, '_');

  // Trim leading/trailing underscores
  baseName = baseName.replace(/^_+|_+$/g, '');

  // Add index for uniqueness
  const paddedIndex = String(index + 1).padStart(3, '0');

  return `${prefix}_${paddedIndex}_${baseName}.${extension}`;
}

/**
 * Base Extractor class for plugin architecture
 * Future extractors (invoices, files) can extend this
 */
export class BaseExtractor {
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Get extractor name
   * Override in subclasses
   */
  getName() {
    throw new Error('BaseExtractor.getName() must be implemented');
  }

  /**
   * Check if this extractor can extract from current page
   * Override in subclasses
   */
  async canExtract(patientId) {
    throw new Error('BaseExtractor.canExtract() must be implemented');
  }

  /**
   * Extract data from current page
   * Override in subclasses
   */
  async extract(patientId, patientName) {
    throw new Error('BaseExtractor.extract() must be implemented');
  }
}

/**
 * Chart Extractor implementation
 * Implements the extractor plugin pattern
 */
export class ChartExtractor extends BaseExtractor {
  getName() {
    return 'Charts';
  }

  async canExtract(patientId) {
    // Charts can be extracted if there are chart panels on the page
    return hasCharts();
  }

  async extract(patientId, patientName) {
    const entries = await extractChartEntries({ logger: this.logger });
    const validEntries = filterValidEntries(entries, { logger: this.logger });

    return {
      success: true,
      count: validEntries.length,
      entries: validEntries
    };
  }
}
