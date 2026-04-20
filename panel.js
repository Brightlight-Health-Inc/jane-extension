/**
 * Side panel controller for the staff-first export.
 *
 * UI states:
 *   - form      : user is entering credentials + staff names
 *   - resolving : preflight in flight, waiting for review rows
 *   - review    : review table rendered, user confirming matches
 *   - running   : discovery/download/profile in progress
 *   - done      : final state, offer to start a new run
 */

const MAX_THREADS = 8;
const MAX_LOG_ENTRIES = 500;

const els = {
  formSection: document.getElementById('form-section'),
  clinicName: document.getElementById('clinic-name'),
  email: document.getElementById('email'),
  password: document.getElementById('password'),
  threadCount: document.getElementById('thread-count'),
  staffNames: document.getElementById('staff-names'),
  resolveBtn: document.getElementById('resolve-btn'),

  reviewWrap: document.getElementById('review-wrap'),
  reviewRows: document.getElementById('review-rows'),
  reviewResolvedCount: document.getElementById('review-resolved-count'),
  reviewTotalCount: document.getElementById('review-total-count'),
  reviewSummary: document.getElementById('review-summary'),
  backBtn: document.getElementById('back-btn'),
  startBtn: document.getElementById('start-btn'),

  stopBtn: document.getElementById('stop-btn'),

  phaseStrip: document.getElementById('phase-strip'),
  phaseLabel: document.getElementById('phase-label'),
  phaseDetail: document.getElementById('phase-detail'),

  statQueued: document.getElementById('stat-queued'),
  statDone: document.getElementById('stat-done'),
  statFailed: document.getElementById('stat-failed'),

  statusMessages: document.getElementById('status-messages'),
  statusCount: document.getElementById('status-count'),
};

let reviewRows = [];
let messageCount = 0;

function logStatus(message, type = 'info') {
  const msg = document.createElement('div');
  msg.className = `status-message ${type}`;
  const ts = document.createElement('span');
  ts.className = 'timestamp';
  ts.textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
  const text = document.createTextNode(String(message));
  msg.append(ts, text);
  els.statusMessages.appendChild(msg);
  while (els.statusMessages.children.length > MAX_LOG_ENTRIES) {
    els.statusMessages.removeChild(els.statusMessages.firstElementChild);
  }
  messageCount += 1;
  els.statusCount.textContent = `${messageCount} message${messageCount === 1 ? '' : 's'}`;
  const nearBottom = els.statusMessages.scrollHeight - els.statusMessages.scrollTop <= els.statusMessages.clientHeight + 50;
  if (nearBottom) els.statusMessages.scrollTop = els.statusMessages.scrollHeight;
}

function setUiState(state) {
  const running = state === 'running' || state === 'done';
  els.formSection.classList.toggle('hidden', state !== 'form');
  els.reviewWrap.classList.toggle('visible', state === 'review');
  els.stopBtn.classList.toggle('hidden', state !== 'running');
  els.phaseStrip.classList.toggle('visible', running);
  if (state === 'resolving') els.resolveBtn.disabled = true;
  if (state === 'form') els.resolveBtn.disabled = false;
}

function setPhase(phase, extras = {}) {
  const labels = {
    idle: 'Idle',
    preflight: 'Pre-flight (resolving staff names)',
    discovery: 'Phase 1 · Discovery',
    download: 'Phase 2 · Download',
    profile: 'Phase 3 · Profiles',
    done: 'Done',
    stopped: 'Stopped',
  };
  els.phaseLabel.textContent = labels[phase] || phase;
  const bits = [];
  if (extras.staffCompleted != null && extras.totalStaff != null) {
    bits.push(`${extras.staffCompleted}/${extras.totalStaff} staff`);
  }
  if (extras.tuplesFound != null) bits.push(`${extras.tuplesFound} charts found`);
  if (extras.totalTuples != null) bits.push(`${extras.totalTuples} charts queued`);
  els.phaseDetail.textContent = bits.join(' · ');
}

