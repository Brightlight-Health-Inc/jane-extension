/**
 * Chart-entry tuple queue.
 *
 * Wraps chart-db.js with:
 *   - claim/release coordination per thread (similar in spirit to patientLocks)
 *   - progress counters cached in chrome.storage.local for the panel
 *   - message handlers for content-script workers:
 *       requestChart, completeChart, failChart, releaseChart, enqueueCharts
 *
 * All scheduler mutations are serialized through a single promise chain to avoid
 * races between concurrent tab requests. IndexedDB transactions are atomic on
 * their own, but serializing at this layer lets us also update the cached
 * counters consistently.
 */

import {
  addCharts,
  claimNextPending,
  markDone,
  markFailed,
  releaseInFlight,
  recoverInFlight,
  countByStatus,
  clearCharts,
  listCharts,
  listDistinctPatientIds,
} from '../storage/chart-db.js';

const PROGRESS_KEY = 'chartQueueProgress';
let mutationChain = Promise.resolve();

function serialize(fn) {
  const next = mutationChain.then(fn, fn);
  mutationChain = next.catch(() => {});
  return next;
}

async function refreshProgress() {
  const counts = await countByStatus();
  const total = counts.pending + counts.in_flight + counts.done + counts.failed;
  const progress = { ...counts, total, updated_at: Date.now() };
  await chrome.storage.local.set({ [PROGRESS_KEY]: progress });
  return progress;
}

export async function enqueueCharts(tuples) {
  return serialize(async () => {
    const added = await addCharts(tuples);
    const progress = await refreshProgress();
    return { added, progress };
  });
}

export async function requestChart(threadId) {
  return serialize(async () => {
    const stop = await chrome.storage.local.get(['userRequestedStop']);
    if (stop.userRequestedStop) return { status: 'stopped' };

    const claimed = await claimNextPending(threadId);
    if (!claimed) {
      const counts = await countByStatus();
      if (counts.pending === 0 && counts.in_flight === 0) return { status: 'done' };
      return { status: 'wait' };
    }
    await refreshProgress();
    return { status: 'ok', chart: claimed };
  });
}

export async function completeChart({ chartId, filePath }) {
  return serialize(async () => {
    await markDone(chartId, filePath);
    const progress = await refreshProgress();
    return { ok: true, progress };
  });
}

export async function failChart({ chartId, reason, retriable }) {
  return serialize(async () => {
    if (retriable) {
      await releaseInFlight(chartId);
    } else {
      await markFailed(chartId, reason || 'unknown');
    }
    const progress = await refreshProgress();
    return { ok: true, progress };
  });
}

export async function releaseChart(chartId) {
  return serialize(async () => {
    const released = await releaseInFlight(chartId);
    if (released) await refreshProgress();
    return { ok: released };
  });
}

export async function resetQueueForNewRun() {
  return serialize(async () => {
    await clearCharts();
    await chrome.storage.local.remove(PROGRESS_KEY);
    return refreshProgress();
  });
}

export async function recoverQueueOnStartup() {
  return serialize(async () => {
    const recovered = await recoverInFlight();
    const progress = await refreshProgress();
    return { recovered, progress };
  });
}

export async function getQueueProgress() {
  const stored = await chrome.storage.local.get(PROGRESS_KEY);
  if (stored[PROGRESS_KEY]) return stored[PROGRESS_KEY];
  return refreshProgress();
}

export async function getAllCharts(filter = {}) {
  return listCharts(filter);
}

export function handleChartQueueMessage(message, _sender, sendResponse) {
  switch (message.action) {
    case 'requestChart':
      requestChart(message.threadId)
        .then(sendResponse)
        .catch((error) => sendResponse({ status: 'error', error: error.message }));
      return true;

    case 'completeChart':
      completeChart({ chartId: message.chartId, filePath: message.filePath })
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    case 'failChart':
      failChart({ chartId: message.chartId, reason: message.reason, retriable: !!message.retriable })
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    case 'releaseChart':
      releaseChart(message.chartId)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    case 'enqueueCharts':
      enqueueCharts(message.tuples || [])
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    case 'getQueueProgress':
      getQueueProgress()
        .then((progress) => sendResponse({ ok: true, progress }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    case 'listPatientIds':
      listDistinctPatientIds()
        .then((ids) => sendResponse({ ok: true, ids }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    default:
      return false;
  }
}
