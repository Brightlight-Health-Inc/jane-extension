/**
 * Phase 2 — download-loop consumer.
 *
 * Each worker tab repeatedly asks the coordinator for the next chart
 * tuple, opens the Jane PDF URL, writes to
 *   ~/Downloads/jane-scraper/<patientId>_<patientName>/<ChartType>__<chartId>__<staffLast>.pdf
 * then marks the tuple done. Runs until the queue reports `status: 'done'`.
 *
 * The existing PdfDownloader instance already handles:
 *   - global rate-limit gate
 *   - per-thread throttle window
 *   - retry/backoff on transient server errors
 * so this loop is little more than scheduling.
 */

import { sleep } from '../../shared/utils/async-utils.js';
import { cleanFilename } from '../../shared/utils/string-utils.js';

const RATE_LIMIT_BACKOFF_MS = 8000;
const EMPTY_QUEUE_BACKOFF_MS = 4000;

function buildChartPdfUrl(clinicName, patientId, chartId) {
  return `https://${clinicName}.janeapp.com/admin/patients/${patientId}/chart_entries/${chartId}.pdf`;
}

function staffLastName(fullName) {
  if (!fullName) return 'Staff';
  const parts = String(fullName).replace(/\s+/g, ' ').trim().split(' ');
  return parts.length ? parts[parts.length - 1] : 'Staff';
}

function buildPatientFolder(patientId, patientName) {
  const safeName = cleanFilename(patientName || 'Patient');
  return `jane-scraper/${patientId}_${safeName}`;
}

function buildFilename(tuple) {
  const chartType = cleanFilename(tuple.chart_type || 'Chart');
  const chartId = tuple.chart_id;
  const staff = cleanFilename(staffLastName(tuple.staff_name));
  return `${chartType}__${chartId}__${staff}.pdf`;
}

async function fetchNextTuple(threadId) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'requestChart', threadId }, (response) => {
      resolve(response || { status: 'error', error: 'no response' });
    });
  });
}

async function reportChartResult(action, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, ...payload }, (response) => {
      resolve(response || { ok: false });
    });
  });
}

async function alreadyOnDisk(filename, patientId) {
  try {
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: 'fileExistsInPatientFolder',
        patientId,
        filenamePrefix: filename,
      }, (res) => resolve(res));
    });
    return !!response?.exists;
  } catch { return false; }
}

export async function runDownloadLoop({ threadId, clinicName, logger, shouldStop, pdfDownloader, fileChecker }) {
  logger?.info?.(`[download] worker ${threadId} starting`);
  let processed = 0;
  let skipped = 0;
  let failed = 0;

  while (!shouldStop?.()) {
    const res = await fetchNextTuple(threadId);

    if (res.status === 'done') {
      logger?.info?.(`[download] queue drained, worker ${threadId} finished (processed=${processed}, skipped=${skipped}, failed=${failed})`);
      await reportChartResult('workerFinishedDownload', { threadId });
      return;
    }
    if (res.status === 'stopped') {
      logger?.info?.(`[download] worker ${threadId}: stopped flag set`);
      return;
    }
    if (res.status === 'wait') {
      logger?.debug?.(`[download] worker ${threadId}: queue empty but in-flight work exists, waiting`);
      await sleep(EMPTY_QUEUE_BACKOFF_MS, { shouldStop });
      continue;
    }
    if (res.status === 'error' || !res.chart) {
      logger?.warn?.(`[download] requestChart error: ${res.error || 'unknown'}`);
      await sleep(EMPTY_QUEUE_BACKOFF_MS, { shouldStop });
      continue;
    }

    const tuple = res.chart;
    const folder = buildPatientFolder(tuple.patient_id, tuple.patient_name);
    const filename = buildFilename(tuple);
    const relativePath = `${folder}/${filename}`;
    logger?.debug?.(`[download] worker ${threadId} claimed chart=${tuple.chart_id} patient=${tuple.patient_id} → ${relativePath}`);

    try {
      if (await alreadyOnDisk(filename, tuple.patient_id)) {
        logger?.debug?.(`[download] skip (already on disk): ${relativePath}`);
        skipped += 1;
        await reportChartResult('completeChart', { chartId: tuple.chart_id, filePath: relativePath });
        continue;
      }
    } catch (error) {
      logger?.warn?.(`[download] file-check failed, proceeding: ${error.message}`);
    }

    const pdfUrl = buildChartPdfUrl(clinicName, tuple.patient_id, tuple.chart_id);

    try {
      await pdfDownloader.downloadRemotePdf(pdfUrl, filename, folder, shouldStop);
      processed += 1;
      logger?.success?.(`[download] ${threadId} OK chart=${tuple.chart_id} file=${filename}`);
      await reportChartResult('completeChart', { chartId: tuple.chart_id, filePath: relativePath });
    } catch (error) {
      const msg = (error?.message || '').toLowerCase();
      const retriable = msg.includes('server_failed')
        || msg.includes('interrupted')
        || msg.includes('timed out')
        || msg.includes('failed to fetch')
        || msg.includes('network')
        || msg.includes('pdf is empty');

      if (msg.includes('rate') || msg.includes('whoa there')) {
        logger?.warn?.(`[download] ${threadId} rate-limited, backing off ${RATE_LIMIT_BACKOFF_MS}ms`);
        await sleep(RATE_LIMIT_BACKOFF_MS, { shouldStop });
        await reportChartResult('failChart', { chartId: tuple.chart_id, reason: 'rate_limit', retriable: true });
        continue;
      }

      failed += 1;
      logger?.error?.(`[download] ${threadId} FAIL chart=${tuple.chart_id}: ${error.message} (retriable=${retriable})`);
      await reportChartResult('failChart', {
        chartId: tuple.chart_id,
        reason: error.message || 'unknown',
        retriable,
      });
    }
  }

  logger?.info?.(`[download] worker ${threadId} stopping (processed=${processed}, skipped=${skipped}, failed=${failed})`);
}