function updateStats(progress) {
  if (!progress) return;
  const queued = (progress.pending || 0) + (progress.in_flight || 0);
  els.statQueued.textContent = String(queued);
  els.statDone.textContent = String(progress.done || 0);
  els.statFailed.textContent = String(progress.failed || 0);
}

async function ensureClinicPermission(clinicName) {
  const origin = `https://${clinicName}.janeapp.com/*`;
  try {
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (has) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch (error) {
    logStatus(`Permission check failed: ${error.message}`, 'error');
    return false;
  }
}

els.resolveBtn.addEventListener('click', async () => {
  const clinicName = els.clinicName.value.trim();
  const email = els.email.value.trim();
  const password = els.password.value;
  const numThreads = parseInt(els.threadCount.value, 10);
  const staffNames = els.staffNames.value;

  if (!clinicName || !email || !password) {
    logStatus('Fill in clinic, email, password', 'error');
    return;
  }
  if (!Number.isInteger(numThreads) || numThreads < 1 || numThreads > MAX_THREADS) {
    logStatus(`Thread count must be 1..${MAX_THREADS}`, 'error');
    return;
  }
  if (!staffNames.trim()) {
    logStatus('Paste at least one staff name', 'error');
    return;
  }

  const permitted = await ensureClinicPermission(clinicName);
  if (!permitted) {
    logStatus(`Permission required for ${clinicName}.janeapp.com`, 'error');
    return;
  }

  setUiState('resolving');
  logStatus('Starting pre-flight resolution…', 'info');

  chrome.runtime.sendMessage({
    action: 'startStaffExport',
    clinicName, email, password, numThreads, staffNames,
  }, (response) => {
    if (chrome.runtime.lastError) {
      logStatus(`startStaffExport failed: ${chrome.runtime.lastError.message}`, 'error');
      setUiState('form');
      return;
    }
    if (!response?.ok) {
      logStatus(`startStaffExport rejected: ${response?.error || 'unknown'}`, 'error');
      setUiState('form');
    }
  });
});

els.backBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'stopExport' }, () => {
    setUiState('form');
    logStatus('Cancelled preflight, edit names and resolve again.', 'warn');
  });
});

els.startBtn.addEventListener('click', () => {
  const resolved = reviewRows
    .filter((r) => r.status === 'ok' && r.picked)
    .map((r) => ({
      input_name: r.input_name,
      staff_id: r.picked.staff_id,
      staff_name: r.picked.staff_name,
    }));
  if (resolved.length === 0) {
    logStatus('Nothing resolved — add staff and resolve first.', 'error');
    return;
  }
  els.startBtn.disabled = true;
  chrome.runtime.sendMessage({ action: 'confirmStaffResolution', resolvedStaff: resolved }, (response) => {
    if (chrome.runtime.lastError) {
      logStatus(`Start failed: ${chrome.runtime.lastError.message}`, 'error');
      els.startBtn.disabled = false;
      return;
    }
    if (!response?.ok) {
      logStatus(`Start rejected: ${response?.error || 'unknown'}`, 'error');
      els.startBtn.disabled = false;
      return;
    }
    setUiState('running');
    setPhase('discovery', { staffCompleted: 0, totalStaff: resolved.length });
  });
});

els.stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'stopExport' }, (response) => {
    if (response?.ok) logStatus('Stop signal sent', 'warn');
  });
});

