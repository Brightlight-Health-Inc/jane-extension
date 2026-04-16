/**
 * STRING UTILITIES
 *
 * String manipulation helpers:
 * - cleanFilename: Sanitize strings for safe filenames
 * - sanitizeForPath: Clean strings for file paths
 * - truncate: Limit string length
 * - escapeRegex: Escape special regex characters
 */

/**
 * Clean a string for use as a filename
 * Removes/replaces characters that are invalid in filenames
 *
 * @param {string} str - String to clean
 * @param {Object} options - Configuration
 * @param {string} options.replacement - Character to replace invalid chars with (default: '_')
 * @param {boolean} options.collapseRepeats - Collapse repeated replacements (default: true)
 * @param {number} options.maxLength - Maximum length (default: null, no limit)
 * @returns {string} Cleaned filename
 */
export function cleanFilename(str, options = {}) {
  const {
    replacement = '_',
    collapseRepeats = true,
    maxLength = null
  } = options;

  if (!str || typeof str !== 'string') {
    return '';
  }

  // Replace invalid filename characters with replacement
  // Invalid: / \ : * ? " < > |
  let cleaned = str.replace(/[/\\:*?"<>|]/g, replacement);

  // Also replace non-alphanumeric characters (except - and .)
  cleaned = cleaned.replace(/[^a-z0-9\-_.]/gi, replacement);

  // Collapse repeated replacement characters if enabled
  if (collapseRepeats && replacement) {
    const escapedReplacement = replacement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const repeatPattern = new RegExp(`${escapedReplacement}+`, 'g');
    cleaned = cleaned.replace(repeatPattern, replacement);
  }

  // Trim replacement characters from start and end
  if (replacement) {
    const escapedReplacement = replacement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const trimPattern = new RegExp(`^${escapedReplacement}+|${escapedReplacement}+$`, 'g');
    cleaned = cleaned.replace(trimPattern, '');
  }

  // Truncate if maxLength specified
  if (maxLength && cleaned.length > maxLength) {
    cleaned = cleaned.substring(0, maxLength);
  }

  return cleaned;
}

/**
 * Sanitize a string for use in file paths
 * More permissive than cleanFilename, allows forward slashes
 *
 * @param {string} str - String to sanitize
 * @returns {string} Sanitized path string
 */
export function sanitizeForPath(str) {
  if (!str || typeof str !== 'string') {
    return '';
  }

  // Replace backslashes with forward slashes
  let cleaned = str.replace(/\\/g, '/');

  // Remove invalid path characters (except /)
  cleaned = cleaned.replace(/[*?"<>|]/g, '_');

  // Remove leading/trailing slashes and whitespace
  cleaned = cleaned.replace(/^[/\s]+|[/\s]+$/g, '');

  // Collapse multiple slashes
  cleaned = cleaned.replace(/\/+/g, '/');

  return cleaned;
}

/**
 * Truncate a string to a maximum length
 *
 * @param {string} str - String to truncate
 * @param {number} maxLength - Maximum length
 * @param {string} suffix - Suffix to add if truncated (default: '...')
 * @returns {string} Truncated string
 */
export function truncate(str, maxLength, suffix = '...') {
  if (!str || typeof str !== 'string') {
    return '';
  }

  if (str.length <= maxLength) {
    return str;
  }

  const truncateLength = maxLength - suffix.length;
  return str.substring(0, truncateLength) + suffix;
}

/**
 * Escape special regex characters in a string
 * Useful for building regex patterns from user input
 *
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
export function escapeRegex(str) {
  if (!str || typeof str !== 'string') {
    return '';
  }

  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalize whitespace in a string
 * Replaces multiple spaces/tabs/newlines with single space
 *
 * @param {string} str - String to normalize
 * @returns {string} Normalized string
 */
export function normalizeWhitespace(str) {
  if (!str || typeof str !== 'string') {
    return '';
  }

  return str.replace(/\s+/g, ' ').trim();
}

/**
 * Convert string to title case
 *
 * @param {string} str - String to convert
 * @returns {string} Title cased string
 */
export function toTitleCase(str) {
  if (!str || typeof str !== 'string') {
    return '';
  }

  return str.replace(/\w\S*/g, (word) => {
    return word.charAt(0).toUpperCase() + word.substr(1).toLowerCase();
  });
}

/**
 * Remove accents/diacritics from string
 * Useful for search/comparison
 *
 * @param {string} str - String to remove accents from
 * @returns {string} String without accents
 */
export function removeAccents(str) {
  if (!str || typeof str !== 'string') {
    return '';
  }

  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Check if string is empty or only whitespace
 *
 * @param {string} str - String to check
 * @returns {boolean} True if empty or whitespace
 */
export function isEmpty(str) {
  return !str || typeof str !== 'string' || str.trim().length === 0;
}

/**
 * Pad string to specified length
 *
 * @param {string} str - String to pad
 * @param {number} length - Target length
 * @param {string} char - Character to pad with (default: ' ')
 * @param {string} side - Side to pad: 'left', 'right', 'both' (default: 'right')
 * @returns {string} Padded string
 */
export function pad(str, length, char = ' ', side = 'right') {
  if (!str || typeof str !== 'string') {
    str = '';
  }

  if (str.length >= length) {
    return str;
  }

  const padLength = length - str.length;

  if (side === 'left') {
    return char.repeat(padLength) + str;
  } else if (side === 'both') {
    const leftPad = Math.floor(padLength / 2);
    const rightPad = padLength - leftPad;
    return char.repeat(leftPad) + str + char.repeat(rightPad);
  } else {
    return str + char.repeat(padLength);
  }
}
