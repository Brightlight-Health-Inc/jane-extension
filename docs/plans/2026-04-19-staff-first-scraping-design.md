# Staff-first scraping — design

**Date:** 2026-04-19
**Status:** Approved for implementation planning
**Replaces:** the patient-ID sweep as the extension's sole scraping mode

## Problem

The extension currently walks patient IDs sequentially. Two issues with that model for the next run:

1. The clinic only wants charts from a curated list of "true staff" (providers who are transferring over). Many patients in the clinic belong to staff who have left and whose data is no longer needed.
2. A patient may be seen by multiple staff, and the ingestion pipeline needs to know the staff↔patient connection, not just the chart-level record.

## Goals

- Accept a free-text list of staff names (as copy-pasted from email).
- Scrape only the charts authored by staff in that list.
- Capture minimum-viable patient and staff profile data.
- Emit a connections manifest that ties every chart to both its patient and its authoring staff.
- Preserve the existing reliability features (rate-limit pause, multi-thread workers, skip-existing on resume).

## Non-goals

- No patient-ID range sweep. The old mode is removed, not preserved as an option.
- No clinical-intake or kitchen-sink profile capture. The PDF charts are the clinical record; the manifest is the identity layer.
- No human-readable output. Manifests are JSON for a data ingestion pipeline.

## Architecture

Three phases driven linearly, with pre-flight resolution in front.

```
[Paste staff names]
      ↓
PHASE 0: Pre-flight resolution
  parse names → search Jane staff → review UI (OK / ambiguous / not-found)
  user resolves edge cases → click Start
      ↓
PHASE 1: Discovery (sequential)
  for each resolved staff:
    walk /admin/staff/<id>/chart_entries (with pagination)
    scrape tuples: {staff_id, staff_name, patient_id, patient_name,
                    chart_id, chart_type, chart_date, chart_url}
    append to chartEntryQueue in chrome.storage.local
      ↓
PHASE 2: Download (N parallel threads, reuses existing PDF downloader)
  workers pull tuples from queue, open chart_url, download PDF
  file: ~/Downloads/jane-scraper/<patientID>_<PatientName>/
        <ChartType>__<chartID>__<StaffLastName>.pdf
      ↓
PHASE 3: Profile capture (sequential, after downloads)
  for each unique staff  → scrape profile → staff record
  for each unique patient → scrape profile → patient record
  write _manifest/{patients,staff,connections}.json
```

### Why two phases before download

Discovery gives us the full tuple count before the multi-hour download starts. Progress becomes "2,347 of 68,102" instead of "staff 4 of 20." Tuple queue persists, so crash recovery is a clean queue drain rather than a re-walk.

### Why profile capture last

Keeps Phase 1 cheap (one page per staff) and Phase 2 on the hot path. If the run crashes mid-Phase-2, the PDFs are safely on disk; profile capture and manifest write happen at the end.

## Phase 0 — Pre-flight name resolution

### Panel UI

1. **Credentials** (unchanged): clinic, email, password, thread count.
2. **Staff names**: `<textarea>` placeholder "Paste staff names, one per line. Titles like Dr./Mrs. are fine."
3. **Resolve** button → logs in, opens a worker tab, drives Jane's staff sidebar search for each name.
4. **Review table** renders in the panel with columns: `Input name`, `Status`, `Matched staff`, `Action`.
   - OK rows: show the matched `{name, id, role}`.
   - Ambiguous rows: dropdown to pick among candidates.
   - Not-found rows: "edit search" input to retry or "remove" button.
5. **Start Export** stays disabled until every row is resolved or removed. Count label: "18 staff queued, 2 unresolved."

### Parsing rules

- Strip trailing/leading honorifics: `Dr.`, `Dr`, `Mr.`, `Mrs.`, `Ms.`, `Mx.`, `PA`, `NP`, `RN`, `MD`.
- Collapse whitespace; handle tab-separated first/last from pasted tables (`Dr. Karen\tCoe` → `Karen Coe`).
- Drop blank lines; dedupe case-insensitively.
- Do not fuzzy-correct spelling — that belongs in the review UI.

