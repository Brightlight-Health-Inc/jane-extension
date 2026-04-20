/**
 * IndexedDB wrapper for the staff-first scraper.
 *
 * Two object stores:
 *   - charts:   keyPath "chart_id", index on "status" for queue operations.
 *               Fields: { chart_id, staff_id, staff_name, patient_id, patient_name,
 *                         chart_type, chart_date, chart_url, status,
 *                         claimed_by?, claimed_at?, file_path?, failure_reason? }
 *   - profiles: keyPath ["type","id"] for both staff and patient records.
 *               Fields: { type: "staff"|"patient", id, record, profile_status,
 *                         captured_at }
 *
 * IndexedDB in MV3 service workers is scoped to the extension origin, so both
 * the coordinator and the manifest writer share one DB. Content scripts never
 * touch IndexedDB directly — they go through messages.
 */

const DB_NAME = 'jane_scraper_db';
const DB_VERSION = 1;
const STORES = {
  CHARTS: 'charts',
  PROFILES: 'profiles',
};

const STATUS = Object.freeze({
  PENDING: 'pending',
  IN_FLIGHT: 'in_flight',
  DONE: 'done',
  FAILED: 'failed',
});

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORES.CHARTS)) {
        const charts = db.createObjectStore(STORES.CHARTS, { keyPath: 'chart_id' });
        charts.createIndex('status', 'status', { unique: false });
        charts.createIndex('staff_id', 'staff_id', { unique: false });
        charts.createIndex('patient_id', 'patient_id', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.PROFILES)) {
        db.createObjectStore(STORES.PROFILES, { keyPath: ['type', 'id'] });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function runTx(storeName, mode, work) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    Promise.resolve(work(store, tx)).then((value) => { result = value; }).catch(reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  }));
}

function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function addCharts(tuples) {
  if (!tuples || tuples.length === 0) return 0;
  return runTx(STORES.CHARTS, 'readwrite', (store) => {
    for (const tuple of tuples) {
      store.put({ ...tuple, status: tuple.status || STATUS.PENDING });
    }
    return tuples.length;
  });
}

export async function claimNextPending(claimedBy) {
  return runTx(STORES.CHARTS, 'readwrite', (store) => new Promise((resolve, reject) => {
    const index = store.index('status');
    const cursorReq = index.openCursor(IDBKeyRange.only(STATUS.PENDING));
    cursorReq.onerror = () => reject(cursorReq.error);
    cursorReq.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) {
        resolve(null);
        return;
      }
      const record = cursor.value;
      record.status = STATUS.IN_FLIGHT;
      record.claimed_by = claimedBy || null;
      record.claimed_at = Date.now();
      const updateReq = cursor.update(record);
      updateReq.onsuccess = () => resolve(record);
      updateReq.onerror = () => reject(updateReq.error);
    };
  }));
}

export async function markDone(chartId, filePath) {
  return runTx(STORES.CHARTS, 'readwrite', async (store) => {
    const record = await reqAsPromise(store.get(chartId));
    if (!record) return false;
    record.status = STATUS.DONE;
    record.file_path = filePath || record.file_path || null;
    record.completed_at = Date.now();
    await reqAsPromise(store.put(record));
    return true;
  });
}

export async function markFailed(chartId, reason) {
  return runTx(STORES.CHARTS, 'readwrite', async (store) => {
    const record = await reqAsPromise(store.get(chartId));
    if (!record) return false;
    record.status = STATUS.FAILED;
    record.failure_reason = reason || 'unknown';
    record.completed_at = Date.now();
    await reqAsPromise(store.put(record));
    return true;
  });
}

export async function releaseInFlight(chartId) {
  return runTx(STORES.CHARTS, 'readwrite', async (store) => {
    const record = await reqAsPromise(store.get(chartId));
    if (!record || record.status !== STATUS.IN_FLIGHT) return false;
    record.status = STATUS.PENDING;
    record.claimed_by = null;
    record.claimed_at = null;
    await reqAsPromise(store.put(record));
    return true;
  });
}

export async function recoverInFlight() {
  return runTx(STORES.CHARTS, 'readwrite', (store) => new Promise((resolve, reject) => {
    let count = 0;
    const index = store.index('status');
    const cursorReq = index.openCursor(IDBKeyRange.only(STATUS.IN_FLIGHT));
    cursorReq.onerror = () => reject(cursorReq.error);
    cursorReq.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) {
        resolve(count);
        return;
      }
      const record = cursor.value;
      record.status = STATUS.PENDING;
      record.claimed_by = null;
      record.claimed_at = null;
      cursor.update(record);
      count += 1;
      cursor.continue();
    };
  }));
}

export async function countByStatus() {
  return runTx(STORES.CHARTS, 'readonly', async (store) => {
    const index = store.index('status');
    const counts = { pending: 0, in_flight: 0, done: 0, failed: 0 };
    await Promise.all(Object.keys(counts).map(async (status) => {
      counts[status] = await reqAsPromise(index.count(IDBKeyRange.only(status)));
    }));
    return counts;
  });
}

export async function listCharts(filter = {}) {
  return runTx(STORES.CHARTS, 'readonly', (store) => new Promise((resolve, reject) => {
    const out = [];
    const source = filter.status
      ? store.index('status').openCursor(IDBKeyRange.only(filter.status))
      : store.openCursor();
    source.onerror = () => reject(source.error);
    source.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) { resolve(out); return; }
      out.push(cursor.value);
      cursor.continue();
    };
  }));
}

export async function listDistinctPatientIds() {
  const charts = await listCharts({ status: STATUS.DONE });
  const seen = new Set();
  for (const c of charts) if (c.patient_id) seen.add(String(c.patient_id));
  return [...seen];
}

export async function clearCharts() {
  return runTx(STORES.CHARTS, 'readwrite', (store) => {
    store.clear();
    return true;
  });
}

export async function putProfile(type, id, record, profileStatus = 'ok') {
  return runTx(STORES.PROFILES, 'readwrite', async (store) => {
    await reqAsPromise(store.put({
      type,
      id: String(id),
      record,
      profile_status: profileStatus,
      captured_at: Date.now(),
    }));
    return true;
  });
}

export async function getProfile(type, id) {
  return runTx(STORES.PROFILES, 'readonly', async (store) => {
    return reqAsPromise(store.get([type, String(id)]));
  });
}

export async function listProfiles(type) {
  return runTx(STORES.PROFILES, 'readonly', (store) => new Promise((resolve, reject) => {
    const out = [];
    const cursorReq = store.openCursor();
    cursorReq.onerror = () => reject(cursorReq.error);
    cursorReq.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) { resolve(out); return; }
      if (cursor.value.type === type) out.push(cursor.value);
      cursor.continue();
    };
  }));
}

export async function clearProfiles() {
  return runTx(STORES.PROFILES, 'readwrite', (store) => {
    store.clear();
    return true;
  });
}

export const CHART_STATUS = STATUS;
