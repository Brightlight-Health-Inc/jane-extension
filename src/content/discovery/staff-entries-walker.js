/**
 * Phase 1 — walk a staff member's chart-entries page and extract tuples.
 *
 * The staff chart-entries page reuses the same chart-entry component that
 * the existing patient-page extractor already handles, so we can lean on
 * the same selectors. The only difference is the *route*: the page lives
 * at /admin/staff/<id>/chart_entries and each entry's print link still
 * points at /admin/patients/<pid>/chart_entries/<cid> — which gives us
 * the patient_id directly.
 *
 * Flow per staff:
 *   1. Navigate to /admin/staff/<staff_id>/chart_entries
 *   2. Wait for chart panels to render (reused from charts-nav.js)
 *   3. Click "Load More" until all panels are present (reused)
 *   4. Extract each panel into a tuple with chart_id, patient_id,
 *      patient_name, chart_type, chart_date, chart_url
 */

import { sleep } from '../../shared/utils/async-utils.js';
import { TIMEOUTS, PATTERNS } from '../../shared/constants.js';
import {
  waitForChartsLoaded,
  loadAllCharts,
} from '../navigation/charts-nav.js';

const PANEL_SELECTOR = 'div.panel.panel-default.chart-entry.panel-no-gap';
const DATE_SELECTOR = 'span[data-test-id="chart_entry_header_date"]';
const TITLE_SELECTOR = 'span[data-test-id="chart_entry_header_title"]';
const HEADER_CONTAINER_SELECTOR = 'div.ellipsis-after-3-lines.flex-order-sm-2.flex-item.flex-pull-left';
const PRINT_LINK_SELECTOR = 'a[href*="/admin/patients/"][href*="/chart_entries/"]';

function buildStaffChartsUrl(clinicName, staffId) {
  return `https://${clinicName}.janeapp.com/admin/staff/${staffId}/chart_entries`;
}

function textOf(el) {
  return el ? (el.textContent || '').trim() : '';
}

function extractPanelTuple(panel, { staffId, staffName }) {
  const header = panel.querySelector(HEADER_CONTAINER_SELECTOR);
  const dateText = textOf(header?.querySelector(DATE_SELECTOR));
  const titleText = textOf(header?.querySelector(TITLE_SELECTOR));

  const printLink = panel.querySelector(PRINT_LINK_SELECTOR);
  const href = printLink ? printLink.getAttribute('href') || '' : '';
  const chartIdMatch = href.match(PATTERNS.CHART_ENTRY_ID);
  const patientIdMatch = href.match(/\/admin\/patients\/(\d+)\//);
  if (!chartIdMatch || !patientIdMatch) return null;

  const chartId = chartIdMatch[1];
  const patientId = patientIdMatch[1];

  // The panel renders the patient name somewhere in the row. Jane's markup
  // hasn't been fully pinned in our design recon, so we fall back through
  // a few reasonable candidates.
  const patientNameCandidate = panel.querySelector('[data-test-id="chart_entry_patient_name"]')
    || panel.querySelector('a[href*="/admin/patients/"][href*="/profile"]')
    || panel.querySelector('a[href^="/admin/patients/"]');
  const patientName = textOf(patientNameCandidate);

  return {
    chart_id: chartId,
    chart_type: titleText || 'Chart',
    chart_date: dateText || null,
    patient_id: patientId,
    patient_name: patientName || null,
    staff_id: String(staffId),
    staff_name: staffName || null,
    chart_url: href.startsWith('http') ? href : `${window.location.origin}${href}`,
  };
}

async function enqueueBatch(tuples) {
  if (!tuples.length) return;
  await chrome.runtime.sendMessage({ action: 'enqueueCharts', tuples });
}

export async function walkStaffEntries({ clinicName, staffId, staffName, logger, shouldStop, onFreeze }) {
  const check = () => (shouldStop ? shouldStop() : false);

  logger?.info?.(`Walking chart_entries for staff ${staffId} (${staffName})`);
  window.location.href = buildStaffChartsUrl(clinicName, staffId);
  await sleep(TIMEOUTS.CHARTS_PAGE_LOAD, { shouldStop });

  const loaded = await waitForChartsLoaded({ maxWaitMs: TIMEOUTS.CHARTS_RENDER, shouldStop: check, logger });
  if (check()) return { status: 'stopped', tuples: 0 };
  if (!loaded) {
    const freeze = await chrome.storage.local.get('frozen');
    if (freeze?.frozen && onFreeze) await onFreeze({ clinicName, staffId });
    return { status: 'no_load', tuples: 0 };
  }

  const panelsNow = document.querySelectorAll(PANEL_SELECTOR);
  if (panelsNow.length === 0) {
    return { status: 'no_charts', tuples: 0 };
  }

  await loadAllCharts({ maxClicks: 500, shouldStop: check, logger });

  const panels = document.querySelectorAll(PANEL_SELECTOR);
  const tuples = [];
  for (let i = 0; i < panels.length; i++) {
    if (check()) break;
    try {
      const tuple = extractPanelTuple(panels[i], { staffId, staffName });
      if (tuple) tuples.push(tuple);
    } catch (error) {
      logger?.warn?.(`Skipped one entry (${error.message})`);
    }
  }

  await enqueueBatch(tuples);
  logger?.info?.(`Enqueued ${tuples.length} tuples for staff ${staffId}`);
  return { status: 'ok', tuples: tuples.length };
}

export async function walkAllStaff({ clinicName, resolvedStaff, logger, shouldStop, onFreeze }) {
  let total = 0;
  let staffIndex = 0;
  for (const staff of resolvedStaff) {
    if (shouldStop?.()) return { total, completed: staffIndex };
    staffIndex += 1;
    try {
      const res = await walkStaffEntries({
        clinicName,
        staffId: staff.staff_id,
        staffName: staff.staff_name,
        logger,
        shouldStop,
        onFreeze,
      });
      total += res.tuples || 0;
      try {
        await chrome.runtime.sendMessage({
          action: 'discoveryProgress',
          staffCompleted: staffIndex,
          totalStaff: resolvedStaff.length,
          tuplesFound: total,
        });
      } catch { /* panel maybe closed */ }
    } catch (error) {
      logger?.error?.(`walkStaffEntries failed for ${staff.staff_id}: ${error.message}`);
    }
  }
  return { total, completed: staffIndex };
}
