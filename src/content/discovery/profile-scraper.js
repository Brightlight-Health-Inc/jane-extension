/**
 * Phase 3 — capture minimum-viable profile info for every unique staff
 * and patient that appeared in the download phase.
 *
 * Patient:  { name, dob, phn, email, phone, address }
 * Staff:    { name, email, title }
 *
 * Jane admin is hash-routed: patient profiles live at #patients/<id>, staff
 * profiles at #staff/<id>. Selectors below come from real Jane DOM samples
 * and use icon-anchored section traversal (for patient fields) and the
 * `.profile-field > strong + .text-selectable` pattern (for staff fields).
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

/**
 * Scrape a Jane "section" anchored by an icon (e.g. .icon-home, .icon-medkit).
 * These sections follow:
 *   <div class="section">
 *     <div class="row">
 *       <div class="col-xs-2 col-sm-1 text-center"><i class="icon-..."></i></div>
 *       <div class="col-xs-10 col-sm-11"> ...value... </div>
 *     </div>
 *   </div>
 */
function extractIconSection(iconClass) {
  const icon = document.querySelector(`.section i.${iconClass}`);
  if (!icon) return null;
  const section = icon.closest('.section');
  if (!section) return null;
  const valueCell = section.querySelector('.col-xs-10, .col-sm-11');
  return valueCell || null;
}

/**
 * Find a label element (either a `<span>` with specific text-muted classes,
 * or a `<strong>`/`<dt>`) and return the text that follows it in its parent.
 * Handles both sibling-element and trailing-text-node value layouts:
 *
 *   <span>Personal Health Number</span> 0002484541      ← trailing text node
 *   <strong>Name</strong><div>Emma Smith</div>          ← sibling element
 */
function findValueByLabel(labelPatterns) {
  const all = document.querySelectorAll('label, dt, th, strong, b, div, span');
  for (const node of all) {
    const t = (node.textContent || '').trim();
    if (!t || t.length > 80) continue;
    const matches = labelPatterns.some((pat) => pat instanceof RegExp ? pat.test(t) : t.toLowerCase() === pat.toLowerCase());
    if (!matches) continue;

    // Strategy 1: next element sibling
    const sibling = node.nextElementSibling;
    if (sibling) {
      const v = text(sibling);
      if (v && v !== t && v.length < 300) return v;
    }

    // Strategy 2: text-after-label in the parent's textContent
    const parent = node.parentElement;
    if (parent) {
      const full = (parent.textContent || '').replace(/\s+/g, ' ').trim();
      const idx = full.indexOf(t);
      if (idx >= 0) {
        const after = full.slice(idx + t.length).trim();
        // Ignore if the "after" part is just another label (e.g. sibling contains other label+value pairs)
        if (after && after.length < 300 && after !== full) return after;
      }
    }
  }
  return '';
}

async function waitForMainContent(shouldStop, logger) {
  const start = Date.now();
  while (Date.now() - start < CONTENT_READY_TIMEOUT_MS) {
    if (shouldStop?.()) throw new Error('stopped');
    const heading = document.querySelector('h1');
    const ready = heading && text(heading);
    if (ready) {
      logger?.debug?.(`[profile] main content ready: "${text(heading)}"`);
      return true;
    }
    await sleep(400, { shouldStop });
  }
  logger?.warn?.('[profile] main content timeout');
  return false;
}

function scrapePatientProfile(logger) {
  // Name — the page h1 is the patient's name.
  const h1 = document.querySelector('h1');
  const name = text(h1?.querySelector('span')) || text(h1);

  // DOB — top-of-page "patient-dob-info" contains "November 24, 1992 (33 years old)"
  const dobNode = document.querySelector('[data-testid="patient-dob-info"]');
  let dob = '';
  if (dobNode) {
    // Skip the "DOB:" label child, take the other span
    const spans = dobNode.querySelectorAll('span');
    for (const s of spans) {
      if (s.getAttribute('data-testid') === 'dob-label') continue;
      const t = text(s);
      if (t && t.toLowerCase() !== 'dob:') { dob = t; break; }
    }
  }
  if (!dob) dob = findValueByLabel([/^birth date$/i, /date of birth/i, /^dob$/i]);

  // PHN — "Personal Health Number" label has value as trailing text node.
  const phn = findValueByLabel([/personal health number/i, /^phn$/i]);

  const email = firstNonEmpty(extractMailto(), findValueByLabel([/^email$/i]));
  const phone = firstNonEmpty(extractTel(), findValueByLabel([/^phone$/i, /^mobile$/i, /^cell$/i]));

  // Address — `.icon-home` anchored section.
  let address = null;
  const addressCell = extractIconSection('icon-home');
  if (addressCell) {
    const lines = Array.from(addressCell.querySelectorAll('div'))
      .map((d) => text(d))
      .filter((l) => l && l.length < 200);
    const raw = lines.join(', ');
    address = lines.length > 0 ? { lines, raw } : null;
  }

  const captured = { name, dob, phn, email, phone, address };
  const has = (v) => v && (typeof v === 'object' ? Object.keys(v).length > 0 : String(v).trim().length > 0);
  const capturedFields = Object.values(captured).filter(has).length;
  const totalFields = Object.keys(captured).length;
  const profile_status = capturedFields === totalFields ? 'ok'
    : capturedFields === 0 ? 'failed' : 'partial';

  logger?.info?.(`[profile] patient captured ${capturedFields}/${totalFields}: name="${name}" dob="${dob}" phn="${phn}" email="${email}" phone="${phone}" address=${address ? 'ok' : 'missing'}`);
  return { captured, profile_status };
}

