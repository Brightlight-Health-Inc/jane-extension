// Service worker: the only part that talks to Brightlight.
//
// ── WHAT THIS EXTENSION IS ──────────────────────────────────────────────────
//
// It is a pipe, not a product. Everything a person decides — what to copy, which
// records match, whether to write anything — happens in Brightlight. This
// extension exists for one technical reason:
//
//   Jane keeps the clinic's session in a SameSite cookie, so ONLY code running
//   inside `*.janeapp.com` can use it. A server cannot, and Jane's login cannot
//   be automated (it escalates to a reCAPTCHA image challenge).
//
// So the reading happens here, in the clinic's own browser. The cookie is never
// read, copied or transmitted — `content.js` simply fetches from Jane's origin
// and the browser attaches the session itself. This extension does not even ask
// Chrome for the `cookies` permission.
//
// ── THE SPLIT ───────────────────────────────────────────────────────────────
//
//   content.js   reads Jane. Never learns the Brightlight token.
//   background.js (this file) posts to Brightlight. Never touches Jane's cookie.
//
// The service worker also has to be the one that posts: Chrome blocks an HTTPS
// page from reaching a private address (Private Network Access), which is what a
// local Brightlight is.

const SESSION_KEY = "brightlightMigratorSession";

// The Brightlight page connects over a long-lived port so progress flows back to
// where the operator is actually looking. There is at most one run at a time.
let activePort = null;
let activeRun = null;

async function getSession() {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  return stored[SESSION_KEY] || null;
}

async function setSession(session) {
  // `storage.session` is memory-only and dies with the browser. The run key is a
  // credential; it has no business surviving on a clinic's disk.
  await chrome.storage.session.set({[SESSION_KEY]: session});
}

async function clearSession() {
  await chrome.storage.session.remove(SESSION_KEY);
}

function toPage(message) {
  try {
    activePort?.postMessage(message);
  } catch {
    // The page navigated away mid-run. The copy carries on regardless — it is
    // the server that is accumulating the data, not the tab.
  }
}

function toPanel(message) {
  chrome.runtime.sendMessage({__toPanel: true, ...message}).catch(() => {});
}

function report(message) {
  toPage(message);
  toPanel(message);
}

// ---------------------------------------------------------------------------
// talking to Brightlight
// ---------------------------------------------------------------------------

async function postJson(session, path, body) {
  const response = await fetch(`${session.serverUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.token}`,
      "X-Tenant": session.tenant,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Brightlight returned ${response.status}`);
    error.status = response.status;
    error.code = payload.code;
    throw error;
  }
  return payload;
}

async function postBlob(session, path, {sourceId, parentId, fileName, contentType, dataUrl}) {
  const blob = await (await fetch(dataUrl)).blob();
  const form = new FormData();
  form.append("file", new File([blob], fileName || sourceId, {type: contentType}));
  form.append("sourceId", sourceId);
  form.append("parentId", parentId || "");
  form.append("fileName", fileName || "");

  const response = await fetch(`${session.serverUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.token}`,
      "X-Tenant": session.tenant,
      // Content-Type is deliberately unset so the browser adds the boundary.
    },
    body: form,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Brightlight returned ${response.status}`);
  return payload;
}

// One flaky POST must not cost a page of records we already read out of Jane.
async function withRetry(operation, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      // Auth failures do not fix themselves.
      if (error.status === 401 || error.status === 403) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// the Jane tab
// ---------------------------------------------------------------------------

/**
 * Find or open the clinic's OWN Jane, named by Brightlight.
 *
 * Never "whatever janeapp tab happens to be open": a person may have more than
 * one Jane account in a browser, and copying the wrong clinic's records is not a
 * mistake that announces itself.
 */
async function resolveJaneTab(janeHost) {
  const origin = `https://${janeHost}`;
  const existing = await chrome.tabs.query({url: `${origin}/*`});

  // Not "the first tab that matches" — the first one we can actually inject
  // into. Chrome DISCARDS background tabs to reclaim memory, and a discarded tab
  // still answers `tabs.query` while `scripting.executeScript` against it fails.
  //
  // That is not a corner case: a clinic doing a migration has had Jane open all
  // day, and this picked that stale tab over the fresh one every time. The error
  // it produced blamed permissions — "grant this extension access" — which sent
  // the operator to look at the one thing that was not wrong.
  const usable =
    existing.find((tab) => !tab.discarded && tab.status === "complete") ||
    existing.find((tab) => !tab.discarded) ||
    existing[0];

  if (usable) {
    // Activating a discarded tab is what makes Chrome reload it, so this is
    // also the repair for the case where every candidate was discarded.
    await chrome.tabs.update(usable.id, {active: true});
    if (usable.discarded) await waitForTabToLoad(usable.id);
    return usable;
  }

  // A tab we just created is not a tab we can inject into. `tabs.create`
  // resolves as soon as the tab EXISTS, long before Jane has loaded, and
  // `scripting.executeScript` against a blank tab fails with an error that reads
  // like a permissions problem: "Could not reach the Jane tab. Grant this
  // extension access." That is exactly the first run at a clinic with no Jane
  // tab open — the one case that has to work.
  const tab = await chrome.tabs.create({url: `${origin}/admin`, active: true});
  await waitForTabToLoad(tab.id);
  return tab;
}

/** Resolve once the tab reports `complete`, or after `timeoutMs` regardless. */
function waitForTabToLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };

    function onUpdated(id, info) {
      if (id === tabId && info.status === "complete") finish();
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    // It may already be loaded by the time the listener is attached.
    chrome.tabs.get(tabId).then((t) => {
      if (t?.status === "complete") finish();
    }).catch(finish);
    // Signing in can take as long as the person takes; the session probe that
    // follows is what actually decides whether we may proceed.
    setTimeout(finish, timeoutMs);
  });
}

