/**
 * Phase dispatcher wires the staff-first phase handlers into content-main.
 *
 * Responsibilities:
 *   - handle the four phase-kickoff messages from the background orchestrator
 *   - persist a thread-scoped `phaseState` so a page reload (common in Jane's
 *     admin after navigation) can resume the current phase mid-flight
 *   - defer to the discovery/walker/download/profile modules for the actual work
 *
 * Logging: each phase emits `info` entries at entry + exit and on significant
 * state transitions, so the panel log reads as a readable trace. The
 * underlying modules emit their own finer-grained debug logs to the console.
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
    ctx.logger?.info?.('[phase] PRE-FLIGHT begin');
    try {
      await ctx.ensureLoggedIn(clinicName);
      ctx.logger?.info?.('[phase] login confirmed, scanning staff directory');
      await saveState({ action: 'preflight', clinicName, staffNames });

      const { rows, directorySize } = await resolveStaffList({
        clinicName,
        staffNames,
        logger: ctx.logger,
        shouldStop: ctx.shouldStop,
      });

      const ok = rows.filter((r) => r.status === 'ok').length;
      const amb = rows.filter((r) => r.status === 'ambiguous').length;
      const miss = rows.filter((r) => r.status === 'not_found').length;
      ctx.logger?.info?.(`[phase] PRE-FLIGHT result: ${ok} ok, ${amb} ambiguous, ${miss} not-found (of ${directorySize} staff in directory)`);

      chrome.runtime.sendMessage({ action: 'preflightResults', rows });
      // Clear the persisted state so a later page reload (e.g. user navigating
      // before clicking Start) doesn't re-run preflight in an infinite loop.
      await clearState();
    } catch (error) {
      ctx.logger?.error?.(`[phase] PRE-FLIGHT failed: ${error.message}`);
      throw error;
    }
  }

  async function runDiscovery({ clinicName, resolvedStaff, staffIndex = 0 }) {
    const ctx = getContext();
    ctx.logger?.info?.(`[phase] DISCOVERY begin: ${resolvedStaff.length} staff total, resuming at index ${staffIndex}`);
    try {
      await ctx.ensureLoggedIn(clinicName);

      let tuplesFound = 0;
      for (let i = staffIndex; i < resolvedStaff.length; i++) {
        if (ctx.shouldStop()) {
          ctx.logger?.warn?.('[phase] discovery stopped by user');
          return;
        }
        const staff = resolvedStaff[i];
        ctx.logger?.info?.(`[phase] discovery staff ${i + 1}/${resolvedStaff.length}: ${staff.staff_name} (id=${staff.staff_id})`);
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
        } catch { /* panel closed */ }
      }

      ctx.logger?.info?.(`[phase] DISCOVERY complete: ${tuplesFound} tuples across ${resolvedStaff.length} staff`);
      chrome.runtime.sendMessage({ action: 'discoveryComplete', totalTuples: tuplesFound });
      await clearState();
    } catch (error) {
      ctx.logger?.error?.(`[phase] DISCOVERY failed: ${error.message}`);
      throw error;
    }
  }

  async function runDownload({ clinicName }) {
    const ctx = getContext();
    ctx.logger?.info?.(`[phase] DOWNLOAD begin for thread ${ctx.threadId}`);
    try {
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

      ctx.logger?.info?.(`[phase] DOWNLOAD worker ${ctx.threadId} finished`);
      await clearState();
    } catch (error) {
      ctx.logger?.error?.(`[phase] DOWNLOAD failed: ${error.message}`);
      throw error;
    }
  }

  async function runProfile({ clinicName }) {
    const ctx = getContext();
    ctx.logger?.info?.('[phase] PROFILE begin');
    try {
      await ctx.ensureLoggedIn(clinicName);
      await saveState({ action: 'profile', clinicName });

      const resolvedStaffWrap = await chrome.storage.local.get('resolvedStaff');
      const staffIds = (resolvedStaffWrap.resolvedStaff || [])
        .map((s) => String(s.staff_id))
        .filter(Boolean);

      const patientIds = await requestPatientIdsFromBackground();
      ctx.logger?.info?.(`[phase] profile targets: ${staffIds.length} staff, ${patientIds.length} patients`);

      await scrapeAllProfiles({
        clinicName,
        staffIds,
        patientIds,
        logger: ctx.logger,
        shouldStop: ctx.shouldStop,
      });

      ctx.logger?.info?.('[phase] PROFILE complete, notifying background');
      chrome.runtime.sendMessage({
        action: 'profileComplete',
        staff: staffIds.length,
        patients: patientIds.length,
      });
      await clearState();
    } catch (error) {
      ctx.logger?.error?.(`[phase] PROFILE failed: ${error.message}`);
      throw error;
    }
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

    const ctx = getContext();
    ctx.logger?.info?.(`[phase] resuming ${state.action} from persisted state`);

    switch (state.action) {
      case 'preflight':
        runPreflight(state).catch((err) => ctx.logger?.error?.(`preflight resume failed: ${err.message}`));
        return true;
      case 'discovery':
        runDiscovery(state).catch((err) => ctx.logger?.error?.(`discovery resume failed: ${err.message}`));
        return true;
      case 'download':
        runDownload(state).catch((err) => ctx.logger?.error?.(`download resume failed: ${err.message}`));
        return true;
      case 'profile':
        runProfile(state).catch((err) => ctx.logger?.error?.(`profile resume failed: ${err.message}`));
        return true;
      default:
        return false;
    }
  }

  function handleMessage(request, _sender, sendResponse) {
    const ctx = getContext();
    switch (request.action) {
      case 'initPreflight':
        ctx.logger?.debug?.(`[phase] received initPreflight for clinic=${request.clinicName}`);
        sendResponse({ ok: true });
        runPreflight({ clinicName: request.clinicName, staffNames: request.staffNames })
          .catch((err) => ctx.logger?.error?.(`initPreflight failed: ${err.message}`));
        return false;

      case 'beginDiscovery':
        ctx.logger?.debug?.(`[phase] received beginDiscovery (${request.resolvedStaff?.length || 0} staff)`);
        sendResponse({ ok: true });
        runDiscovery({ clinicName: request.clinicName, resolvedStaff: request.resolvedStaff })
          .catch((err) => ctx.logger?.error?.(`beginDiscovery failed: ${err.message}`));
        return false;

      case 'beginDownload':
        ctx.logger?.debug?.(`[phase] received beginDownload (thread=${request.threadId})`);
        sendResponse({ ok: true });
        runDownload({ clinicName: request.clinicName })
          .catch((err) => ctx.logger?.error?.(`beginDownload failed: ${err.message}`));
        return false;

      case 'beginProfile':
        ctx.logger?.debug?.(`[phase] received beginProfile`);
        sendResponse({ ok: true });
        runProfile({ clinicName: request.clinicName })
          .catch((err) => ctx.logger?.error?.(`beginProfile failed: ${err.message}`));
        return false;

      default:
        return false;
    }
  }

  return { handleMessage, resumeFromStorage };
}
