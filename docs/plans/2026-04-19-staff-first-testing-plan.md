# Staff-first scraping — testing plan

**Branch:** `feature/staff-first-scraping`
**Worktree:** `.worktrees/staff-first`

## Before loading the extension

1. Load the extension at `chrome://extensions` via **Load unpacked** pointing at
   `.../jane-extension/.worktrees/staff-first`.
2. Confirm the side panel icon is visible in the toolbar and the extension
   is enabled.
3. Open `chrome://extensions/?id=<extension-id>` → **Details** → **Inspect
   views → service worker** to keep the background console open. Phase
   transitions + queue mutations log here.

## Test 1 — Name parser

Open the background service worker console (see step 3 above) and paste:

```js
const mod = await import(chrome.runtime.getURL('src/content/discovery/name-parser.js'));
mod.parseStaffNames([
  'Farhat Shabbir',
  'Dr. Kimberly Mach',
  'Dr. Marie-Claude Lang',
  '',
  '  Emma  Smith  ',
  'Dr. Karen\tCoe',
  'Jason Tucker MD',
].join('\n'));
```

Expect 6 entries. Check that:
- `display_name` preserves original casing.
- `search_query` has no "Dr." prefix, no "MD" suffix, no tabs.
- Duplicates removed (case-insensitive).

## Test 2 — Pre-flight with a small list (sanity)

1. Click the extension icon, panel opens.
2. Fill in: clinic name, email, password, threads=4.
3. Paste a list of 3 staff names you **know** exist at the clinic. Include
   one with an honorific (`Dr. ...`).
4. Click **Resolve Staff**.
5. Expect: a primary tab opens at the clinic, content script logs in,
   navigates to `/admin/staff`, review table populates in the panel with
   ✓ badges for each.
6. Click **Start Export**.
7. Expect a transition to Phase 1 progress: "Phase 1 · Discovery: 1/3
   staff · N charts found".

If a name resolves as ⚠️ ambiguous, use the dropdown to pick the right
candidate. If it's ❌ not found, either fix the input (Back to edit) or
remove the row.

## Test 3 — Discovery scales

Run with one staff member known to have **many** chart entries (100+).
Expect:
- Panel shows incrementing `tuplesFound` count during the walk.
- On completion, Phase 2 begins. `Queued` stat jumps to the tuple count.

## Test 4 — End-to-end small run

Target: two staff with ≤ 50 charts each.

1. Run through the full flow to completion.
2. Open `~/Downloads/jane-scraper/` and confirm:
   - Per-patient folders exist: `<patientID>_<patientName>/`.
   - Each folder contains PDFs named
     `<ChartType>__<chartID>__<StaffLast>.pdf`.
   - `_manifest/patients.json`, `_manifest/staff.json`,
     `_manifest/connections.json` exist and parse as valid JSON
     (`python3 -m json.tool <file>`).
3. Open one chart PDF in a viewer — confirm it's a real PDF, not an
   HTML error page.

## Test 5 — Resume after crash

1. Start a run (2-3 staff, 100+ charts total).
2. Mid-download, right-click a worker tab → **Close**, or click **Stop
   Export** in the panel.
3. Wait a few seconds for cleanup.
4. Click **Resolve Staff** again with the same list → **Start**.
5. Expect: files that already downloaded are skipped (log shows
   `Skip (exists): ...`). No duplicate PDFs. Final connection count
   matches the total from the uninterrupted run.

## Test 6 — Rate-limit behaviour

If Jane rate-limits mid-run (panel shows "Whoa there friend…" warnings
from the existing detector), confirm:
- All threads pause and resume without user intervention.
- No tuple gets stuck "in-flight" after the pause — the download count
  continues climbing afterward.

## Test 7 — Stop mid-discovery

1. Start with ~5 staff.
2. During Phase 1, click **Stop Export** in the panel.
3. Expect: primary tab closes, panel shows "Stopped", no queue is left
   in a partial state. Re-running **Resolve Staff** works cleanly.

## Known open items — sanity-check selectors

These are the DOM-dependent bits I had to guess at because I didn't
have live Jane samples. If anything breaks in Tests 2-4, the fix likely
lives in one of these selectors:

- `src/content/discovery/staff-resolver.js:STAFF_LINK_SELECTOR` — how
  we find staff anchors in the `/admin/staff` directory.
- `src/content/discovery/staff-entries-walker.js` — the patient-name
  fallback chain (`[data-test-id="chart_entry_patient_name"]` et al.)
  may need tuning once we see a real chart-entries row on a staff page.
- `src/content/discovery/profile-scraper.js:findValueByLabel` — the
  label-text scanner for patient/staff profile fields. Patient DOB
  and PHN are the fields most likely to need tweaking.