/**
 * Is this tab a signed-in Jane admin?
 *
 * Asked of the page rather than assumed, because a signed-out Jane answers the
 * API with an HTML login page and a 200 — data-shaped garbage that would sail
 * into staging unnoticed.
 */
async function probeJaneTab(tabId) {
  await chrome.scripting.executeScript({target: {tabId}, files: ["src/content.js"]});
  return chrome.tabs.sendMessage(tabId, {type: "ping"});
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

async function runMigration({serverUrl, tenant, token, importRunId, janeHost}) {
  const session = {serverUrl: String(serverUrl).replace(/\/$/, ""), tenant, token, importRunId};
  await setSession(session);
  activeRun = {importRunId, janeHost, startedAt: Date.now(), tabId: null};

  report({kind: "phase", phase: "opening", message: `Opening ${janeHost}`});
  const tab = await resolveJaneTab(janeHost);
  activeRun.tabId = tab.id;

  let probe;
  try {
    probe = await probeJaneTab(tab.id);
  } catch (error) {
    throw new Error(
      "Could not reach the Jane tab. Grant this extension access to Jane and try again."
    );
  }

  if (!probe?.ok) throw new Error("Could not start inside the Jane tab.");
  if (!probe.signedIn) {
    const error = new Error(`Sign in to Jane at ${janeHost}, then start the copy again.`);
    error.code = "JANE_SIGNED_OUT";
    throw error;
  }
  if (probe.clinicHost && probe.clinicHost !== janeHost) {
    throw new Error(
      `That tab is signed in to ${probe.clinicHost}, not ${janeHost}. Sign in to the right clinic first.`
    );
  }

  report({kind: "phase", phase: "planning", message: "Asking Brightlight what to copy"});
  const planResponse = await fetch(
    `${session.serverUrl}/migration/jane/extraction-plan?importRunId=${encodeURIComponent(importRunId)}`,
    {headers: {Authorization: `Bearer ${token}`, "X-Tenant": tenant}}
  );
  const planPayload = await planResponse.json();
  if (!planResponse.ok) throw new Error(planPayload.error || "Could not fetch the plan.");

  report({kind: "phase", phase: "copying", message: "Copying from Jane", plan: {
    scope: planPayload.plan.scope,
    years: planPayload.plan.calendar
      ? [planPayload.plan.calendar.chunk.startYear, planPayload.plan.calendar.chunk.endYear]
      : null,
    patientCap: planPayload.plan.patients?.maxPatients || 0,
  }});

  const result = await chrome.tabs.sendMessage(tab.id, {type: "run", plan: planPayload.plan});
  if (!result?.ok) throw new Error(result?.error || "The copy did not finish.");

  // A run that stopped because the Jane session expired mid-copy is NOT a run
  // that finished. It used to report as one: the pump stopped correctly, so
  // nothing false reached staging, but the counts it returned were partial and
  // the page said "Copy finished". An operator would then review and load a
  // truncated migration with no sign anything was missing.
  //
  // So the run is left un-finished. Staging is verbatim and keyed by source id,
  // so signing back in and starting again resumes over the top of it rather
  // than duplicating anything.
  if (result.result.fatal === "SESSION_LOST") {
    activeRun = null;
    await clearSession();
    const error = new Error(
      `Your Jane session ended partway through, so the copy is incomplete and has NOT been ` +
        `marked finished. Sign in to Jane at ${janeHost} and start the copy again — it will ` +
        `carry on from what was already read.`
    );
    error.code = "JANE_SESSION_LOST";
    throw error;
  }

  // Tell Brightlight what we believe we sent, so a silent partial copy cannot
  // pass as complete.
  //
  // The errors travel too. A document Jane refuses to serve — deleted there, or
  // larger than the copy will carry — has no bytes, and so does a document the
  // copy simply never reached. Those are the same absence with opposite
  // meanings: one is a documented gap, the other is an unfinished job. Sending
  // only the counts left Brightlight unable to tell them apart, and an
  // unfinished job that cannot be recognised is one nobody finishes.
  const finish = await postJson(
    session,
    `/migration/jane/runs/${importRunId}/extraction-complete`,
    {counts: result.result.counts, errors: result.result.errors || []}
  );

  activeRun = null;
  await clearSession();
  return {counts: result.result.counts, errors: result.result.errors, run: finish.run};
}

// ---------------------------------------------------------------------------
// messages from content.js (internal)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === "batch" || message?.type === "blob") {
      const session = await getSession();
      if (!session) return sendResponse({ok: false, error: "No active migration session."});
      try {
        const result =
          message.type === "batch"
            ? await withRetry(() =>
                postJson(session, `/migration/jane/runs/${session.importRunId}/ingest`, {
                  sourceEntity: message.entity,
                  documents: message.documents,
                  parentId: message.parentId || "",
                })
              )
            : await withRetry(() =>
                postBlob(session, `/migration/jane/runs/${session.importRunId}/ingest-blob`, message)
              );
        return sendResponse({ok: true, result});
      } catch (error) {
        // One record failing is not the copy failing.
        //
        // This used to report `error`, which the page treats as fatal: it tore
        // down the bridge, replaced the progress with a red banner, and froze
        // the count — while the copy carried on downloading perfectly well in
        // the tab beside it. One document Jane served empty was enough to make
        // a healthy migration of 9,211 look dead.
        //
        // The content script already handles this properly: the item is
        // recorded in `errors` and the sweep moves on. So the page is told what
        // it is — one item, skipped — and keeps watching.
        report({
          kind: "item-error",
          item: message.type === "blob" ? `file:${message.sourceId}` : message.entity,
          message: error.message,
          code: error.code,
        });
        return sendResponse({ok: false, error: error.message});
      }
    }

    // Receiving anything resets Chrome's idle timer, which is the whole point:
    // there is no work to do here beyond existing to be messaged.
    if (message?.type === "keepalive") {
      return sendResponse({ok: true, alive: Boolean(activeRun)});
    }

    if (message?.type === "progress") {
      report({kind: "progress", payload: message.payload});
      return sendResponse({ok: true});
    }

    if (message?.type === "panelStatus") {
      return sendResponse({ok: true, run: activeRun, connected: Boolean(activePort)});
    }

    return sendResponse({ok: false, error: "Unknown message"});
  })();
  return true;
});

