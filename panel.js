// Side panel: a window, not a control room.
//
// There is deliberately nothing to configure here. Every decision — what to
// copy, how far back, which records match, whether to write anything — is made
// in Brightlight, because a second place to answer the same question is a second
// answer, and one of them wins for reasons nobody can see.
//
// So this shows two things: whether a copy is running, and how it is going.

const $ = (id) => document.getElementById(id);

function setStatus(text, kind = "") {
  $("statusText").textContent = text;
  $("statusText").className = kind;
  $("dot").className = `dot ${kind === "err" ? "err" : kind === "ok" ? "ok" : "live"}`;
}

function setIdle(text = "Idle") {
  $("statusText").textContent = text;
  $("statusText").className = "muted";
  $("dot").className = "dot";
  $("idleCard").style.display = "block";
  $("runCard").style.display = "none";
}

function setRunning(run) {
  $("idleCard").style.display = "none";
  $("runCard").style.display = "block";
  $("counts").style.display = "block";
  if (run?.janeHost) $("runClinic").textContent = run.janeHost.replace(".janeapp.com", "");
  if (run?.importRunId) $("runId").textContent = `${run.importRunId.slice(0, 8)}…`;
}

function renderCounts(counts) {
  $("counts").style.display = "block";
  for (const [entity, value] of Object.entries(counts || {})) {
    const node = $(`c-${entity}`);
    if (node) node.textContent = String(value);
  }
}

// The same wording the Brightlight page shows, so an operator glancing at either
// sees the same sentence rather than two vocabularies for one event.
function describeProgress(payload) {
  switch (payload?.type) {
    case "reference":
      return `Reading ${payload.key.replace(/_/g, " ")} — ${payload.count}`;
    case "calendar":
      return payload.finished
        ? `Schedule read — ${payload.found} appointments`
        : `Reading the schedule — ${payload.year} (${payload.found} so far)`;
    case "patients":
      if (payload.cappedAt) return `Stopped at ${payload.found} patients (trial run)`;
      return payload.done
        ? `Found ${payload.found} patients`
        : `Scanning patients — ${payload.found} found`;
    case "perPatient":
      return `${payload.key === "files" ? "Files" : "Charts"} — patient ${payload.done} of ${payload.total}`;
    case "appointments":
      return `Appointment details — ${payload.done} of ${payload.total}`;
    case "files":
      return `Copying files — ${payload.done} of ${payload.total}`;
    case "throttled":
      return `Jane asked us to slow down; waiting ${Math.round(payload.waitMs / 1000)}s…`;
    default:
      return "";
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message?.__toPanel) return;

  if (message.kind === "phase") {
    setRunning(null);
    setStatus(message.message);
    return;
  }
  if (message.kind === "progress") {
    const text = describeProgress(message.payload);
    if (text) {
      setRunning(null);
      setStatus(text);
    }
    return;
  }
  if (message.kind === "error") {
    setStatus(message.message || "Something went wrong.", "err");
    return;
  }
  if (message.kind === "done") {
    renderCounts(message.counts);
    const errors = message.errors?.length || 0;
    setStatus(
      errors
        ? `Finished with ${errors} item(s) skipped. Review them in Brightlight.`
        : "Finished. Go back to Brightlight to review and load.",
      errors ? "warn" : "ok"
    );
  }
});

// On open, ask the worker whether anything is in flight — a panel reopened
// mid-run should show the run, not a blank slate.
chrome.runtime
  .sendMessage({type: "panelStatus"})
  .then((status) => {
    $("version").textContent = chrome.runtime.getManifest().version;
    if (status?.run) {
      setRunning(status.run);
      setStatus("Copying…");
    } else {
      setIdle();
    }
  })
  .catch(() => {
    $("version").textContent = chrome.runtime.getManifest().version;
    setIdle();
  });
