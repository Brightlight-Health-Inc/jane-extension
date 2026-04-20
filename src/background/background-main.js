/**
 * BACKGROUND SERVICE WORKER (Main Entry Point)
 *
 * Coordinates the staff-first chart export:
 * - Opens the side panel when you click the extension icon
 * - Routes messages to specialized handlers
 * - Drives the phase state machine (preflight -> discovery -> download -> profile)
 */

import { handleDownloadMessage } from './downloads/download-manager.js';
import { handleFileQueryMessage } from './downloads/file-queries.js';
import { handleThreadMessage } from './coordinator/thread-manager.js';
import { handleChartQueueMessage } from './coordinator/chart-queue.js';
import { handlePhaseMessage, resetRunState } from './coordinator/phase-orchestrator.js';

chrome.runtime.onInstalled.addListener(() => {});

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.runtime.onStartup.addListener(() => {
  resetRunState().catch((error) => console.warn('resetRunState failed:', error));
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (handleDownloadMessage(request, sender, sendResponse)) return true;
  if (handleFileQueryMessage(request, sender, sendResponse)) return true;
  if (handleThreadMessage(request, sender, sendResponse)) return true;
  if (handleChartQueueMessage(request, sender, sendResponse)) return true;
  if (handlePhaseMessage(request, sender, sendResponse)) return true;

  sendResponse({ received: true });
  return true;
});
