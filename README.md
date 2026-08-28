# Brightlight Migrator

Copies a clinic's own records out of Jane and into Brightlight Health.

This replaced the "Jane Chart Assistant" that used to live here (removed
2026-08-27, recoverable from git history). Both had the same purpose; the
difference is worth stating:

| | Chart Assistant (removed) | Migrator (this) |
|---|---|---|
| How it reads Jane | drives the UI, scrapes the DOM | calls Jane's own JSON API |
| What it gets | printed PDFs of charts | the structured chart — ticked boxes, scale scores, vitals, signature strokes |
| Speed | one PDF per 4 seconds | ~50 ms per record |
| Files on disk | thousands of PDFs in `~/Downloads` | none |
| Breaks when | Jane changes any CSS class | Jane changes an API route (fixed server-side, no re-install) |
| Size | ~30 files of scraping logic | 3 files, no Jane knowledge compiled in |

## How it works

```
Jane tab (the clinic's own session)          Brightlight
┌──────────────────────────────┐            ┌──────────────────────┐
│ content.js                   │            │                      │
│   fetch(Jane API)  ──────────┼── data ───▶│ service worker ──────┼──▶ /migration/jane/...
│   (same-origin: the session  │            │ (holds the run key)  │
│    cookie works, and is      │            │                      │
│    never read or copied)     │            └──────────────────────┘
└──────────────────────────────┘
```

Two deliberate splits:

- **The content script reads Jane; it never learns the Brightlight run key.**
  It runs in the page's origin so Jane's `SameSite` session cookie is sent
  automatically — which also means the cookie is never read, copied or
  transmitted by us.
- **The service worker posts to Brightlight; it never sees Jane's cookie.**
  It also has to be the one to post: Chrome blocks an HTTPS page from making
  requests to a plain-HTTP server, and extension requests are not subject to that.

The extension contains **no knowledge of Jane's endpoints**. It downloads an
extraction plan from Brightlight at the start of every run
(`GET /migration/jane/extraction-plan`), so a change to Jane's API ships as a
server deploy rather than as a re-install in every clinic.

## Installing it

**One machine.** Download `brightlight-migrator.zip` from
`https://<your-clinic>.brightlight.ai/extension/brightlight-migrator.zip`, unzip
it somewhere permanent, then `chrome://extensions` → **Developer mode** →
**Load unpacked** → select the unzipped folder. Chrome loads it from that folder
on every start, so moving or deleting the folder uninstalls it.

**A managed fleet.** Install by policy instead — no developer mode, and updates
arrive on their own:

```
HKLM\Software\Policies\Google\Chrome\ExtensionInstallForcelist
  1 = lpbddgbgkjaijdaghgamppndakohciii;https://clinic.brightlight.ai/extension/update.xml
HKLM\Software\Policies\Google\Chrome\ExtensionInstallAllowlist
  1 = lpbddgbgkjaijdaghgamppndakohciii
```

A bare `.crx` cannot be installed by double-clicking or dragging it in — Chrome
has refused that for years. The signed `.crx` exists for the policy route above,
which fetches it itself.

## Releasing

```
node build.mjs                                   # dist/
node build.mjs --out ../blhClinicApp/public/extension   # what actually ships
```

The build has no dependencies and is **deterministic**: same commit in, same
bytes out. `SHA256SUMS.txt` records the digests, so "the clinic is running
exactly what we shipped" is checkable rather than assumed.

Bump `version` in `manifest.json` first. Everything under `public/extension/` is
served by the clinic app's normal deploy; the versioned `.crx` and `.zip` are
immutable, while `update.xml` and the unversioned `.zip` are stable pointers and
get a short cache (see `deploy-frontend.yml`).

### The signing key

`~/.claude/keys/brightlight-migrator.pem`, **outside this repository**, and it
belongs in the password manager.

The extension's ID — `lpbddgbgkjaijdaghgamppndakohciii` — is derived from the
matching public key, which is pinned in `manifest.json`. That ID is not a
cosmetic detail: `externally_connectable` and `EXTENSION_ID` in the clinic app
both name it, and updates only replace an install if the ID matches. **Signing
with a different key changes the ID**, which silently breaks the app's ability to
talk to the extension and turns every update into a second copy installed beside
the first. The build refuses to run if the pinned key and the signing key
disagree.

## Use

1. Sign in to Jane in the same browser.
2. In Brightlight: **Migrations**. Save your Jane address and confirm the
   extension is detected — once per clinic.
3. Choose what to copy and press **Start the copy**.

That is the whole operator flow. The extension opens Jane itself, and progress
appears in Brightlight. There is nothing to paste and nothing to configure here —
its side panel is a status window with no controls, because a second place to
answer the same question is a second answer, and one of them wins for reasons
nobody can see.

Full operator guide: `/guides/jane-migration.html` in the Brightlight app.

## The run key

It is not your Brightlight session, and no person ever sees it. The page mints it
and hands it to the extension over `externally_connectable` in the same breath.

It is scoped to one import run, expires the same day, and can do exactly two
things: fetch the extraction plan and push records into that run. It cannot start
runs, read patient data back, or trigger a load. That is verified by tests on the
server side.

## Files

- `manifest.json` — MV3. Pins the public key, so the ID is stable. Requires
  access to `janeapp.com` (see below) and names the Brightlight origins allowed
  to talk to it.
- `build.mjs` — packages and signs. No dependencies.
- `panel.html` / `panel.js` — a status window. No controls, on purpose.
- `src/background.js` — service worker. Talks to Brightlight, retries transient
  upload failures, holds the run key in `storage.session` (memory only).
- `src/content.js` — the pump. Executes the server's plan against Jane.

## Permissions

`https://*.janeapp.com/*` is a **required** host permission, granted once at
install.

It was optional at first, requested at the moment it was needed. That cannot
work: `chrome.permissions.request()` is only allowed during a user gesture in an
extension surface, and the message that starts a run arrives from a web page with
no gesture attached — the request throws and the copy dies before reading
anything. Declaring it up front is also the more honest of the two. An extension
whose entire purpose is reading Jane should say so on the install prompt rather
than slip the question in later.

Which Jane account gets read is still narrow, and is decided by Brightlight: the
worker opens the host stored on the organization and refuses to continue if that
tab turns out to be signed in to a different clinic.

## Privacy

- No analytics, no telemetry, no third-party requests.
- The Jane session cookie is never read, stored or transmitted. The extension
  does not hold the `cookies` permission at all.
- The run key lives in `chrome.storage.session`, which is memory-only and cleared
  when the browser closes.
- Patient data passes through the extension only in transit, from the clinic's
  Jane account to the clinic's own Brightlight tenant.