function buildReviewRowElement(row, rowIndex) {
  const badgeInfo = row.status === 'ok' ? { cls: 'badge-ok', txt: '\u2713' }
    : row.status === 'ambiguous' ? { cls: 'badge-warn', txt: '!' }
    : { cls: 'badge-err', txt: '\u2717' };

  const container = document.createElement('div');
  container.className = 'review-row';

  const badge = document.createElement('span');
  badge.className = `badge ${badgeInfo.cls}`;
  badge.textContent = badgeInfo.txt;

  const nameWrap = document.createElement('div');
  nameWrap.className = 'review-name';
  const inputName = document.createElement('span');
  inputName.className = 'input-name';
  inputName.textContent = row.input_name;
  const matchedName = document.createElement('span');
  matchedName.className = 'matched-name';
  nameWrap.append(inputName, matchedName);

  const right = document.createElement('div');

  if (row.status === 'ok' && row.picked) {
    const piecesParts = [row.picked.staff_name];
    if (row.picked.title) piecesParts.push(row.picked.title);
    matchedName.textContent = piecesParts.join(' · ');
    const removeBtn = document.createElement('button');
    removeBtn.className = 'row-action';
    removeBtn.textContent = 'remove';
    removeBtn.onclick = () => { reviewRows.splice(rowIndex, 1); renderReview(); };
    right.appendChild(removeBtn);
  } else if (row.status === 'ambiguous') {
    matchedName.textContent = `${row.candidates.length} candidates`;
    const select = document.createElement('select');
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'pick one…';
    select.appendChild(placeholder);
    for (const c of row.candidates) {
      const opt = document.createElement('option');
      opt.value = String(c.staff_id);
      opt.textContent = c.title ? `${c.staff_name} · ${c.title}` : c.staff_name;
      select.appendChild(opt);
    }
    select.onchange = (event) => {
      const pick = row.candidates.find((c) => String(c.staff_id) === String(event.target.value));
      if (pick) {
        row.status = 'ok';
        row.picked = pick;
        renderReview();
      }
    };
    right.appendChild(select);
  } else {
    matchedName.textContent = 'not found';
    const removeBtn = document.createElement('button');
    removeBtn.className = 'row-action';
    removeBtn.textContent = 'remove';
    removeBtn.onclick = () => { reviewRows.splice(rowIndex, 1); renderReview(); };
    right.appendChild(removeBtn);
  }

  container.append(badge, nameWrap, right);
  return container;
}

function renderReview() {
  els.reviewRows.replaceChildren();
  let resolvedCount = 0;
  for (let i = 0; i < reviewRows.length; i++) {
    if (reviewRows[i].status === 'ok' && reviewRows[i].picked) resolvedCount += 1;
    els.reviewRows.appendChild(buildReviewRowElement(reviewRows[i], i));
  }
  els.reviewResolvedCount.textContent = String(resolvedCount);
  els.reviewTotalCount.textContent = String(reviewRows.length);
  const unresolved = reviewRows.length - resolvedCount;
  els.reviewSummary.textContent = unresolved === 0 ? 'all resolved' : `${unresolved} unresolved`;
  els.startBtn.disabled = unresolved > 0 || reviewRows.length === 0;
}

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'statusUpdate') {
    const raw = request.status?.message || '';
    const tag = request.status?.threadId ? `[${request.status.threadId}] ` : '';
    logStatus(tag + raw, request.status?.type || 'info');
    return;
  }
  if (request.action === 'preflightResults') {
    reviewRows = (request.rows || []).map((r) => ({
      input_name: r.input_name,
      status: r.status,
      candidates: r.candidates || [],
      picked: r.status === 'ok' && r.candidates?.length === 1 ? r.candidates[0] : null,
    }));
    setUiState('review');
    renderReview();
    return;
  }
  if (request.action === 'phaseUpdate') {
    setPhase(request.phase, request);
    if (request.phase === 'done') {
      setUiState('done');
    }
    return;
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.chartQueueProgress) {
    updateStats(changes.chartQueueProgress.newValue);
  }
});

(async function init() {
  const data = await chrome.storage.local.get(['runState', 'chartQueueProgress']);
  updateStats(data.chartQueueProgress);
  if (data.runState && data.runState.phase && data.runState.phase !== 'idle' && data.runState.phase !== 'done') {
    setUiState('running');
    setPhase(data.runState.phase);
    logStatus(`Reconnected (phase: ${data.runState.phase})`, 'info');
  } else {
    setUiState('form');
  }
})();
