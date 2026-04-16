/**
 * BACKGROUND SERVICE WORKER (Main Entry Point)
 *
 * This coordinates everything for the Jane Scraper extension:
 * - Opens the side panel when you click the extension icon
 * - Routes messages to specialized handlers
 * - Manages PDF downloads
 * - Coordinates multi-threaded scraping
 */

import { handleDownloadMessage } from './downloads/download-manager.js';
import { handleFileQueryMessage } from './downloads/file-queries.js';
import { handleThreadMessage, sendMessageWithRetry } from './coordinator/thread-manager.js';
import { handleWorkMessage } from './coordinator/work-scheduler.js';

// ============================================================================
// EXTENSION SETUP
// ============================================================================

/**
 * Runs when extension is first installed
 */
chrome.runtime.onInstalled.addListener(() => {
});

/**
 * Open the side panel when user clicks the extension icon
 */
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

// ============================================================================
// MESSAGE ROUTER
// ============================================================================
//
// Routes all messages from content scripts and side panel to specialized handlers
// ============================================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Try each specialized handler
  // Each handler returns true if it handled the message (async response)

  // Download operations
  if (handleDownloadMessage(request, sender, sendResponse)) {
    return true;
  }

  // File queries
  if (handleFileQueryMessage(request, sender, sendResponse)) {
    return true;
  }

  // Thread management
  if (handleThreadMessage(request, sender, sendResponse)) {
    return true;
  }

  // Work scheduling
  if (handleWorkMessage(request, sender, sendResponse)) {
    return true;
  }

  // Appointments export (single tab, no threads)
  if (request.action === 'startAppointments') {
    (async () => {
      try {
        const { clinicName, email, password, startDate, endDate } = request;
        const tab = await chrome.tabs.create({ url: `https://${clinicName}.janeapp.com/admin` });
        const ok = await sendMessageWithRetry(tab.id, {
          action: 'initAppointments',
          clinicName,
          email,
          password,
          startDate,
          endDate
        });
        sendResponse({ ok });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  // Migration export (appointments + patients, single tab)
  if (request.action === 'startMigration') {
    (async () => {
      try {
        const { clinicName, email, password, startDate, endDate } = request;
        const tab = await chrome.tabs.create({ url: `https://${clinicName}.janeapp.com/admin` });
        const ok = await sendMessageWithRetry(tab.id, {
          action: 'initMigration',
          clinicName,
          email,
          password,
          startDate,
          endDate
        });
        sendResponse({ ok });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  // Default response for unknown actions
  sendResponse({ received: true });
  return true;
});
