/**
 * THREAD MANAGER MODULE
 *
 * Slim utilities reused by the staff-first phase orchestrator:
 *   - sendMessageWithRetry: retries sending a message to a tab until the
 *     content script responds (content scripts take a moment to boot).
 *   - getThreadAssignment: let a tab ask which thread ID it owns.
 *
 * The old patient-ID coordination (startThreads, stopAllThreads, activeThreads
 * registry) was replaced by phase-orchestrator.js in the staff-first rewrite.
 */

/**
 * Send a message to a tab with retry logic. Content scripts take time to
 * load, so we retry until they respond or maxAttempts is exhausted.
 */
export async function sendMessageWithRetry(tabId, message, maxAttempts = 30, delayMs = 1000) {
  return new Promise((resolve) => {
    let attempt = 0;
    const trySend = () => {
      attempt++;
      chrome.tabs.sendMessage(tabId, message, (_response) => {
        if (chrome.runtime.lastError) {
          if (attempt >= maxAttempts) {
            const err = chrome.runtime.lastError.message || 'unknown';
            const msg = `[thread-manager] giving up after ${maxAttempts} attempts to tab ${tabId} (${message?.action}): ${err}`;
            console.warn(msg);
            try {
              // Surface to panel so the user sees the failure instead of a silent stall.
              chrome.runtime.sendMessage({
                action: 'statusUpdate',
                status: { message: `Tab ${tabId} unreachable for action=${message?.action}: ${err}`, type: 'error' },
              });
            } catch { /* panel may be closed */ }
            return resolve(false);
          }
          setTimeout(trySend, delayMs);
        } else {
          resolve(true);
        }
      });
    };
    trySend();
  });
}

export function handleThreadMessage(request, sender, sendResponse) {
  switch (request.action) {
    case 'getThreadAssignment':
      // Look the tab up in the orchestrator-maintained activeThreads map so
      // content-main can recover its threadId after a page reload (e.g. the
      // login form submit that repaints the admin page). The orchestrator
      // populates this map when it spawns each primary/worker tab.
      (async () => {
        try {
          const tabId = sender?.tab?.id;
          if (typeof tabId !== 'number') {
            sendResponse({ ok: false });
            return;
          }
          const data = await chrome.storage.local.get('activeThreads');
          const map = data.activeThreads || {};
          const entry = Object.entries(map).find(([, v]) => v?.tabId === tabId);
          if (entry) {
            sendResponse({ ok: true, threadId: entry[0] });
          } else {
            sendResponse({ ok: false });
          }
        } catch (error) {
          sendResponse({ ok: false, error: error.message });
        }
      })();
      return true;

    default:
      return false;
  }
}
