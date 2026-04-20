/**
 * Phase dispatcher wires the staff-first phase handlers into content-main.
 *
 * Responsibilities:
 *   - handle the four phase-kickoff messages from the background orchestrator
 *   - persist a thread-scoped `phaseState` so a page reload (common in Jane's
 *     admin after navigation) can resume the current phase mid-flight
 *   - defer to the discovery/walker/download/profile modules for the actual work
 *
 * Usage:
 *   const dispatcher = createPhaseDispatcher({ getContext });
 *   chrome.runtime.onMessage.addListener((req, sender, send) =>
 *     dispatcher.handleMessage(req, sender, send));
 *   await dispatcher.resumeFromStorage(); // on boot
 *
 * `getContext` returns { threadId, logger, pdfDownloader, fileChecker,
 *                        ensureLoggedIn(clinicName), shouldStop() }
 */

import { resolveStaffList } from './staff-resolver.js';
import { walkStaffEntries } from './staff-entries-walker.js';
import { runDownloadLoop } from './download-worker.js';
import { scrapeAllProfiles } from './profile-scraper.js';

export function createPhaseDispatcher({ getContext }) {
  function stateKey() {
    const { threadId } = getContext();
    return threadId ? `${threadId}_phaseState` : null;
  }

  async function saveState(state) {
    const key = stateKey();
    if (!key) return;
    await chrome.storage.local.set({ [key]: state });
  }

  async function clearState() {
    const key = stateKey();
    if (!key) return;
    await chrome.storage.local.remove(key);
  }

  async function runPreflight({ clinicName, staffNames }) {
    const ctx = getContext();
    await ctx.ensureLoggedIn(clinicName);
    await saveState({ action: 'preflight', clinicName, staffNames });

    const { rows } = await resolveStaffList({
      clinicName,
      staffNames,
      logger: ctx.logger,
      shouldStop: ctx.shouldStop,
    });

    chrome.runtime.sendMessage({ action: 'preflightResults', rows });
    // intentionally don't clear state — user might reopen the panel and we
    // want the last resolver snapshot on record until `beginDiscovery` lands
  }

  async function runDiscovery({ clinicName, resolvedStaff, staffIndex = 0 }) {
    const ctx = getContext();
    await ctx.ensureLoggedIn(clinicName);

    let tuplesFound = 0;
    for (let i = staffIndex; i < resolvedStaff.length; i++) {
      if (ctx.shouldStop()) return;
      const staff = resolvedStaff[i];
      await saveState({ action: 'discovery', clinicName, resolvedStaff, staffIndex: i });
      const res = await walkStaffEntries({
        clinicName,
        staffId: staff.staff_id,
        staffName: staff.staff_name,
        logger: ctx.logger,
        shouldStop: ctx.shouldStop,
      });
      tuplesFound += res?.tuples || 0;
      try {
        chrome.runtime.sendMessage({
          action: 'discoveryProgress',
          staffCompleted: i + 1,
          totalStaff: resolvedStaff.length,
          tuplesFound,
        });
      } catch { /* panel may be closed */ }
    }

    chrome.runtime.sendMessage({ action: 'discoveryComplete', totalTuples: tuplesFound });
    await clearState();
  }

  async function runDownload({ clinicName }) {
    const ctx = getContext();
    await ctx.ensureLoggedIn(clinicName);
    await saveState({ action: 'download', clinicName });

    await runDownloadLoop({
      threadId: ctx.threadId,
      clinicName,
      logger: ctx.logger,
      shouldStop: ctx.shouldStop,
      pdfDownloader: ctx.pdfDownloader,
      fileChecker: ctx.fileChecker,
    });

    await clearState();
  }

  async function runProfile({ clinicName }) {
    const ctx = getContext();
    await ctx.ensureLoggedIn(clinicName);
    await saveState({ action: 'profile', clinicName });

    const progress = await chrome.runtime.sendMessage({ action: 'getQueueProgress' });
    const wantStaffIds = progress?.progress?.staff_ids || [];
    const wantPatientIds = progress?.progress?.patient_ids || [];

    const resolvedStaffWrap = await chrome.storage.local.get('resolvedStaff');
    const staffIds = (resolvedStaffWrap.resolvedStaff || [])
      .map((s) => String(s.staff_id));

    const charts = await chrome.runtime.sendMessage({ action: 'getQueueProgress' });
    // If the background exposes chart listing via a message, use it; otherwise,
    // ask for patient ids via a dedicated message.
    const uniquePatientIds = wantPatientIds.length > 0 ? wantPatientIds
      : await requestPatientIdsFromBackground();

    await scrapeAllProfiles({
      clinicName,
      staffIds: staffIds.length > 0 ? staffIds : wantStaffIds,
      patientIds: uniquePatientIds,
      logger: ctx.logger,
      shouldStop: ctx.shouldStop,
    });

    chrome.runtime.sendMessage({
      action: 'profileComplete',
      staff: staffIds.length,
      patients: uniquePatientIds.length,
    });
    await clearState();
  }

  async function requestPatientIdsFromBackground() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'listPatientIds' }, (res) => {
        resolve(Array.isArray(res?.ids) ? res.ids : []);
      });
    });
  }

  async function resumeFromStorage() {
    const key = stateKey();
    if (!key) return false;
    const wrap = await chrome.storage.local.get(key);
    const state = wrap[key];
    if (!state || !state.action) return false;

    switch (state.action) {
      case 'preflight':
        runPreflight(state).catch((err) => console.warn('preflight resume failed', err));
        return true;
      case 'discovery':
        runDiscovery(state).catch((err) => console.warn('discovery resume failed', err));
        return true;
      case 'download':
        runDownload(state).catch((err) => console.warn('download resume failed', err));
        return true;
      case 'profile':
        runProfile(state).catch((err) => console.warn('profile resume failed', err));
        return true;
      default:
        return false;
    }
  }

  function handleMessage(request, _sender, sendResponse) {
    switch (request.action) {
      case 'initPreflight':
        sendResponse({ ok: true });
        runPreflight({ clinicName: request.clinicName, staffNames: request.staffNames })
          .catch((err) => console.warn('initPreflight failed', err));
        return false;

      case 'beginDiscovery':
        sendResponse({ ok: true });
        runDiscovery({ clinicName: request.clinicName, resolvedStaff: request.resolvedStaff })
          .catch((err) => console.warn('beginDiscovery failed', err));
        return false;

      case 'beginDownload':
        sendResponse({ ok: true });
        runDownload({ clinicName: request.clinicName })
          .catch((err) => console.warn('beginDownload failed', err));
        return false;

      case 'beginProfile':
        sendResponse({ ok: true });
        runProfile({ clinicName: request.clinicName })
          .catch((err) => console.warn('beginProfile failed', err));
        return false;

      default:
        return false;
    }
  }

  return { handleMessage, resumeFromStorage };
}
