/**
 * Phase 0 — resolve pasted staff names to Jane staff IDs.
 *
 * Strategy:
 *   1. Navigate to /admin/staff once to load Jane's full staff directory.
 *   2. Scroll the page to force any lazy-rendered rows into the DOM.
 *   3. Collect all anchor tags whose href matches /admin/staff/<numeric-id>
 *      and read the staff name from the link text. The adjacent cell (if
 *      present) is treated as the title/role.
 *   4. Locally fuzzy-match each parsed input name against that directory,
 *      classifying each row as ok / ambiguous / not_found.
 *
 * Why local matching rather than driving the sidebar filter input:
 *   - One DOM snapshot instead of N typed queries — far fewer failure
 *     points and much faster.
 *   - Matching logic is deterministic and inspectable; no race against
 *     the search input's debounce.
 *
 * The set of candidate nodes returned by `querySelectorAll` is the only
 * DOM-dependent bit. If Jane renames classes or changes the anchor
 * format, this module is the one to retune — the matching itself is
 * pure string logic.
 */

import { sleep } from '../../shared/utils/async-utils.js';
import { parseStaffNames } from './name-parser.js';

const STAFF_LINK_SELECTOR = 'a[href*="/admin/staff/"]';
const STAFF_ID_PATTERN = /\/admin\/staff\/(\d+)(?:$|[/?#])/;
const STAFF_DIRECTORY_PATH = '/admin/staff';

function isStaffDirectoryUrl(url) {
  return /\/admin\/staff(?:\b|$|[/?#])/.test(url);
}

async function ensureStaffDirectoryLoaded({ clinicName, shouldStop, logger }) {
  const target = `https://${clinicName}.janeapp.com${STAFF_DIRECTORY_PATH}`;
  if (!isStaffDirectoryUrl(window.location.href)) {
    logger?.info?.('Navigating to staff directory');
    window.location.href = target;
    await sleep(3500, { shouldStop });
  }

  const start = Date.now();
  while (Date.now() - start < 40000) {
    if (shouldStop?.()) throw new Error('stopped');
    const anchors = document.querySelectorAll(STAFF_LINK_SELECTOR);
    if (anchors.length > 0) break;
    await sleep(500, { shouldStop });
  }

  const container = document.scrollingElement || document.documentElement;
  let lastCount = -1;
  for (let pass = 0; pass < 8; pass++) {
    if (shouldStop?.()) throw new Error('stopped');
    container.scrollTop = container.scrollHeight;
    await sleep(600, { shouldStop });
    const count = document.querySelectorAll(STAFF_LINK_SELECTOR).length;
    if (count === lastCount) break;
    lastCount = count;
  }
}

function harvestStaffDirectory() {
  const byId = new Map();
  const anchors = document.querySelectorAll(STAFF_LINK_SELECTOR);
  for (const anchor of anchors) {
    const href = anchor.getAttribute('href') || '';
    const match = href.match(STAFF_ID_PATTERN);
    if (!match) continue;
    const staffId = match[1];
    const rawName = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
    if (!rawName) continue;
    if (byId.has(staffId)) continue;

    // Title column: look for a sibling cell or the next piece of text that
    // isn't another staff link. We try a couple of common shapes. If none
    // match, title stays empty — still a valid entry.
    let title = '';
    const row = anchor.closest('tr, li, .row, .panel');
    if (row) {
      const cells = row.querySelectorAll('td, .col, [role="cell"]');
      for (const cell of cells) {
        if (cell.contains(anchor)) continue;
        const text = (cell.textContent || '').replace(/\s+/g, ' ').trim();
        if (text && text !== rawName) { title = text; break; }
      }
    }

    byId.set(staffId, { staff_id: staffId, staff_name: rawName, title });
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

  await ensureStaffDirectoryLoaded({ clinicName, shouldStop, logger });
  const directory = harvestStaffDirectory();
  logger?.info?.(`Loaded staff directory: ${directory.length} records`);

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
