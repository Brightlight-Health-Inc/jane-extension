/**
 * Writes the three JSON manifests at the end of Phase 3.
 *
 *   ~/Downloads/jane-scraper/_manifest/patients.json
 *   ~/Downloads/jane-scraper/_manifest/staff.json
 *   ~/Downloads/jane-scraper/_manifest/connections.json
 *
 * Uses chrome.downloads.download with data: URIs (no blob() in service worker).
 * Files overwrite prior versions via conflictAction "overwrite" so re-runs
 * replace the manifests cleanly.
 */

import { listProfiles, listCharts } from '../storage/chart-db.js';

const MANIFEST_DIR = 'jane-scraper/_manifest';

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

function buildConnectionsManifest(charts) {
  return charts.map((c) => {
    const row = {
      chart_id: c.chart_id,
      chart_type: c.chart_type || null,
      chart_date: c.chart_date || null,
      patient_id: c.patient_id ? String(c.patient_id) : null,
      staff_id: c.staff_id ? String(c.staff_id) : null,
      download_status: c.status === 'done' ? 'ok' : `failed_${c.failure_reason || c.status}`,
    };
    if (c.file_path) row.file_path = c.file_path;
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

export async function writeAllManifests() {
  const [patientProfiles, staffProfiles, charts] = await Promise.all([
    listProfiles('patient'),
    listProfiles('staff'),
    listCharts(),
  ]);

  const patients = buildPatientManifest(patientProfiles);
  const staff = buildStaffManifest(staffProfiles);
  const connections = buildConnectionsManifest(charts);

  const patientsId = await downloadJson('patients.json', patients);
  const staffId = await downloadJson('staff.json', staff);
  const connectionsId = await downloadJson('connections.json', connections);

  return {
    counts: {
      patients: patients.length,
      staff: staff.length,
      connections: connections.length,
    },
    download_ids: {
      patients: patientsId,
      staff: staffId,
      connections: connectionsId,
    },
  };
}
