/**
 * PHASE ORCHESTRATOR
 *
 * State machine that drives the staff-first export through four phases:
 *   preflight -> discovery -> download -> profile -> done
 *
 * Model:
 *   - One "primary" tab owns Phases 0, 1, 3 (resolver, walker, profile scraper).
 *   - During Phase 2 the primary tab plays the role of worker T1 in parallel
 *     with T2..TN spawned on-demand.
 *   - After Phase 2 the T2..TN tabs close and the primary tab resumes for
 *     profile capture.
 *
 * Persistence keys in chrome.storage.local (non-secret):
 *   runConfig   { clinicName, numThreads, startedAt }
 *   runState    { phase, primaryTabId, workerTabIds: [...], staffNames }
 *   resolvedStaff [{ input_name, staff_id, staff_name }]
 *
 * Credentials are stored per-tab in `{threadId}_credentials` exactly like the
 * existing thread-manager does, so nothing changes for the PDF downloader.
 */

import { THREADING } from '../../shared/constants.js';
import { sendMessageWithRetry } from './thread-manager.js';
import {
  enqueueCharts,
  resetQueueForNewRun,
  recoverQueueOnStartup,
  getQueueProgress,
} from './chart-queue.js';
import { writeAllManifests } from '../manifest/manifest-writer.js';
import { clearProfiles, putProfile } from '../storage/chart-db.js';

const PHASES = Object.freeze({
  IDLE: 'idle',
  PREFLIGHT: 'preflight',
  DISCOVERY: 'discovery',
  DOWNLOAD: 'download',
  PROFILE: 'profile',
  DONE: 'done',
  STOPPED: 'stopped',
});

const MAX_THREADS = THREADING.MAX_THREADS;
let mutationChain = Promise.resolve();

function serialize(fn) {
  const next = mutationChain.then(fn, fn);
  mutationChain = next.catch(() => {});
  return next;
}

function notifyPanel(message, type = 'info') {
  const prefix = type === 'error' ? '[orchestrator:error]'
    : type === 'warn' ? '[orchestrator:warn]'
    : '[orchestrator]';
  console.log(`${prefix} ${message}`);
  try {
    chrome.runtime.sendMessage({ action: 'statusUpdate', status: { message, type } });
  } catch { /* panel may be closed */ }
}

function notifyPhase(phase, extras = {}) {
  console.log(`[orchestrator] phase → ${phase}`, extras);
  try {
    chrome.runtime.sendMessage({ action: 'phaseUpdate', phase, ...extras });
  } catch { /* panel may be closed */ }
}

async function getState() {
  const data = await chrome.storage.local.get(['runState', 'runConfig', 'resolvedStaff']);
  return {
    runState: data.runState || { phase: PHASES.IDLE },
    runConfig: data.runConfig || null,
    resolvedStaff: data.resolvedStaff || [],
  };
}

async function setState(patch) {
  const { runState } = await getState();
  const next = { ...runState, ...patch };
  await chrome.storage.local.set({ runState: next });
  return next;
}

async function setConfig(patch) {
  const cur = (await chrome.storage.local.get('runConfig')).runConfig || {};
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ runConfig: next });
  return next;
}

async function openPrimaryTab(clinicName) {
  const url = `https://${clinicName}.janeapp.com/admin`;
  const tab = await chrome.tabs.create({ url });
  return tab.id;
}

async function closeTabs(tabIds) {
  await Promise.all((tabIds || []).map((id) => new Promise((resolve) => {
    try {
      chrome.tabs.remove(id, () => resolve());
    } catch { resolve(); }
  })));
}

async function stashCredentials(threadId, credentials) {
  await chrome.storage.local.set({ [`${threadId}_credentials`]: credentials });
}

async function registerThreadTab(threadId, tabId) {
  const data = await chrome.storage.local.get('activeThreads');
  const map = data.activeThreads || {};
  map[threadId] = { tabId, status: 'active' };
  await chrome.storage.local.set({ activeThreads: map });
}

async function clearActiveThreads() {
  await chrome.storage.local.set({ activeThreads: {} });
}