### Persistence

On successful Start, write `resolvedStaff: [{input_name, staff_id, staff_name}, ...]` to `chrome.storage.local`. Crash-resume on the next click skips Phase 0.

## Phase 1 — Discovery

- Navigate to `/admin/staff/<id>/chart_entries` for the current staff.
- Extract from each row:
  - chart date
  - patient name (entry header)
  - staff name (right column, as sanity check)
  - chart URL: `/admin/patients/<patient_id>/chart_entries/<chart_id>?...`
  - chart type (from URL query or entry heading)
- Pagination: autoscroll until row count stops growing; fall back to `?page=` iteration if Jane uses URL pagination. This is the one DOM-dependent bit to verify during implementation.
- Append to `chartEntryQueue` in `chrome.storage.local` as the walk progresses. A mid-discovery crash loses at most the current staff's partial results.
- Progress: "Discovering staff 4/20 — 12,403 charts found so far."

## Phase 2 — Download

- Existing threading model is reused. Each worker:
  1. Atomically pulls the next `pending` tuple, marks it `in_flight`.
  2. Opens chart URL.
  3. Triggers the existing PDF download path (the `pdf-downloader.js` module already handles rate-limit pauses, retries, and interrupted-state cleanup).
  4. On success → mark `done`; on failure → mark `failed` with reason, retry queue handles re-runs.
- **File path:** `~/Downloads/jane-scraper/<patientID>_<PatientName>/<ChartType>__<chartID>__<StaffLastName>.pdf`. Staff suffix distinguishes two charts for the same patient authored by different staff.
- **Skip-existing:** before fetching, check if the target file exists on disk. If yes, mark `done`. Makes resume free.
- Rate-limit and watchdog behaviors wrap this loop the same way they wrap the current patient loop.

## Phase 3 — Profile capture

- Build `uniqueStaffIds` (from `resolvedStaff`) and `uniquePatientIds` (distinct `patient_id` in completed queue).
- For each staff: visit `/admin/staff/<id>` → scrape `{staff_id, name, email, title}`.
- For each patient: visit `/admin/patients/<id>` (Profile tab) → scrape `{patient_id, name, dob, phn, email, phone, address}`.
- Runs sequentially to stay under rate limits. Profile capture happens even if some chart downloads failed — profile data is independent of chart success.
- At the end, write three JSON files to `~/Downloads/jane-scraper/_manifest/` via `chrome.downloads.download` with blob/data URLs.

## Output shapes

### Folder layout

```
~/Downloads/jane-scraper/
├── _manifest/
│   ├── patients.json
│   ├── staff.json
│   └── connections.json
├── 457_Grace_Anderson/
│   ├── Charting_Neuromodulator__12345__Sacre.pdf
│   ├── Charting_Neuromodulator__12701__Redmond.pdf
│   └── Return_Neuromodulator__13011__Redmond.pdf
└── ...
```

### `_manifest/patients.json`

```json
[
  {
    "patient_id": "8439",
    "name": "Mrs. Anu Abraham",
    "dob": "1983-03-22",
    "phn": "0014000335",
    "email": "anujunn@gmail.com",
    "phone": "+19022932912",
    "address": {
      "street": "106 Wimbledon road",
      "city": "Bedford",
      "region": "NS",
      "postal": "B4A 3Y5"
    },
    "profile_status": "ok"
  }
]
```

### `_manifest/staff.json`

```json
[
  {
    "staff_id": "124",
    "name": "Emma Smith",
    "email": "emma@bedfordskinclinic.ca",
    "title": "Esthetician",
    "profile_status": "ok"
  }
]
```

### `_manifest/connections.json`

```json
[
  {
    "chart_id": "99812",
    "chart_type": "Chart",
    "chart_date": "2026-04-09",
    "patient_id": "8439",
    "staff_id": "124",
    "file_path": "8439_Anu_Abraham/Chart__99812__Smith.pdf",
    "download_status": "ok"
  }
]
```

