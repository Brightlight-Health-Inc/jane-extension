/**
 * Writes the manifests at the end of Phase 3.
 *
 *   ~/Downloads/jane-scraper/_manifest/patients.json
 *   ~/Downloads/jane-scraper/_manifest/staff.json
 *   ~/Downloads/jane-scraper/_manifest/connections.json       (small runs)
 *   ~/Downloads/jane-scraper/_manifest/connections_001.json   (chunked
 *   ~/Downloads/jane-scraper/_manifest/connections_002.json    when large)
 *   ~/Downloads/jane-scraper/_manifest/connections_index.json (chunk listing)
 *   ~/Downloads/jane-scraper/_manifest/summary.json           (run summary)
 *
 * Uses chrome.downloads.download with data: URIs. That caps individual file
 * size at ~2 MB of encoded URL safely; for the connections list (which can
 * grow past 10k entries for a full run) we chunk at 3000 rows each and write
 * an index alongside. patients.json and staff.json are always single-file.
 */

import { listProfiles, listCharts, listConnections } from '../storage/chart-db.js';

const MANIFEST_DIR = 'jane-scraper/_manifest';
const CONNECTIONS_CHUNK_SIZE = 3000;
const CHART_ID_IN_FILENAME = /__(\d+)__/;

/**
 * Enumerate every PDF Chrome has on disk in jane-scraper/{patient}/ and
 * group by patient_id. Returns:
 *   { byPatient: Map<patientId, {folderName, files: [{filename, chartId?}]}>,
 *     byChartId: Map<chartId, {filename, patientId}>,
 *     total }
 *
 * chartId is parsed from the `__<id>__` segment of the filename that
 * download-worker.js builds; null if the filename doesn't contain it.
 */
async function enumerateDiskPdfs() {
  const downloads = await chrome.downloads.search({
    filenameRegex: 'jane-scraper/\\d+_[^/]+/.*\\.pdf$',
    exists: true,
    limit: 0,
  });

  const byPatient = new Map();
  const byChartId = new Map();

  for (const dl of downloads || []) {
    const match = dl.filename && dl.filename.match(/jane-scraper\/(\d+)_([^/]+)\/([^/]+\.pdf)$/);
    if (!match) continue;
    const patientId = match[1];
    const folderName = match[2];
    const filenameOnly = match[3];
    const chartIdMatch = filenameOnly.match(CHART_ID_IN_FILENAME);
    const chartId = chartIdMatch ? chartIdMatch[1] : null;

    if (!byPatient.has(patientId)) {
      byPatient.set(patientId, { folderName, files: [] });
    }
    byPatient.get(patientId).files.push({ filename: filenameOnly, chartId });

    if (chartId && !byChartId.has(chartId)) {
      byChartId.set(chartId, { filename: filenameOnly, patientId });
    }
  }

  return { byPatient, byChartId, total: byChartId.size };
}

function buildPatientManifest(profiles) {
  return profiles.map((entry) => ({
    patient_id: entry.id,
    ...entry.record,
    profile_status: entry.profile_status,
  }));
}

function buildStaffManifest(profiles) {
  return profiles.map((entry) => ({
    staff_id: entry.id,
    ...entry.record,
    profile_status: entry.profile_status,
  }));
}

