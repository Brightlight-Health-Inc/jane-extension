/**
 * Parse free-form pasted staff names into a normalized list.
 *
 * Handles:
 *   - blank lines
 *   - honorific prefixes (Dr., Dr, Mr., Mrs., Ms., Mx.)
 *   - trailing professional suffixes (MD, PA, NP, RN, DO, PhD, LPN)
 *   - tab-separated first/last columns (from pasted tables)
 *   - consecutive whitespace
 *   - case-insensitive dedup while preserving first-seen display form
 *
 * Returns an array of { display_name, search_query } where:
 *   display_name  = what to show the user in the review table (original casing preserved)
 *   search_query  = what to feed into Jane's staff-search input
 */

const HONORIFICS = ['dr.', 'dr', 'mr.', 'mr', 'mrs.', 'mrs', 'ms.', 'ms', 'mx.', 'mx'];
const SUFFIXES = ['md', 'do', 'pa', 'np', 'rn', 'lpn', 'phd', 'dds', 'dmd'];

function stripHonorifics(tokens) {
  while (tokens.length > 0 && HONORIFICS.includes(tokens[0].toLowerCase())) {
    tokens.shift();
  }
  return tokens;
}

function stripSuffixes(tokens) {
  while (tokens.length > 0) {
    const last = tokens[tokens.length - 1].toLowerCase().replace(/[.,]+$/, '');
    if (SUFFIXES.includes(last)) {
      tokens.pop();
    } else {
      break;
    }
  }
  return tokens;
}

function normalizeSingle(line) {
  if (!line) return null;
  const collapsed = line.replace(/[\t\u00A0]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!collapsed) return null;
  const tokens = collapsed.split(' ').filter(Boolean);
  const cleaned = stripSuffixes(stripHonorifics(tokens.slice()));
  if (cleaned.length === 0) return null;
  const searchQuery = cleaned.join(' ');
  return { display_name: collapsed, search_query: searchQuery };
}

export function parseStaffNames(input) {
  if (!input) return [];
  const lines = String(input).split(/\r?\n/);
  const seen = new Map();
  for (const line of lines) {
    const row = normalizeSingle(line);
    if (!row) continue;
    const key = row.search_query.toLowerCase();
    if (seen.has(key)) continue;
    seen.set(key, row);
  }
  return [...seen.values()];
}
