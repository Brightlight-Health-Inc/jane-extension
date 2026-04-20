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
const PATIENT_NAME_SELECTOR = 'span[data-test-id="chart_entry_header_patient_name"]';
const HEADER_CONTAINER_SELECTOR = 'div.ellipsis-after-3-lines.flex-order-sm-2.flex-item.flex-pull-left';
const AUTHOR_SELECTOR = '[data-testid="author-name"]';
const PRINT_LINK_SELECTOR = 'a[href*="/admin/patients/"][href*="/chart_entries/"]';

function buildStaffChartsUrl(clinicName, staffId) {
  // Jane admin is a hash-routed SPA. #staff/<id>/charts is the "Charts" tab
  // for the staff member which renders Chart Entries in the main pane.
  return `https://${clinicName}.janeapp.com/admin#staff/${staffId}/charts`;
}

function textOf(el) {
  return el ? (el.textContent || '').trim() : '';
}

function extractPanelTuple(panel, { staffId, staffName, logger, index }) {
  const header = panel.querySelector(HEADER_CONTAINER_SELECTOR);
  const dateText = textOf(header?.querySelector(DATE_SELECTOR));
  const titleText = textOf(header?.querySelector(TITLE_SELECTOR));
  const patientNameText = textOf(panel.querySelector(PATIENT_NAME_SELECTOR));

  const printLink = panel.querySelector(PRINT_LINK_SELECTOR);
  const href = printLink ? printLink.getAttribute('href') || '' : '';
  const chartIdMatch = href.match(PATTERNS.CHART_ENTRY_ID);
  const patientIdMatch = href.match(/\/admin\/patients\/(\d+)\//);
  if (!chartIdMatch || !patientIdMatch) {
    logger?.warn?.(`[walker] panel #${index} missing chart/patient id in href="${href}"`);
    return null;
  }

  const chartId = chartIdMatch[1];
  const patientId = patientIdMatch[1];

  const authorNode = panel.querySelector(AUTHOR_SELECTOR);
  const authorText = textOf(authorNode);

  const tuple = {
    chart_id: chartId,
    chart_type: titleText || 'Chart',
    chart_date: dateText || null,
    patient_id: patientId,
    patient_name: patientNameText || null,
    staff_id: String(staffId),
    staff_name: staffName || authorText || null,
    chart_url: href.startsWith('http') ? href : `${window.location.origin}${href}`,
  };

  logger?.debug?.(`[walker] panel #${index}: chart=${chartId} patient=${patientId} "${patientNameText}" date="${dateText}"`);
  return tuple;
}

async function enqueueBatch(tuples, logger) {
  if (!tuples.length) return;
  logger?.debug?.(`[walker] enqueueing ${tuples.length} tuples to background`);
  const res = await chrome.runtime.sendMessage({ action: 'enqueueCharts', tuples });
  logger?.debug?.(`[walker] enqueue response: added=${res?.added} total=${res?.progress?.total}`);
}

export async function walkStaffEntries({ clinicName, staffId, staffName, logger, shouldStop, onFreeze }) {
  const check = () => (shouldStop ? shouldStop() : false);

  const targetUrl = buildStaffChartsUrl(clinicName, staffId);
  logger?.info?.(`[walker] BEGIN staff=${staffId} name="${staffName}" url=${targetUrl}`);

  window.location.href = targetUrl;
  await sleep(TIMEOUTS.CHARTS_PAGE_LOAD, { shouldStop });
  logger?.debug?.(`[walker] post-nav currentUrl=${window.location.href}`);

  logger?.debug?.('[walker] waiting for chart panels to render');
  const loaded = await waitForChartsLoaded({ maxWaitMs: TIMEOUTS.CHARTS_RENDER, shouldStop: check, logger });
  if (check()) {
    logger?.info?.('[walker] stopped during wait');
    return { status: 'stopped', tuples: 0 };
  }
  if (!loaded) {
    const freeze = await chrome.storage.local.get('frozen');
    if (freeze?.frozen && onFreeze) {
      logger?.warn?.('[walker] page frozen, invoking onFreeze');
      await onFreeze({ clinicName, staffId });
    }
    logger?.warn?.(`[walker] staff ${staffId}: waitForChartsLoaded returned false`);
    return { status: 'no_load', tuples: 0 };
  }

  const panelsNow = document.querySelectorAll(PANEL_SELECTOR);
  logger?.debug?.(`[walker] initial panel count: ${panelsNow.length}`);
  if (panelsNow.length === 0) {
    logger?.info?.(`[walker] staff ${staffId}: no chart panels`);
    return { status: 'no_charts', tuples: 0 };
  }

  logger?.debug?.('[walker] clicking Load More until all charts present');
  const loadMoreCount = await loadAllCharts({ maxClicks: 500, shouldStop: check, logger });
  logger?.debug?.(`[walker] Load More clicks: ${loadMoreCount}`);

  const panels = document.querySelectorAll(PANEL_SELECTOR);
  logger?.info?.(`[walker] staff ${staffId}: extracting ${panels.length} panels`);
  const tuples = [];
  let skipped = 0;
  for (let i = 0; i < panels.length; i++) {
    if (check()) {
      logger?.info?.('[walker] stop signal during extraction');
      break;
    }
    try {
      const tuple = extractPanelTuple(panels[i], { staffId, staffName, logger, index: i });
      if (tuple) tuples.push(tuple); else skipped += 1;
    } catch (error) {
      logger?.warn?.(`[walker] panel #${i} threw: ${error.message}`);
      skipped += 1;
    }
  }
  if (skipped > 0) logger?.warn?.(`[walker] skipped ${skipped}/${panels.length} panels`);

  await enqueueBatch(tuples, logger);
  logger?.info?.(`[walker] DONE staff=${staffId}: ${tuples.length} tuples enqueued, ${skipped} skipped`);
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