function buildSummary({ charts, connections, patientProfiles, staffProfiles, chartsById, clinicName, disk }) {
  // Downloads
  const dlTotal = charts.length;
  const dlOk = charts.filter((c) => c.status === 'done').length;
  const dlFailed = charts.filter((c) => c.status === 'failed').length;
  const dlStuck = charts.filter((c) => c.status === 'pending' || c.status === 'in_flight').length;
  const failedCharts = charts
    .filter((c) => c.status === 'failed')
    .map((c) => ({
      chart_id: String(c.chart_id),
      chart_type: c.chart_type || null,
      chart_date: c.chart_date || null,
      patient_id: c.patient_id ? String(c.patient_id) : null,
      patient_name: c.patient_name || null,
      staff_id: c.staff_id ? String(c.staff_id) : null,
      staff_name: c.staff_name || null,
      failure_reason: c.failure_reason || 'unknown',
      retry_count: c.retry_count || 0,
      expected_file_path: c.patient_id
        ? `jane-scraper/${c.patient_id}_${(c.patient_name || 'Patient').replace(/[^a-zA-Z0-9_-]+/g, '_')}/<filename>.pdf`
        : null,
    }))
    .sort((a, b) => String(a.patient_id || '').localeCompare(String(b.patient_id || '')));

  // Per-staff rollup (via connections — a chart shared by N staff counts N
  // times, so these sum up to total_edges, not unique_charts).
  const staffStats = new Map();
  for (const conn of connections) {
    const key = String(conn.staff_id);
    if (!staffStats.has(key)) {
      staffStats.set(key, {
        staff_id: key,
        staff_name: conn.staff_name || null,
        charts_total: 0,
        charts_ok: 0,
        charts_failed: 0,
        unique_patients: new Set(),
      });
    }
    const s = staffStats.get(key);
    s.charts_total += 1;
    if (conn.patient_id) s.unique_patients.add(String(conn.patient_id));
    const chart = chartsById.get(String(conn.chart_id));
    if (chart?.status === 'done') s.charts_ok += 1;
    else if (chart?.status === 'failed') s.charts_failed += 1;
  }
  const per_staff = [...staffStats.values()]
    .map((s) => ({
      staff_id: s.staff_id,
      staff_name: s.staff_name,
      charts_total: s.charts_total,
      charts_ok: s.charts_ok,
      charts_failed: s.charts_failed,
      unique_patients: s.unique_patients.size,
    }))
    .sort((a, b) => b.charts_total - a.charts_total);

  // Per-patient rollup (via charts store — one row per unique chart).
  const patientStats = new Map();
  for (const chart of charts) {
    const key = String(chart.patient_id || 'unknown');
    if (!patientStats.has(key)) {
      patientStats.set(key, {
        patient_id: key,
        patient_name: chart.patient_name || null,
        charts_total: 0,
        charts_ok: 0,
        charts_failed: 0,
        staff_seen: new Set(),
      });
    }
    const p = patientStats.get(key);
    p.charts_total += 1;
    if (chart.status === 'done') p.charts_ok += 1;
    else if (chart.status === 'failed') p.charts_failed += 1;
  }
  for (const conn of connections) {
    const key = String(conn.patient_id || '');
    if (patientStats.has(key)) patientStats.get(key).staff_seen.add(String(conn.staff_id));
  }
  const per_patient = [...patientStats.values()]
    .map((p) => ({
      patient_id: p.patient_id,
      patient_name: p.patient_name,
      charts_total: p.charts_total,
      charts_ok: p.charts_ok,
      charts_failed: p.charts_failed,
      staff_seen: [...p.staff_seen].sort(),
    }))
    .sort((a, b) => b.charts_total - a.charts_total);

  // Profile status counts.
  const profileCounts = (profiles) => {
    const out = { total: profiles.length, ok: 0, partial: 0, failed: 0 };
    for (const p of profiles) {
      const status = p.profile_status || 'ok';
      if (status === 'ok') out.ok += 1;
      else if (status === 'partial') out.partial += 1;
      else if (status === 'failed') out.failed += 1;
    }
    return out;
  };
  const partialOrFailed = (profiles, type) => profiles
    .filter((p) => p.profile_status !== 'ok')
    .map((p) => ({
      type,
      id: String(p.id),
      name: p.record?.name || null,
      profile_status: p.profile_status || 'unknown',
    }));

  const patientProfileCounts = profileCounts(patientProfiles);
  const staffProfileCounts = profileCounts(staffProfiles);

  // Disk audit — cross-reference IndexedDB status against the actual files
  // Chrome can see in the jane-scraper folders. Catches three kinds of drift:
  //   - orphan_done: chart marked done in DB but file missing on disk
  //     (e.g. user deleted the PDF, or completeChart fired but save failed)
  //   - unknown_on_disk: file on disk with no matching chart in this run
  //     (leftover from a previous run / unrelated download)
  //   - missing_on_disk: chart not marked done (failed/pending/in_flight)
  //     AND no file on disk — the true "needs re-download" set
  const audit = { enabled: !!disk };
  if (disk) {
    const diskByChartId = disk.byChartId || new Map();
    const diskByPatient = disk.byPatient || new Map();

    const orphanDone = [];
    const missingOnDisk = [];
    const ghostFailed = [];
    const matchedChartIds = new Set();

    for (const chart of charts) {
      const chartId = String(chart.chart_id);
      const onDisk = diskByChartId.has(chartId);
      if (onDisk) matchedChartIds.add(chartId);

      const row = {
        chart_id: chartId,
        patient_id: chart.patient_id ? String(chart.patient_id) : null,
        patient_name: chart.patient_name || null,
        staff_id: chart.staff_id ? String(chart.staff_id) : null,
        staff_name: chart.staff_name || null,
        chart_type: chart.chart_type || null,
        chart_date: chart.chart_date || null,
        db_status: chart.status,
        file_path: chart.file_path || (onDisk ? `jane-scraper/${chart.patient_id}_.../${diskByChartId.get(chartId).filename}` : null),
      };

      if (chart.status === 'done' && !onDisk) {
        orphanDone.push({ ...row, failure_reason: 'file missing from disk despite done status' });
      } else if (chart.status === 'failed' && !onDisk) {
        missingOnDisk.push({ ...row, failure_reason: chart.failure_reason || 'unknown' });
      } else if ((chart.status === 'pending' || chart.status === 'in_flight') && !onDisk) {
        missingOnDisk.push({ ...row, failure_reason: `never_attempted: ${chart.status}` });
      } else if (chart.status === 'failed' && onDisk) {
        ghostFailed.push(row);
      }
    }

    const extraFiles = [];
    for (const [chartId, meta] of diskByChartId) {
      if (!matchedChartIds.has(chartId)) {
        extraFiles.push({ chart_id: chartId, patient_id: meta.patientId, filename: meta.filename });
      }
    }

    // Concentration heuristic — if >50% of missing charts belong to one
    // patient or one staff, surface that so the user can tell "systematic
    // problem" vs "random noise".
    const missByPatient = new Map();
    const missByStaff = new Map();
    for (const row of missingOnDisk) {
      if (row.patient_id) missByPatient.set(row.patient_id, (missByPatient.get(row.patient_id) || 0) + 1);
      if (row.staff_id) missByStaff.set(row.staff_id, (missByStaff.get(row.staff_id) || 0) + 1);
    }
    const hotspotOf = (map, totalFailed) => {
      if (totalFailed === 0) return null;
      let best = null;
      for (const [key, count] of map) {
        if (!best || count > best.count) best = { key, count };
      }
      if (!best) return null;
      const ratio = best.count / totalFailed;
      return ratio >= 0.5 ? { id: best.key, count: best.count, ratio_of_failures: Number(ratio.toFixed(2)) } : null;
    };

    // Count files per patient on disk (actual) vs expected from chart store
    const expectedByPatient = new Map();
    for (const chart of charts) {
      const key = chart.patient_id ? String(chart.patient_id) : 'unknown';
      expectedByPatient.set(key, (expectedByPatient.get(key) || 0) + 1);
    }
    const diskCountByPatient = [...diskByPatient.entries()]
      .map(([pid, meta]) => ({
        patient_id: pid,
        folder_name: meta.folderName,
        files_on_disk: meta.files.length,
        charts_expected: expectedByPatient.get(pid) || 0,
        gap: (expectedByPatient.get(pid) || 0) - meta.files.length,
      }))
      .sort((a, b) => b.files_on_disk - a.files_on_disk);

    Object.assign(audit, {
      files_on_disk_total: disk.total,
      charts_in_queue: charts.length,
      matched: matchedChartIds.size,
      orphan_done: orphanDone,
      missing_on_disk: missingOnDisk,
      ghost_failed_but_on_disk: ghostFailed,
      extra_files_on_disk: extraFiles,
      hotspot_patient: hotspotOf(missByPatient, missingOnDisk.length),
      hotspot_staff: hotspotOf(missByStaff, missingOnDisk.length),
      per_patient_file_counts: diskCountByPatient,
    });
  }

  return {
    generated_at: new Date().toISOString(),
    clinic_name: clinicName || null,
    totals: {
      connections: connections.length,
      unique_charts: charts.length,
      unique_patients: patientStats.size,
      unique_staff_involved: staffStats.size,
    },
    downloads: {
      total: dlTotal,
      ok: dlOk,
      failed: dlFailed,
      not_yet_attempted: dlStuck,
    },
    failed_charts: failedCharts,
    per_staff,
    per_patient,
    profiles: {
      patients: patientProfileCounts,
      staff: staffProfileCounts,
      incomplete: [
        ...partialOrFailed(patientProfiles, 'patient'),
        ...partialOrFailed(staffProfiles, 'staff'),
      ],
    },
    audit,
  };
}