// ---------------------------------------------------------------------------
// messages from the Brightlight page (external)
// ---------------------------------------------------------------------------

/**
 * A one-shot handshake so the app can tell whether the extension is installed
 * before it offers to start anything.
 */
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (message?.type === "ping") {
    sendResponse({
      ok: true,
      version: chrome.runtime.getManifest().version,
      busy: Boolean(activeRun),
    });
    return true;
  }
  return false;
});

/**
 * The run itself travels over a long-lived port, so progress can stream back to
 * the Brightlight page while the copy is happening. The operator watches the
 * migration where they started it, not in a side panel.
 */
chrome.runtime.onConnectExternal.addListener((port) => {
  if (port.name !== "brightlight-migration") return;
  activePort = port;

  port.onDisconnect.addListener(() => {
    if (activePort === port) activePort = null;
  });

  port.onMessage.addListener(async (message) => {
    if (message?.type === "cancelRun") {
      if (!activeRun?.tabId) {
        port.postMessage({kind: "error", message: "Nothing is running."});
        return;
      }
      try {
        // The pump lives in the Jane tab and checks this flag between every
        // request, so it stops at the next boundary rather than mid-document.
        await chrome.tabs.sendMessage(activeRun.tabId, {type: "cancel"});
        port.postMessage({kind: "phase", phase: "cancelling", message: "Stopping the copy…"});
      } catch {
        port.postMessage({
          kind: "error",
          message: "Could not reach the Jane tab to stop it. Closing that tab stops the copy.",
        });
      }
      return;
    }

    if (message?.type !== "startRun") return;

    if (activeRun) {
      port.postMessage({kind: "error", message: "A copy is already running in this browser."});
      return;
    }

    try {
      // Access to Jane is a REQUIRED permission, granted once at install, not
      // requested here.
      //
      // It was optional at first, asked for at the moment it was needed. That
      // cannot work: `chrome.permissions.request()` is only allowed during a
      // user gesture in an extension surface, and a message arriving from the
      // Brightlight page carries no gesture — the request throws, and the copy
      // dies before it reads anything. Declaring it up front is also the more
      // honest of the two: an extension whose entire purpose is reading Jane
      // should say so on the install prompt, not slip the question in later.
      //
      // A person can still narrow site access by hand in chrome://extensions,
      // so it is checked rather than assumed, and says what to do if it is off.
      const origins = [`https://${message.janeHost}/*`];
      if (!(await chrome.permissions.contains({origins}))) {
        port.postMessage({kind: "permission", origins});
        const error = new Error(
          `This extension is not allowed to read ${message.janeHost}. Open chrome://extensions, ` +
            "find Brightlight Migrator, and set Site access to \"On all sites\"."
        );
        error.code = "JANE_ACCESS_BLOCKED";
        throw error;
      }

      const result = await runMigration(message);
      port.postMessage({kind: "done", ...result});
    } catch (error) {
      activeRun = null;
      port.postMessage({kind: "error", message: error.message, code: error.code});
    }
  });
});

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({windowId: tab.windowId});
});
