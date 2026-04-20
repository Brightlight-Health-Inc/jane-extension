/**
 * Phase 0 — resolve pasted staff names to Jane staff IDs.
 *
 * Jane's admin is a hash-routed SPA: staff URLs look like `#staff/<id>` and
 * the full directory is always rendered in the left sidebar (`#user-list`)
 * on any admin page. We harvest that sidebar once, then fuzzy-match each
 * pasted name locally.
 *
 * Row shape in the sidebar:
 *   <li class="list-group-item [active]">
 *     <div class="btn-toolbar"><a class="list-item-latch" href="#staff/50-18">…</a></div>   (merge btn, skip)
 *     <a href="#staff/18">
 *       <span class="first_name strong">Ambrose </span>
 *       <span class="last_name">Currie </span>
 *     </a>
 *   </li>
 *
 * The direct-child selector (`li > a[href*="#staff/"]`) ignores the merge
 * button which is nested inside a div.
 */

import { sleep } from '../../shared/utils/async-utils.js';
import { parseStaffNames } from './name-parser.js';

const STAFF_LIST_CONTAINER = '#user-list';
const STAFF_ROW_SELECTOR = '#user-list li.list-group-item > a[href^="#staff/"]';
// Plain #staff/<id> only — skips merge button hrefs like #staff/50-18.
const STAFF_ID_PATTERN = /^#staff\/(\d+)$/;

function isAdminUrl(url) {
  return /\.janeapp\.com\/admin/.test(url);
}

async function ensureAdminLoaded({ clinicName, shouldStop, logger }) {
  if (!isAdminUrl(window.location.href)) {
    logger?.info?.('Navigating to Jane admin for staff directory');
    window.location.href = `https://${clinicName}.janeapp.com/admin#staff`;
    await sleep(3500, { shouldStop });
  } else if (!window.location.hash.startsWith('#staff')) {
    // Hash-route to #staff to surface the sidebar if we're elsewhere in admin.
    window.location.hash = '#staff';
    await sleep(800, { shouldStop });
  }

  const start = Date.now();
  while (Date.now() - start < 20000) {
    if (shouldStop?.()) throw new Error('stopped');
    if (document.querySelector(STAFF_ROW_SELECTOR)) return;
    await sleep(400, { shouldStop });
  }
  throw new Error('Staff directory did not load (no matching rows after 20s)');
}

function harvestStaffDirectory() {
  const byId = new Map();
  const anchors = document.querySelectorAll(STAFF_ROW_SELECTOR);
  for (const anchor of anchors) {
    const href = anchor.getAttribute('href') || '';
    const match = href.match(STAFF_ID_PATTERN);
    if (!match) continue;
    const staffId = match[1];
    if (byId.has(staffId)) continue;

    const first = (anchor.querySelector('.first_name')?.textContent || '').replace(/\s+/g, ' ').trim();
    const last = (anchor.querySelector('.last_name')?.textContent || '').replace(/\s+/g, ' ').trim();
    const rawName = `${first} ${last}`.replace(/\s+/g, ' ').trim()
      || (anchor.textContent || '').replace(/\s+/g, ' ').trim();
    if (!rawName) continue;

    byId.set(staffId, { staff_id: staffId, staff_name: rawName, title: '' });
  }
  return [...byId.values()];
}

function tokenize(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[.,]/g, '')
    .split(/\s+/)
    .filter(Boolean);
}

function scoreMatch(queryTokens, candidateTokens) {
  if (queryTokens.length === 0) return 0;
  const candidateSet = new Set(candidateTokens);
  let matched = 0;
  let prefixBonus = 0;
  for (const qt of queryTokens) {
    if (candidateSet.has(qt)) {
      matched += 1;
    } else if (candidateTokens.some((ct) => ct.startsWith(qt) || qt.startsWith(ct))) {
      prefixBonus += 0.5;
    }
  }
  return (matched + prefixBonus) / queryTokens.length;
}

function classifyMatches(query, directory) {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return { status: 'not_found', candidates: [] };

  const scored = directory.map((entry) => {
    const cTokens = tokenize(entry.staff_name);
    const score = scoreMatch(qTokens, cTokens);
    return { entry, score };
  });

  const exactName = directory.filter((e) => e.staff_name.toLowerCase() === query.toLowerCase());
  if (exactName.length === 1) {
    return { status: 'ok', candidates: [exactName[0]] };
  }

  const strong = scored.filter((s) => s.score >= 1);
  if (strong.length === 1) {
    return { status: 'ok', candidates: [strong[0].entry] };
  }
  if (strong.length > 1) {
    return { status: 'ambiguous', candidates: strong.map((s) => s.entry) };
  }

  const partial = scored
    .filter((s) => s.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  if (partial.length === 0) {
    return { status: 'not_found', candidates: [] };
  }
  if (partial.length === 1) {
    return { status: 'ambiguous', candidates: [partial[0].entry] };
  }
  return { status: 'ambiguous', candidates: partial.map((p) => p.entry) };
}

export async function resolveStaffList({ clinicName, staffNames, logger, shouldStop }) {
  const parsed = parseStaffNames(staffNames);
  if (parsed.length === 0) return { rows: [], directorySize: 0 };

  await ensureAdminLoaded({ clinicName, shouldStop, logger });
  const directory = harvestStaffDirectory();
  logger?.info?.(`Staff directory loaded: ${directory.length} records`);

  const rows = parsed.map((p) => {
    const match = classifyMatches(p.search_query, directory);
    return {
      input_name: p.display_name,
      status: match.status,
      candidates: match.candidates,
    };
  });

  return { rows, directorySize: directory.length };
}
