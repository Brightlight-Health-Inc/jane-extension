/**
 * Phase 3 — capture minimum-viable profile info for every unique staff
 * and patient that appeared in the download phase.
 *
 * Patient:  { name, dob, phn, email, phone, address }
 * Staff:    { name, email, title }
 *
 * Because Jane's profile page has a lot of optional rendering variations,
 * the scrapers here are deliberately defensive: they try multiple
 * strategies (test IDs → mailto/tel anchors → label-text scanning) and
 * fall back gracefully. If a field can't be found, the scraped record
 * still ships with whatever was captured plus `profile_status: 'partial'`
 * so the ingestion pipeline can flag it instead of assuming success.
 *
 * Both pages are navigated via `window.location.href = <url>` and then
 * the scraper waits for DOM content to settle. Profile capture runs
 * sequentially and respects the global rate-limit gate, just like the
 * patient-check flow.
 */

import { sleep } from '../../shared/utils/async-utils.js';
import { TIMEOUTS } from '../../shared/constants.js';

async function persistProfile(type, id, record, profile_status) {
  return chrome.runtime.sendMessage({
    action: 'saveProfile',
    type,
    id: String(id),
    record,
    profile_status,
  });
}

const CONTENT_READY_TIMEOUT_MS = 20000;

function text(el) {
  return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
}

function firstNonEmpty(...values) {
  for (const v of values) {
    if (v && String(v).trim()) return String(v).trim();
  }
  return '';
}

function extractMailto() {
  const anchor = document.querySelector('a[href^="mailto:"]');
  if (!anchor) return '';
  const href = anchor.getAttribute('href') || '';
  return href.replace(/^mailto:/i, '').split('?')[0].trim();
}

function extractTel() {
  const anchor = document.querySelector('a[href^="tel:"]');
  if (!anchor) return '';
  const href = anchor.getAttribute('href') || '';
  return href.replace(/^tel:/i, '').trim();
}

function findValueByLabel(labelPatterns) {
  const all = document.querySelectorAll('label, dt, th, strong, b, div, span');
  for (const node of all) {
    const t = (node.textContent || '').trim();
    if (!t) continue;
    const matches = labelPatterns.some((pat) => pat instanceof RegExp ? pat.test(t) : t.toLowerCase() === pat.toLowerCase());
    if (!matches) continue;
    const sibling = node.nextElementSibling;
    if (sibling) {
      const v = text(sibling);
      if (v && v !== t) return v;
    }
    const parent = node.parentElement;
    if (parent) {
      const siblings = parent.children;
      for (const child of siblings) {
        if (child === node) continue;
        const v = text(child);
        if (v && v !== t && v.length < 200) return v;
      }
    }
  }
  return '';
}

async function waitForMainContent(shouldStop) {
  const start = Date.now();
  while (Date.now() - start < CONTENT_READY_TIMEOUT_MS) {
    if (shouldStop?.()) throw new Error('stopped');
    const heading = document.querySelector('h1, h2, [data-test-id*="name"]');
    if (heading && text(heading)) return true;
    await sleep(500, { shouldStop });
  }
  return false;
}

function scrapePatientProfile() {
  const name = firstNonEmpty(
    text(document.querySelector('[data-test-id="patient_name"], [data-test-id="patient_full_name"]')),
    text(document.querySelector('h1, h2')),
  );
  const email = firstNonEmpty(
    extractMailto(),
    findValueByLabel([/^email$/i, 'email']),
  );
  const phone = firstNonEmpty(
    extractTel(),
    findValueByLabel([/^phone$/i, /^mobile$/i, /^cell$/i]),
  );
  const dob = findValueByLabel([/^dob$/i, /date of birth/i, /^birthdate$/i]);
  const phn = findValueByLabel([/personal health/i, /^phn$/i, /health (card )?number/i]);
  const addressRaw = findValueByLabel([/^address$/i, /home address/i, /street/i]);

  const address = addressRaw ? parseAddress(addressRaw) : null;

  const captured = { name, dob, phn, email, phone, address };
  const has = (v) => v && String(v).trim().length > 0;
  const captured_fields = Object.entries(captured).filter(([, v]) => has(v)).length;
  const total_fields = Object.keys(captured).length;
  const profile_status = captured_fields === total_fields ? 'ok'
    : captured_fields === 0 ? 'failed' : 'partial';

  return { captured, profile_status };
}