function buildConnectionsManifest(connections, chartsById) {
  // One row per (staff, chart) edge — a chart shared by N staff produces N
  // rows. Download status comes from the deduped charts store (all staff on
  // the same chart share the same downloaded PDF).
  return connections.map((c) => {
    const chart = chartsById.get(String(c.chart_id));
    const status = chart?.status;
    const row = {
      staff_id: c.staff_id,
      chart_id: c.chart_id,
      patient_id: c.patient_id || null,
      chart_type: c.chart_type || null,
      chart_date: c.chart_date || null,
      download_status: status === 'done' ? 'ok' : `failed_${chart?.failure_reason || status || 'unknown'}`,
    };
    if (chart?.file_path) row.file_path = chart.file_path;
    return row;
  });
}

function toDataUrl(data) {
  const json = JSON.stringify(data, null, 2);
  return `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
}

function downloadJson(filename, data) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url: toDataUrl(data),
      filename: `${MANIFEST_DIR}/${filename}`,
      saveAs: false,
      conflictAction: 'overwrite',
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (downloadId === undefined) {
        reject(new Error(`chrome.downloads.download returned no id for ${filename}`));
      } else {
        resolve(downloadId);
      }
    });
  });
}

async function writeConnectionsManifest(connections) {
  if (connections.length <= CONNECTIONS_CHUNK_SIZE) {
    const id = await downloadJson('connections.json', connections);
    return { single: true, chunks: 1, download_ids: [id] };
  }

  const chunks = [];
  for (let i = 0; i < connections.length; i += CONNECTIONS_CHUNK_SIZE) {
    chunks.push(connections.slice(i, i + CONNECTIONS_CHUNK_SIZE));
  }
  const downloadIds = [];
  const files = [];
  for (let i = 0; i < chunks.length; i++) {
    const suffix = String(i + 1).padStart(3, '0');
    const name = `connections_${suffix}.json`;
    files.push({ file: name, rows: chunks[i].length });
    downloadIds.push(await downloadJson(name, chunks[i]));
  }
  const indexId = await downloadJson('connections_index.json', {
    total_rows: connections.length,
    chunk_size: CONNECTIONS_CHUNK_SIZE,
    files,
  });
  downloadIds.push(indexId);
  return { single: false, chunks: chunks.length, download_ids: downloadIds };
}

export async function writeAllManifests({ clinicName } = {}) {
  const [patientProfiles, staffProfiles, charts, connectionEdges] = await Promise.all([
    listProfiles('patient'),
    listProfiles('staff'),
    listCharts(),
    listConnections(),
  ]);

  let disk = null;
  try {
    disk = await enumerateDiskPdfs();
  } catch (error) {
    console.warn('[manifest] disk audit skipped:', error.message);
  }

  const chartsById = new Map(charts.map((c) => [String(c.chart_id), c]));
  const patients = buildPatientManifest(patientProfiles);
  const staff = buildStaffManifest(staffProfiles);
  const connections = buildConnectionsManifest(connectionEdges, chartsById);
  const summary = buildSummary({
    charts,
    connections: connectionEdges,
    patientProfiles,
    staffProfiles,
    chartsById,
    clinicName,
    disk,
  });

  const patientsId = await downloadJson('patients.json', patients);
  const staffId = await downloadJson('staff.json', staff);
  const connectionsResult = await writeConnectionsManifest(connections);
  const summaryId = await downloadJson('summary.json', summary);

  return {
    counts: {
      patients: patients.length,
      staff: staff.length,
      connections: connections.length,
    },
    connections_chunks: connectionsResult.chunks,
    download_ids: {
      patients: patientsId,
      staff: staffId,
      connections: connectionsResult.download_ids,
      summary: summaryId,
    },
    summary,
  };
}
