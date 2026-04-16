/**
 * URL UTILITIES
 *
 * URL manipulation helpers:
 * - buildJaneUrl: Construct Jane App URLs
 * - getClinicNameFromUrl: Extract clinic name from hostname
 * - parseJaneUrl: Parse Jane App URLs into components
 */

import { PATTERNS } from '../constants.js';

/**
 * Extract clinic name from current URL hostname
 * Example: "bedfordskinclinic" from "bedfordskinclinic.janeapp.com"
 *
 * @param {string} url - URL or hostname (optional, defaults to window.location.hostname)
 * @returns {string} Clinic name or empty string
 */
export function getClinicNameFromUrl(url = null) {
  try {
    const hostname = url
      ? (new URL(url).hostname)
      : (window.location.hostname || '');

    const match = hostname.match(PATTERNS.CLINIC_NAME_FROM_HOSTNAME);
    return match ? match[1] : '';
  } catch (error) {
    console.warn('Failed to parse clinic name from URL:', error);
    return '';
  }
}

/**
 * Build a Jane App URL
 *
 * Jane App uses a hybrid routing pattern:
 * - Server route: /admin
 * - Hash route: #patients/1
 * - Combined: https://clinic.janeapp.com/admin#patients/1
 *
 * @param {string} clinicName - Clinic subdomain
 * @param {string} path - Path (e.g., "admin/patients/1", "admin/schedule")
 * @param {Object} options - Configuration
 * @param {boolean} options.hash - Use hash-based routing (default: true for Jane's SPA)
 * @param {Object} options.params - Query parameters to add
 * @returns {string} Full Jane App URL
 */
export function buildJaneUrl(clinicName, path = '', options = {}) {
  const {
    hash = true,
    params = null
  } = options;

  if (!clinicName) {
    throw new Error('Clinic name is required');
  }

  // Build base URL
  const baseUrl = `https://${clinicName}.janeapp.com`;

  // Build URL with hash routing (Jane's default)
  if (hash) {
    // Jane App uses /admin as server route, then hash routing
    // E.g., "admin/patients/1" → "/admin#patients/1"
    const cleanPath = path.startsWith('/') ? path.substring(1) : path;

    if (cleanPath.startsWith('admin/')) {
      // Split: "admin/patients/1" → server="/admin", hash="#patients/1"
      const hashPart = cleanPath.substring(6); // Remove "admin/"
      let url = `${baseUrl}/admin#${hashPart}`;

      // Add query parameters if provided
      if (params) {
        const queryString = new URLSearchParams(params).toString();
        if (queryString) {
          url += `?${queryString}`;
        }
      }

      return url;
    } else if (cleanPath === 'admin') {
      // Just "admin" → "/admin"
      return `${baseUrl}/admin`;
    } else {
      // Other routes use root with hash: "foo/bar" → "/#foo/bar"
      let url = `${baseUrl}/#${cleanPath}`;

      // Add query parameters if provided
      if (params) {
        const queryString = new URLSearchParams(params).toString();
        if (queryString) {
          url += `?${queryString}`;
        }
      }

      return url;
    }
  }

  // Build URL with standard routing (no hash)
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  let url = `${baseUrl}${cleanPath}`;

  // Add query parameters if provided
  if (params) {
    const queryString = new URLSearchParams(params).toString();
    if (queryString) {
      url += `?${queryString}`;
    }
  }

  return url;
}

/**
 * Build URL to Jane App admin
 *
 * @param {string} clinicName - Clinic subdomain
 * @returns {string} Admin URL
 */
export function buildAdminUrl(clinicName) {
  return buildJaneUrl(clinicName, 'admin');
}

/**
 * Build URL to patient page
 *
 * @param {string} clinicName - Clinic subdomain
 * @param {number} patientId - Patient ID
 * @returns {string} Patient page URL
 */
export function buildPatientUrl(clinicName, patientId) {
  return buildJaneUrl(clinicName, `admin/patients/${patientId}`);
}

/**
 * Build URL to patient charts page
 *
 * @param {string} clinicName - Clinic subdomain
 * @param {number} patientId - Patient ID
 * @returns {string} Charts page URL
 */
export function buildChartsUrl(clinicName, patientId) {
  return buildJaneUrl(clinicName, `admin/patients/${patientId}/charts`);
}

/**
 * Build URL to chart entry page
 *
 * @param {string} clinicName - Clinic subdomain
 * @param {number} patientId - Patient ID
 * @param {number} chartEntryId - Chart entry ID
 * @returns {string} Chart entry URL
 */
export function buildChartEntryUrl(clinicName, patientId, chartEntryId) {
  return buildJaneUrl(clinicName, `admin/patients/${patientId}/chart_entries/${chartEntryId}`, { hash: false });
}

/**
 * Build URL to schedule page
 *
 * @param {string} clinicName - Clinic subdomain
 * @returns {string} Schedule URL
 */
export function buildScheduleUrl(clinicName) {
  return buildJaneUrl(clinicName, 'admin/schedule');
}

/**
 * Parse a Jane App URL into components
 *
 * @param {string} url - Jane App URL to parse
 * @returns {Object} Parsed components {clinicName, patientId, chartEntryId, section}
 */
export function parseJaneUrl(url) {
  try {
    const urlObj = new URL(url);
    const clinicName = getClinicNameFromUrl(url);

    // Extract path (handle both hash and non-hash routing)
    let path = urlObj.hash ? urlObj.hash.substring(1) : urlObj.pathname;

    // Remove leading slash
    if (path.startsWith('/')) {
      path = path.substring(1);
    }

    // Parse patient ID
    const patientMatch = path.match(/patients\/(\d+)/);
    const patientId = patientMatch ? parseInt(patientMatch[1], 10) : null;

    // Parse chart entry ID
    const chartMatch = path.match(/chart_entries\/(\d+)/);
    const chartEntryId = chartMatch ? parseInt(chartMatch[1], 10) : null;

    // Determine section
    let section = null;
    if (path.includes('/charts')) {
      section = 'charts';
    } else if (path.includes('/chart_entries/')) {
      section = 'chart_entry';
    } else if (path.includes('/patients/')) {
      section = 'patient';
    } else if (path.includes('/admin')) {
      section = 'admin';
    }

    return {
      clinicName,
      patientId,
      chartEntryId,
      section,
      fullPath: path
    };
  } catch (error) {
    console.warn('Failed to parse Jane URL:', error);
    return {
      clinicName: null,
      patientId: null,
      chartEntryId: null,
      section: null,
      fullPath: null
    };
  }
}

/**
 * Check if current page is a Jane App page
 *
 * @returns {boolean} True if on Jane App
 */
export function isJaneAppPage() {
  try {
    return window.location.hostname.endsWith('.janeapp.com');
  } catch {
    return false;
  }
}

/**
 * Check if current page is the admin area
 *
 * @returns {boolean} True if in admin
 */
export function isAdminPage() {
  try {
    return window.location.href.includes('/admin') ||
           window.location.hash.includes('admin');
  } catch {
    return false;
  }
}

/**
 * Get current patient ID from URL
 *
 * @returns {number|null} Patient ID or null
 */
export function getCurrentPatientId() {
  const parsed = parseJaneUrl(window.location.href);
  return parsed.patientId;
}

/**
 * Get current chart entry ID from URL
 *
 * @returns {number|null} Chart entry ID or null
 */
export function getCurrentChartEntryId() {
  const parsed = parseJaneUrl(window.location.href);
  return parsed.chartEntryId;
}