function scrapeStaffProfile(logger) {
  // Staff profile fields are `.profile-field` with <strong>label</strong>
  // followed by a <div class="text-selectable">value</div>.
  const fieldsByLabel = {};
  for (const field of document.querySelectorAll('.profile-field')) {
    const strong = field.querySelector('strong');
    const value = field.querySelector('div.text-selectable');
    if (!strong) continue;
    const label = text(strong);
    const v = text(value);
    if (label) fieldsByLabel[label.toLowerCase()] = v;
  }

  const h1 = document.querySelector('h1');
  const name = firstNonEmpty(fieldsByLabel['name'], text(h1?.querySelector('span')), text(h1));
  const email = firstNonEmpty(extractMailto(), fieldsByLabel['email']);
  const title = firstNonEmpty(
    fieldsByLabel['disciplines'],
    fieldsByLabel['title'],
    fieldsByLabel['role'],
    fieldsByLabel['specialty'],
  );

  const captured = { name, email, title };
  const capturedFields = Object.values(captured).filter((v) => v && String(v).trim()).length;
  const profile_status = capturedFields === 3 ? 'ok'
    : capturedFields === 0 ? 'failed' : 'partial';

  logger?.info?.(`[profile] staff captured ${capturedFields}/3: name="${name}" email="${email}" title="${title}"`);
  return { captured, profile_status };
}

async function navigateViaHash(clinicName, hash, shouldStop, logger) {
  const currentHref = window.location.href;
  const onAdmin = /\.janeapp\.com\/admin/.test(currentHref);
  if (!onAdmin) {
    const full = `https://${clinicName}.janeapp.com/admin${hash}`;
    logger?.debug?.(`[profile] nav via full url: ${full}`);
    window.location.href = full;
    await sleep(TIMEOUTS.PATIENT_PAGE_LOAD, { shouldStop });
    return;
  }
  logger?.debug?.(`[profile] nav via hash change: ${hash}`);
  window.location.hash = hash;
  // Hash navigation is instant; give the SPA time to render.
  await sleep(1500, { shouldStop });
}

export async function scrapePatientProfileById({ clinicName, patientId, logger, shouldStop }) {
  logger?.info?.(`[profile] patient ${patientId}: navigating`);
  await navigateViaHash(clinicName, `#patients/${patientId}`, shouldStop, logger);
  const ready = await waitForMainContent(shouldStop, logger);
  if (!ready) {
    logger?.error?.(`[profile] patient ${patientId}: content not ready`);
    await persistProfile('patient', patientId, {}, 'failed');
    return { patientId, profile_status: 'failed' };
  }
  const { captured, profile_status } = scrapePatientProfile(logger);
  await persistProfile('patient', patientId, captured, profile_status);
  return { patientId, profile_status, captured };
}

export async function scrapeStaffProfileById({ clinicName, staffId, logger, shouldStop }) {
  logger?.info?.(`[profile] staff ${staffId}: navigating`);
  await navigateViaHash(clinicName, `#staff/${staffId}`, shouldStop, logger);
  const ready = await waitForMainContent(shouldStop, logger);
  if (!ready) {
    logger?.error?.(`[profile] staff ${staffId}: content not ready`);
    await persistProfile('staff', staffId, {}, 'failed');
    return { staffId, profile_status: 'failed' };
  }
  const { captured, profile_status } = scrapeStaffProfile(logger);
  await persistProfile('staff', staffId, captured, profile_status);
  return { staffId, profile_status, captured };
}

export async function scrapeAllProfiles({ clinicName, staffIds, patientIds, logger, shouldStop, onRateLimitCheck }) {
  const staffResults = [];
  const patientResults = [];

  logger?.info?.(`[profile] PHASE 3 begin: ${staffIds?.length || 0} staff + ${patientIds?.length || 0} patients`);

  for (const id of staffIds || []) {
    if (shouldStop?.()) return { staff: staffResults, patients: patientResults };
    if (onRateLimitCheck) await onRateLimitCheck();
    try {
      staffResults.push(await scrapeStaffProfileById({ clinicName, staffId: id, logger, shouldStop }));
    } catch (error) {
      logger?.error?.(`[profile] staff ${id} scrape failed: ${error.message}`);
    }
  }

  for (const id of patientIds || []) {
    if (shouldStop?.()) return { staff: staffResults, patients: patientResults };
    if (onRateLimitCheck) await onRateLimitCheck();
    try {
      patientResults.push(await scrapePatientProfileById({ clinicName, patientId: id, logger, shouldStop }));
    } catch (error) {
      logger?.error?.(`[profile] patient ${id} scrape failed: ${error.message}`);
    }
  }

  logger?.info?.(`[profile] PHASE 3 complete: ${staffResults.length} staff, ${patientResults.length} patients`);
  return { staff: staffResults, patients: patientResults };
}