export async function startStaffExport(payload) {
  return serialize(async () => {
    const {
      clinicName,
      email,
      password,
      numThreads = 2,
      staffNames = '',
    } = payload || {};

    if (!clinicName || !email || !password) {
      return { ok: false, error: 'Missing clinic/email/password' };
    }
    if (!Number.isInteger(numThreads) || numThreads < 1 || numThreads > MAX_THREADS) {
      return { ok: false, error: `Thread count must be 1..${MAX_THREADS}` };
    }

    await resetRunState();

    await setConfig({ clinicName, numThreads, startedAt: Date.now() });
    await chrome.storage.local.set({
      resolvedStaff: [],
      userRequestedStop: false,
      stopRequested: false,
    });

    await resetQueueForNewRun();
    await clearProfiles();
    await clearActiveThreads();

    const primaryTabId = await openPrimaryTab(clinicName);
    await setState({
      phase: PHASES.PREFLIGHT,
      primaryTabId,
      workerTabIds: [],
      staffNames,
    });
    await stashCredentials('T1', { clinicName, email, password });
    await registerThreadTab('T1', primaryTabId);

    notifyPhase(PHASES.PREFLIGHT);
    notifyPanel('Primary tab opened, logging in for pre-flight resolution', 'info');

    sendMessageWithRetry(primaryTabId, {
      action: 'initPreflight',
      threadId: 'T1',
      clinicName,
      email,
      password,
      staffNames,
    }).catch((e) => notifyPanel(`Preflight init failed: ${e.message}`, 'error'));

    return { ok: true, primaryTabId };
  });
}

export async function confirmStaffResolution(resolvedStaff) {
  return serialize(async () => {
    const { runState, runConfig } = await getState();
    if (runState.phase !== PHASES.PREFLIGHT) {
      return { ok: false, error: `Cannot confirm while phase=${runState.phase}` };
    }
    if (!Array.isArray(resolvedStaff) || resolvedStaff.length === 0) {
      return { ok: false, error: 'No staff resolved' };
    }
    await chrome.storage.local.set({ resolvedStaff });
    await setState({ phase: PHASES.DISCOVERY });
    notifyPhase(PHASES.DISCOVERY, { totalStaff: resolvedStaff.length });
    notifyPanel(`Phase 1: walking chart entries for ${resolvedStaff.length} staff`, 'info');

    sendMessageWithRetry(runState.primaryTabId, {
      action: 'beginDiscovery',
      threadId: 'T1',
      clinicName: runConfig.clinicName,
      resolvedStaff,
    }).catch((e) => notifyPanel(`Discovery init failed: ${e.message}`, 'error'));

    return { ok: true };
  });
}

async function spawnDownloadWorkers() {
  const { runState, runConfig } = await getState();
  const credData = await chrome.storage.local.get('T1_credentials');
  const credentials = credData.T1_credentials || {};
  const { clinicName } = runConfig;
  const numThreads = runConfig.numThreads || 2;
  const workerTabIds = [];

  sendMessageWithRetry(runState.primaryTabId, {
    action: 'beginDownload',
    threadId: 'T1',
    clinicName,
  }).catch((e) => notifyPanel(`T1 download init failed: ${e.message}`, 'error'));

  for (let i = 2; i <= numThreads; i++) {
    const threadId = `T${i}`;
    const tab = await chrome.tabs.create({ url: `https://${clinicName}.janeapp.com/admin` });
    workerTabIds.push(tab.id);
    await stashCredentials(threadId, credentials);
    await registerThreadTab(threadId, tab.id);
    const delayMs = (i - 1) * THREADING.THREAD_STAGGER_DELAY_MS;
    setTimeout(() => {
      sendMessageWithRetry(tab.id, {
        action: 'beginDownload',
        threadId,
        clinicName,
        email: credentials.email,
        password: credentials.password,
        loginDelayMs: delayMs,
      }).catch((e) => notifyPanel(`${threadId} init failed: ${e.message}`, 'error'));
    }, delayMs);
  }

  await setState({ workerTabIds });
}

export async function onDiscoveryComplete(payload) {
  return serialize(async () => {
    const { runState } = await getState();
    if (runState.phase !== PHASES.DISCOVERY) return { ok: false };
    notifyPanel(`Discovery complete: ${payload?.totalTuples || 0} charts queued`, 'success');
    await setState({ phase: PHASES.DOWNLOAD });
    notifyPhase(PHASES.DOWNLOAD, { totalTuples: payload?.totalTuples || 0 });
    await spawnDownloadWorkers();
    return { ok: true };
  });
}