- IDs are strings (Jane's numeric IDs treated as opaque tokens).
- Dates are ISO 8601.
- `download_status` may be `"ok"` or `"failed_<reason>"`. Failed rows omit `file_path`.
- `profile_status` may be `"ok"` or `"failed"`.

### Filename convention

`<ChartType>__<chartID>__<StaffLastName>.pdf`
- `ChartType` and `StaffLastName` are ASCII-slugified.
- `chartID` is the stable key and joins back to `connections.json`.
- Double-underscore separators keep the filename parseable.

## Persistent state

```
chrome.storage.local:
  runState: { phase: 'preflight' | 'discovery' | 'download' | 'profile' | 'done',
              clinicName, threadCount, userRequestedStop }
  resolvedStaff: [{ input_name, staff_id, staff_name }, ...]
  chartEntryQueue: [
    { chart_id, staff_id, patient_id, patient_name, chart_type,
      chart_date, chart_url, status }
  ]
  capturedProfiles: { patients: { id -> record }, staff: { id -> record } }
```

## Resume semantics

On Start click:

1. Read `runState.phase`. Skip completed phases.
2. For in-progress phases:
   - **Discovery**: resume at the first staff whose entries were not fully walked.
   - **Download**: filter `chartEntryQueue` for `status !== 'done'`. Re-queue `in_flight` back to `pending` (those were interrupted by the crash).
   - **Profile**: resume from the first staff/patient not in `capturedProfiles`.
3. Skip-existing file check runs on every download attempt regardless, catching anything that hit disk before the crash but before we persisted the `done` flag.

## Rate-limit handling

Reused unchanged:
- `pauseAllThreadsAndRetry` for the "Whoa there friend" banner.
- Global rate-limit gate across threads.
- Watchdog for frozen tabs.

Phases 1 and 3 go through the same rate-limit checkpoints between each page navigation, just with concurrency 1.

## Code changes

### New files

- `src/content/discovery/staff-resolver.js` — Phase 0 name → staff_id via sidebar search.
- `src/content/discovery/staff-entries-walker.js` — Phase 1 chart-entries pagination and tuple extraction.
- `src/content/discovery/profile-scraper.js` — Phase 3 patient/staff profile extraction.
- `src/background/coordinator/chart-queue.js` — tuple queue, replaces `work-scheduler.js`'s patient-ID pool.
- `src/background/manifest/manifest-writer.js` — serializes the three JSON files.

### Modified files

- `panel.html` / `panel.js` — remove patient-range inputs; add staff textarea, Resolve button, review table, phase-aware progress.
- `src/background/background-main.js` — phase state machine.
- `src/content/content-main.js` — dispatch on phase.

### Removed

- `work-scheduler.js` patient-ID pool, `maxPatientId` plumbing, and any `/admin/patients/<id>` iteration logic not used by Phase 3.

## Testing plan

- **Unit-ish:** parse free-form pasted names (including the email table format) → expected normalized list.
- **Phase 0:** dry-run resolution against a known staff list; verify OK/ambiguous/not-found rows render correctly.
- **Phase 1:** run discovery for 1 staff with a known chart count; verify tuple count matches what's visible in Jane's UI.
- **End-to-end small:** 2 staff with <50 charts each; verify PDFs on disk match `connections.json`, manifests are well-formed JSON.
- **Resume:** kill mid-Phase-2; restart; confirm queue resumes and no duplicate downloads.

## Open items (to be verified during implementation)

- Exact DOM selectors for the staff sidebar search input.
- Pagination mechanism on `/admin/staff/<id>/chart_entries` (infinite scroll vs URL page param).
- Field selectors on `/admin/staff/<id>` for the staff profile.
- Rate-limit behavior on `/admin/staff/*` vs `/admin/patients/*` (may or may not share throttle buckets).
