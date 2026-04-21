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

function buildSummary({ charts, connections, patientProfiles, staffProfiles, chartsById, clinicName }) {
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
