/**
 * Writes the three JSON manifests at the end of Phase 3.
 *
 *   ~/Downloads/jane-scraper/_manifest/patients.json
 *   ~/Downloads/jane-scraper/_manifest/staff.json
 *   ~/Downloads/jane-scraper/_manifest/connections.json       (small runs)
 *   ~/Downloads/jane-scraper/_manifest/connections_001.json   (chunked
 *   ~/Downloads/jane-scraper/_manifest/connections_002.json    when large)
 *   ~/Downloads/jane-scraper/_manifest/connections_index.json (chunk listing)
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

export async function writeAllManifests() {
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

  const patientsId = await downloadJson('patients.json', patients);
  const staffId = await downloadJson('staff.json', staff);
  const connectionsResult = await writeConnectionsManifest(connections);

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
    },
  };
}
