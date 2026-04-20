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
            console.warn(`[thread-manager] giving up after ${maxAttempts} attempts to tab ${tabId}: ${chrome.runtime.lastError.message}`);
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
      // Legacy helper: worker tabs that originated under the old patient-ID
      // flow called this to learn their assignment. Under the staff-first
      // model the phase orchestrator passes threadId directly in each
      // beginDownload / beginProfile message, so we answer "unknown" here
      // and let content-main fall back to storage state.
      sendResponse({ ok: false });
      return true;

    default:
      return false;
  }
}