export async function onWorkerFinishedDownload(threadId) {
  return serialize(async () => {
    const { runState, runConfig } = await getState();
    if (runState.phase !== PHASES.DOWNLOAD) return { ok: false };

    const progress = await getQueueProgress();
    const allDone = progress.pending === 0 && progress.in_flight === 0;
    if (!allDone) return { ok: true };

    const workerTabIds = runState.workerTabIds || [];
    await closeTabs(workerTabIds);
    await setState({ phase: PHASES.PROFILE, workerTabIds: [] });
    notifyPhase(PHASES.PROFILE);
    notifyPanel('Phase 3: capturing staff + patient profiles', 'info');

    sendMessageWithRetry(runState.primaryTabId, {
      action: 'beginProfile',
      threadId: 'T1',
      clinicName: runConfig.clinicName,
    }).catch((e) => notifyPanel(`Profile init failed: ${e.message}`, 'error'));

    return { ok: true };
  });
}

export async function onProfileComplete(payload) {
  return serialize(async () => {
    const { runState } = await getState();
    if (runState.phase !== PHASES.PROFILE) return { ok: false };
    notifyPanel(`Profiles captured: ${payload?.patients || 0} patients, ${payload?.staff || 0} staff`, 'success');
    try {
      const result = await writeAllManifests();
      notifyPanel(`Manifests written (${result.counts.connections} connections)`, 'success');
    } catch (error) {
      notifyPanel(`Manifest write failed: ${error.message}`, 'error');
    }

    await closeTabs([runState.primaryTabId]);
    await setState({ phase: PHASES.DONE, primaryTabId: null });
    notifyPhase(PHASES.DONE);
    notifyPanel('Export complete.', 'success');
    return { ok: true };
  });
}

export async function stopExport() {
  return serialize(async () => {
    const { runState } = await getState();
    const ids = [runState.primaryTabId, ...(runState.workerTabIds || [])].filter((id) => typeof id === 'number');
    await chrome.storage.local.set({ userRequestedStop: true, stopRequested: true });
    await Promise.all(ids.map((id) => new Promise((resolve) => {
      chrome.tabs.sendMessage(id, { action: 'stopScraping' }, () => resolve());
    })));
    setTimeout(() => closeTabs(ids), 800);
    await setState({ phase: PHASES.STOPPED, primaryTabId: null, workerTabIds: [] });
    await clearActiveThreads();
    notifyPhase(PHASES.STOPPED);
    notifyPanel('Export stopped by user.', 'warn');
    return { ok: true };
  });
}

export async function resetRunState() {
  await chrome.storage.local.set({
    runState: { phase: PHASES.IDLE },
    runConfig: null,
    resolvedStaff: [],
  });
  await recoverQueueOnStartup();
}

export async function getRunState() {
  const { runState, runConfig, resolvedStaff } = await getState();
  const progress = await getQueueProgress();
  return { ...runState, runConfig, resolvedStaff, progress };
}

export function handlePhaseMessage(request, sender, sendResponse) {
  switch (request.action) {
    case 'startStaffExport':
      startStaffExport(request).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'confirmStaffResolution':
      confirmStaffResolution(request.resolvedStaff || [])
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'stopExport':
      stopExport().then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'discoveryProgress':
      notifyPhase(PHASES.DISCOVERY, {
        staffCompleted: request.staffCompleted || 0,
        totalStaff: request.totalStaff || 0,
        tuplesFound: request.tuplesFound || 0,
      });
      sendResponse({ ok: true });
      return true;

    case 'enqueueCharts':
      enqueueCharts(request.tuples || [])
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'discoveryComplete':
      onDiscoveryComplete(request).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'workerFinishedDownload':
      onWorkerFinishedDownload(request.threadId).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'profileComplete':
      onProfileComplete(request).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    // Note: `preflightResults` is broadcast directly by the content script via
    // chrome.runtime.sendMessage, which already reaches the side panel — we
    // intentionally do NOT re-handle it here to avoid the panel processing
    // the same message twice and flipping its UI back to the form mid-run.

    case 'saveProfile':
      putProfile(request.type, request.id, request.record || {}, request.profile_status || 'ok')
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'getRunState':
      getRunState().then((state) => sendResponse({ ok: true, state })).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    default:
      return false;
  }
}

export const PHASE = PHASES;
