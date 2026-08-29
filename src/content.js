// The pump. Runs as a content script INSIDE the Jane tab.
//
// Why a content script and not the service worker: Jane's session cookie is
// SameSite-scoped, so a fetch from the extension's own origin would not carry
// it. A content script's `fetch` uses the PAGE's origin, so the session simply
// works — and the cookie is never read, copied, or transmitted anywhere. That is
// the whole security argument for this design: the patient data has to reach
// Brightlight, the key to the clinic's Jane account does not.
//
// This file knows nothing about Jane's API. It executes a plan handed to it by
// our server, so fixing an endpoint is a server deploy rather than a re-install
// in every clinic.

(() => {
  if (window.__brightlightMigratorLoaded) return;
  window.__brightlightMigratorLoaded = true;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const state = {running: false, cancelled: false, counts: {}, errors: []};

  function bump(entity, n = 1) {
    state.counts[entity] = (state.counts[entity] || 0) + n;
  }

  function progress(payload) {
    // A multi-minute extraction that shows nothing is indistinguishable from a
    // hung one, so every phase reports as it goes.
    chrome.runtime.sendMessage({type: "progress", payload}).catch(() => {});
  }

  // Push a batch to the background, which forwards it to our server. Awaiting
  // the round trip is deliberate back-pressure: without it a fast clinic queues
  // thousands of un-posted batches in memory and the tab dies.
  async function send(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (response && response.ok === false) {
      throw new Error(response.error || "Upload failed");
    }
    return response;
  }

  async function fetchJson(path, plan, attempt = 0) {
    const retry = plan.pacing.retry;
    let response;
    try {
      response = await fetch(path, {headers: {Accept: "application/json"}, credentials: "same-origin"});
    } catch (networkError) {
      if (attempt < retry.maxAttempts) {
        await sleep(Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** attempt));
        return fetchJson(path, plan, attempt + 1);
      }
      throw networkError;
    }

    if (response.status === 404) return {missing: true};

    if (retry.retryOnStatus.includes(response.status)) {
      if (attempt < retry.maxAttempts) {
        // Honour Retry-After when Jane sends one — it knows its own limits
        // better than our backoff curve does.
        const retryAfter = Number(response.headers.get("retry-after"));
        const delay =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** attempt);
        progress({type: "throttled", status: response.status, waitMs: delay});
        await sleep(delay);
        return fetchJson(path, plan, attempt + 1);
      }
      throw new Error(`Jane returned ${response.status}`);
    }

    if (!response.ok) throw new Error(`Jane returned ${response.status}`);

    // A session that expires mid-run redirects to the login page, which answers
    // 200 with HTML. Posting that as data would fill staging with markup.
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("json")) throw new Error("SESSION_LOST");

    return {data: await response.json()};
  }

  async function pool(items, plan, worker) {
    const queue = [...items];
    const size = Math.max(1, plan.pacing.concurrency);
    await Promise.all(
      Array.from({length: size}, async () => {
        while (queue.length) {
          if (state.cancelled) return;
          const item = queue.shift();
          try {
            await worker(item);
          } catch (error) {
            if (error.message === "SESSION_LOST") {
              state.cancelled = true;
              state.fatal = "SESSION_LOST";
              state.errors.push({fatal: true, message: "SESSION_LOST"});
              return;
            }
            state.errors.push({item: String(item?.id ?? item), message: error.message});
          }
          if (plan.pacing.minRequestGapMs) await sleep(plan.pacing.minRequestGapMs);
        }
      })
    );
  }

  function extract(step, body) {
    if (step.collect === "array") return Array.isArray(body) ? body : [];
    if (step.collect === "envelope") return body?.[step.envelopeKey] || [];
    return body ? [body] : [];
  }

  /**
   * Tell the service worker we are still here, every 20 seconds.
   *
   * Chrome terminates an MV3 service worker after ~30s with no activity. That is
   * fine for a worker that answers clicks and fatal for one that is shepherding a
   * migration: when Jane throttles it sends `Retry-After: 97` — sometimes 136 —
   * and this script simply sleeps. No message crosses to the worker, Chrome kills
   * it, and the next `send()` from here fails against a dead context. Measured on
   * a real run: everything stopped at five patients and the page said "the
   * extension stopped responding".
   *
   * A message — any message — resets that timer. This one deliberately runs on
   * its own interval rather than inside the request loop, because the request
   * loop is precisely what is not running during a throttle wait.
   */
  function startKeepalive() {
    const timer = setInterval(() => {
      try {
        chrome.runtime.sendMessage({type: "keepalive"}).catch(() => {});
      } catch {
        // The worker is gone and could not be woken; the run is over either way.
      }
    }, 20000);
    return () => clearInterval(timer);
  }

  async function runPlan(plan) {
    state.running = true;
    state.cancelled = false;
    state.counts = {};
    state.errors = [];
    state.fatal = "";

    if (plan.planVersion !== 1) {
      throw new Error(
        `This extension understands plan version 1, the server sent ${plan.planVersion}. Update the extension.`
      );
    }

    // A resume that only owes documents does not crawl the clinic again.
    //
    // The list of documents is the output of sweeping every patient, and on a
    // resume Brightlight is already holding it — it sends the outstanding ones
    // with their download URLs. Rebuilding that list costs twenty minutes
    // before a single byte can move, and it is where the copy kept dying: three
    // resumes in a row finished "successfully" having downloaded nothing,
    // because none survived the sweep long enough to reach the files.
    const binariesOnly = plan.resumeBinariesOnly === true;
    if (binariesOnly) {
      progress({
        type: "phase",
        message: `Resuming: ${(plan.binaries?.pending || []).length} documents left to copy.`,
      });
    }

    // ---- reference ---------------------------------------------------------
    for (const step of binariesOnly ? [] : plan.reference || []) {
      if (state.cancelled) break;
      const result = await fetchJson(step.path, plan);
      if (result.missing) continue;
      const documents = extract(step, result.data);
      if (documents.length) {
        await send({type: "batch", entity: step.entity, documents});
        bump(step.entity, documents.length);
      }
      progress({type: "reference", key: step.key, count: documents.length});
    }

    // ---- the whole schedule -------------------------------------------------
    //
    // Runs before the per-patient work because it is one cheap request per year
    // and it tells the operator immediately how big the job is.
    const calendarAppointments = [];
    if (plan.calendar && !binariesOnly && !state.cancelled) {
      const {startYear, endYear} = plan.calendar.chunk;
      for (let year = startYear; year <= endYear && !state.cancelled; year += 1) {
        const path = plan.calendar.path
          .replace("{startDate}", `${year}-01-01`)
          .replace("{endDate}", `${year}-12-31`);
        try {
          const result = await fetchJson(path, plan);
          if (result.missing) continue;

          const appointments = result.data?.[plan.calendar.envelopeKey] || [];
          if (appointments.length) {
            await send({type: "batch", entity: plan.calendar.entity, documents: appointments});
            bump(plan.calendar.entity, appointments.length);
            calendarAppointments.push(...appointments);
          }

          // `shifts` (and anything else) ride along in the same response.
          for (const extra of plan.calendar.alsoCollect || []) {
            const rows = result.data?.[extra.envelopeKey] || [];
            if (!rows.length) continue;
            await send({type: "batch", entity: extra.entity, documents: rows});
            bump(extra.entity, rows.length);
          }

          progress({
            type: "calendar",
            year,
            endYear,
            found: calendarAppointments.length,
          });
        } catch (error) {
          if (error.message === "SESSION_LOST") {
            state.cancelled = true;
            state.fatal = "SESSION_LOST";
            state.errors.push({fatal: true, message: "SESSION_LOST"});
            break;
          }
          // A failed year costs a year, not the run.
          state.errors.push({item: `calendar:${year}`, message: error.message});
        }
        if (plan.pacing.minRequestGapMs) await sleep(plan.pacing.minRequestGapMs);
      }
      progress({type: "calendar", found: calendarAppointments.length, finished: true});
    }

    // ---- patients ----------------------------------------------------------
    const patientIds = [];
    if (plan.patients && !binariesOnly && !state.cancelled) {
      if (plan.patients.mode === "explicit") {
        await pool(plan.patients.ids, plan, async (id) => {
          const result = await fetchJson(plan.patients.path.replace("{id}", id), plan);
          if (result.missing) return;
          await send({type: "batch", entity: "patient", documents: [result.data]});
          patientIds.push(id);
          bump("patient");
          progress({type: "patients", found: patientIds.length, total: plan.patients.ids.length});
        });
      } else {
        // Blockwise sweep.
        //
        // The stop condition is a run of CONSECUTIVE misses, so it cannot be
        // evaluated inside a worker pool — workers would race on the counter and
        // end the sweep at the wrong id, silently losing every patient above it.
        // Instead a whole BLOCK is fetched concurrently and the condition is
        // evaluated between blocks, against the highest id that actually hit.
        // The block must stay well under the streak window or one block could
        // straddle the gap.
        const blockSize = Math.max(1, Math.min(plan.patients.blockSize || 50, plan.patients.missStreakToStop));
        let cursor = plan.patients.startId;
        let highestHit = plan.patients.startId - 1;

        const cap = Number(plan.patients.maxPatients) || 0;

        while (!state.cancelled && cursor <= plan.patients.hardCeiling) {
          if (cap && patientIds.length >= cap) {
            progress({type: "patients", found: patientIds.length, cappedAt: cap});
            break;
          }

          // With a trial cap, never ask for more ids than the trial still needs.
          //
          // The block used to be a flat 50 no matter what, and the cap was only
          // consulted between blocks. So a 5-patient trial fetched 50 ids and
          // delivered every one that existed — 43 of them, the first time this
          // ran against a real clinic. A trial that reads eight times what was
          // asked for is not a trial anyone can reason about, and going gently
          // on a live clinic's Jane is the entire reason it exists.
          //
          // Ids are sparse, so a short block may return nothing; the loop simply
          // continues. Uncapped runs are unaffected.
          const size = cap ? Math.max(1, Math.min(blockSize, cap - patientIds.length)) : blockSize;

          const block = [];
          for (let i = 0; i < size; i += 1) block.push(cursor + i);

          await pool(block, plan, async (id) => {
            // Several ids are in flight at once, so the cap has to be re-checked
            // here too. Without it the pool would still sail past the limit by
            // however many workers happen to be running.
            if (cap && patientIds.length >= cap) return;
            const result = await fetchJson(plan.patients.path.replace("{id}", id), plan);
            if (result.missing) return;
            await send({type: "batch", entity: "patient", documents: [result.data]});
            patientIds.push(id);
            if (id > highestHit) highestHit = id;
            bump("patient");
          });

          cursor += size;
          progress({type: "patients", found: patientIds.length, cursor});

          // Nothing has answered for a whole streak window past the last real
          // patient: we are past the end of the id space.
          if (cursor - highestHit > plan.patients.missStreakToStop) break;
        }

        patientIds.sort((a, b) => a - b);
        progress({type: "patients", found: patientIds.length, done: true});
      }
    }

    // ---- per patient -------------------------------------------------------
    const appointmentIds = new Set();
    const fileRecords = [];

    for (const step of binariesOnly ? [] : plan.perPatient || []) {
      if (state.cancelled) break;
      let processed = 0;

      await pool(patientIds, plan, async (patientId) => {
        const collect = async (documents) => {
          if (!documents.length) return;
          await send({
            type: "batch",
            entity: step.entity,
            documents,
            parentId: String(patientId),
          });
          bump(step.entity, documents.length);
          for (const document of documents) {
            if (document?.appointment_id) appointmentIds.add(document.appointment_id);
            if (step.entity === "file" && document?.file_download_url) fileRecords.push(document);
          }
        };

        if (step.paging?.mode === "page") {
          let page = step.paging.startPage;
          while (page <= step.paging.maxPages && !state.cancelled) {
            const path = step.path.replace("{patientId}", patientId).replace("{page}", page);
            const result = await fetchJson(path, plan);
            if (result.missing) break;
            const documents = extract(step, result.data);
            if (!documents.length) break;
            await collect(documents);
            // A short page is the last page: Jane fixes per_page at 10 and
            // ignores any attempt to raise it.
            if (step.paging.stopOnShortPage && documents.length < step.paging.pageSize) break;
            page += 1;
          }
        } else {
          const result = await fetchJson(step.path.replace("{patientId}", patientId), plan);
          if (result.missing) return;
          await collect(extract(step, result.data));
        }

        processed += 1;
        if (processed % 5 === 0 || processed === patientIds.length) {
          progress({type: "perPatient", key: step.key, done: processed, total: patientIds.length});
        }
      });

      progress({
        type: "perPatient",
        key: step.key,
        done: processed,
        total: patientIds.length,
        finished: true,
      });
    }

    // ---- appointment enrichment ---------------------------------------------
    //
    // Which ids depends on the scope: a full migration enriches everything the
    // calendar found (minus schedule furniture), while a charts-only run
    // enriches just the visits a chart names.
    if (plan.appointments && !binariesOnly && !state.cancelled) {
      const source = plan.appointments.idsFrom || {};
      let ids;
      if (source.step === "calendar") {
        const exclude = source.excludeWhen || [];
        // A trial run is about a SUBSET of patients, so enrichment follows them.
        // Without this a 25-patient trial would still enrich the clinic's whole
        // schedule — thousands of requests for appointments it will not load.
        const cap = Number(plan.patients?.maxPatients) || 0;
        const trialPatients = cap ? new Set(patientIds.map(String)) : null;
        ids = calendarAppointments
          .filter((row) => !exclude.some((flag) => row?.[flag] === true))
          .filter((row) => !trialPatients || trialPatients.has(String(row.patient_id)))
          .map((row) => row.id);
      } else {
        ids = [...appointmentIds];
      }
      ids = [...new Set(ids)].filter(Boolean);
      let done = 0;
      await pool(ids, plan, async (id) => {
        const result = await fetchJson(plan.appointments.path.replace("{id}", id), plan);
        if (result.missing) return;
        await send({type: "batch", entity: "appointment", documents: [result.data]});
        bump("appointment");
        done += 1;
        if (done % 20 === 0) progress({type: "appointments", done, total: ids.length});
      });
      progress({type: "appointments", done, total: ids.length, finished: true});
    }

    // ---- file bytes ---------------------------------------------------------
    if (plan.binaries && !state.cancelled) {
      // Skip what a previous attempt already pulled. Eleven thousand documents
      // is hours of downloading, and something WILL interrupt it — so a resume
      // that starts from zero would ask the clinic's Jane for the same gigabytes
      // a second time.
      const alreadyStaged = new Set((plan.binaries.alreadyStaged || []).map(String));
      // Brightlight's list when it has one — it knows exactly which documents
      // it is missing — and otherwise what this sweep just found.
      const pending = plan.binaries.pending?.length
        ? plan.binaries.pending
        : alreadyStaged.size
          ? fileRecords.filter((file) => !alreadyStaged.has(String(file.id)))
          : fileRecords;

      if (alreadyStaged.size) {
        progress({
          type: "files",
          done: fileRecords.length - pending.length,
          total: fileRecords.length,
          resumed: true,
        });
      }

      let done = 0;
      await pool(pending, plan, async (file) => {
        const response = await fetch(file.file_download_url, {credentials: "same-origin"});
        if (!response.ok) {
          state.errors.push({item: `file:${file.id}`, message: `download ${response.status}`});
          return;
        }
        const blob = await response.blob();
        if (blob.size > plan.binaries.maxBytes) {
          state.errors.push({item: `file:${file.id}`, message: "exceeds size limit"});
          return;
        }
        // Blobs cannot cross the extension messaging boundary, so the bytes
        // travel as a data URL and the service worker rebuilds them.
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error("could not read file"));
          reader.readAsDataURL(blob);
        });
        await send({
          type: "blob",
          sourceId: String(file.id),
          parentId: String(file.patient_id || ""),
          fileName: file.file_name || `file-${file.id}`,
          contentType: blob.type || "application/octet-stream",
          dataUrl,
        });
        bump("file_blob");
        done += 1;
        progress({type: "files", done, total: pending.length});
      });
      progress({type: "files", done, total: pending.length, finished: true});
    }

    state.running = false;
    // `fatal` travels separately from `errors` on purpose. A run that stopped
    // because the Jane session died is not a run that finished with some items
    // skipped, and the difference decides whether an operator goes on to load a
    // truncated migration believing it is complete.
    return {
      counts: state.counts,
      errors: state.errors.slice(0, 200),
      cancelled: state.cancelled,
      fatal: state.fatal,
    };
  }

  /**
   * Is there a usable Jane session in this tab?
   *
   * Asked of the API, not the DOM. A signed-out Jane answers `/admin/api/...`
   * with the login page as HTML and a 200 status — so "the request succeeded" is
   * not the same as "we are signed in", and treating it as such would fill
   * staging with markup.
   */
  async function probeSession() {
    try {
      const response = await fetch("/api/v2/user_accounts/current_user_info", {
        headers: {Accept: "application/json"},
        credentials: "same-origin",
      });
      if (!response.ok) return {signedIn: false};
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("json")) return {signedIn: false};
      const body = await response.json();
      return {signedIn: Boolean(body?.current_user_id), userId: body?.current_user_id || null};
    } catch {
      return {signedIn: false};
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "ping") {
      probeSession().then((session) => {
        sendResponse({
          ok: true,
          running: state.running,
          signedIn: session.signedIn,
          // Which Jane account this tab is on. The background compares it against
          // the clinic Brightlight named, so a browser holding two Jane accounts
          // cannot copy the wrong one.
          clinicHost: window.location.host,
          clinic: (window.location.host.match(/^([^.]+)\.janeapp\.com$/) || [])[1] || "",
        });
      });
      return true; // async response
    }

    if (message?.type === "cancel") {
      // Every loop in the pump checks this between requests, so the copy stops
      // at a document boundary. What was already sent stays staged — stopping is
      // not undoing, and the run can be started again to carry on.
      state.cancelled = true;
      sendResponse({ok: true});
      return true;
    }

    if (message?.type === "run") {
      if (state.running) {
        sendResponse({ok: false, error: "An extraction is already running in this tab."});
        return true;
      }
      const stopKeepalive = startKeepalive();
      runPlan(message.plan)
        .then((result) => {
          stopKeepalive();
          sendResponse({ok: true, result});
        })
        .catch((error) => {
          stopKeepalive();
          state.running = false;
          sendResponse({ok: false, error: error.message});
        });
      return true; // async response
    }

    return false;
  });
})();