function parseAddress(raw) {
  const parts = raw.split(/\s*,\s*/);
  if (parts.length < 2) return { raw };
  const [street, ...rest] = parts;
  return { street: street || '', raw, trailing: rest.join(', ') };
}

function scrapeStaffProfile() {
  const name = firstNonEmpty(
    text(document.querySelector('[data-test-id="staff_name"], [data-test-id="staff_full_name"]')),
    text(document.querySelector('h1, h2')),
  );
  const email = firstNonEmpty(
    extractMailto(),
    findValueByLabel([/^email$/i]),
  );
  const title = firstNonEmpty(
    findValueByLabel([/^title$/i, /^role$/i, /discipline/i, /specialty/i]),
  );
  const captured = { name, email, title };
  const captured_fields = Object.values(captured).filter((v) => v && String(v).trim()).length;
  const profile_status = captured_fields === 3 ? 'ok'
    : captured_fields === 0 ? 'failed' : 'partial';
  return { captured, profile_status };
}

export async function scrapePatientProfileById({ clinicName, patientId, logger, shouldStop }) {
  const url = `https://${clinicName}.janeapp.com/admin/patients/${patientId}`;
  window.location.href = url;
  await sleep(TIMEOUTS.PATIENT_PAGE_LOAD, { shouldStop });
  const ready = await waitForMainContent(shouldStop);
  if (!ready) {
    await persistProfile('patient', patientId, {}, 'failed');
    return { patientId, profile_status: 'failed' };
  }
  const { captured, profile_status } = scrapePatientProfile();
  await persistProfile('patient', patientId, captured, profile_status);
  logger?.info?.(`Patient ${patientId} profile: ${profile_status}`);
  return { patientId, profile_status, captured };
}

export async function scrapeStaffProfileById({ clinicName, staffId, logger, shouldStop }) {
  const url = `https://${clinicName}.janeapp.com/admin/staff/${staffId}`;
  window.location.href = url;
  await sleep(TIMEOUTS.PATIENT_PAGE_LOAD, { shouldStop });
  const ready = await waitForMainContent(shouldStop);
  if (!ready) {
    await persistProfile('staff', staffId, {}, 'failed');
    return { staffId, profile_status: 'failed' };
  }
  const { captured, profile_status } = scrapeStaffProfile();
  await persistProfile('staff', staffId, captured, profile_status);
  logger?.info?.(`Staff ${staffId} profile: ${profile_status}`);
  return { staffId, profile_status, captured };
}

export async function scrapeAllProfiles({ clinicName, staffIds, patientIds, logger, shouldStop, onRateLimitCheck }) {
  const staffResults = [];
  const patientResults = [];

  for (const id of staffIds) {
    if (shouldStop?.()) return { staff: staffResults, patients: patientResults };
    if (onRateLimitCheck) await onRateLimitCheck();
    try {
      staffResults.push(await scrapeStaffProfileById({ clinicName, staffId: id, logger, shouldStop }));
    } catch (error) {
      logger?.error?.(`Staff ${id} profile scrape failed: ${error.message}`);
    }
  }

  for (const id of patientIds) {
    if (shouldStop?.()) return { staff: staffResults, patients: patientResults };
    if (onRateLimitCheck) await onRateLimitCheck();
    try {
      patientResults.push(await scrapePatientProfileById({ clinicName, patientId: id, logger, shouldStop }));
    } catch (error) {
      logger?.error?.(`Patient ${id} profile scrape failed: ${error.message}`);
    }
  }

  return { staff: staffResults, patients: patientResults };
}
