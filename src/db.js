/* ────────────────────────────────────────────────────────────
   Storage. IndexedDB, four object stores:

   finds   keyPath id            your recoveries
   photos  keyPath id, ix findId JPEG blobs, kept out of the find
                                 record so the list loads fast
   marks   auto key, ix cell     the reference mark file. Indexed by
                                 0.1° cell so a radius query touches
                                 a few dozen cells instead of the
                                 whole file — this is what lets a
                                 100k-row import stay usable.
   meta    keyPath k             counts, import bookkeeping
   ──────────────────────────────────────────────────────────── */

const DB_NAME = "mark-recovery-log";
const DB_VER = 1;
let _db = null;

export function openDb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("finds"))
        db.createObjectStore("finds", { keyPath: "id" });
      if (!db.objectStoreNames.contains("photos")) {
        const s = db.createObjectStore("photos", { keyPath: "id" });
        s.createIndex("findId", "findId", { unique: false });
      }
      if (!db.objectStoreNames.contains("marks")) {
        const s = db.createObjectStore("marks", { keyPath: "i", autoIncrement: true });
        s.createIndex("cell", "cell", { unique: false });
      }
      if (!db.objectStoreNames.contains("meta"))
        db.createObjectStore("meta", { keyPath: "k" });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode) {
  return openDb().then((db) => db.transaction(store, mode).objectStore(store));
}
const wrap = (req) =>
  new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });

/* ── finds ───────────────────────────────────────────────── */
export async function getFinds() {
  const s = await tx("finds", "readonly");
  const all = await wrap(s.getAll());
  return all.sort((a, b) => (b.loggedAt || "").localeCompare(a.loggedAt || ""));
}
export async function putFind(rec) {
  const s = await tx("finds", "readwrite");
  return wrap(s.put(rec));
}
export async function deleteFind(id) {
  const db = await openDb();
  const t = db.transaction(["finds", "photos"], "readwrite");
  t.objectStore("finds").delete(id);
  const ix = t.objectStore("photos").index("findId");
  const cur = ix.openCursor(IDBKeyRange.only(id));
  cur.onsuccess = () => {
    const c = cur.result;
    if (c) { c.delete(); c.continue(); }
  };
  return new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

/* ── photos ──────────────────────────────────────────────── */
export async function getPhotos(findId) {
  const s = await tx("photos", "readonly");
  return wrap(s.index("findId").getAll(IDBKeyRange.only(findId)));
}
export async function putPhoto(p) {
  const s = await tx("photos", "readwrite");
  return wrap(s.put(p));
}
export async function deletePhoto(id) {
  const s = await tx("photos", "readwrite");
  return wrap(s.delete(id));
}

/* ── marks ───────────────────────────────────────────────── */
export const CELL = 10; // tenths of a degree ≈ 11 km
export const cellKey = (lat, lon) =>
  `${Math.floor(lat * CELL)}|${Math.floor(lon * CELL)}`;

export async function marksCount() {
  const s = await tx("marks", "readonly");
  return wrap(s.count());
}

export async function clearMarks() {
  const db = await openDb();
  const t = db.transaction(["marks", "meta"], "readwrite");
  t.objectStore("marks").clear();
  t.objectStore("meta").delete("markfile");
  return new Promise((res) => { t.oncomplete = () => res(); });
}

/* Writes in batches so a big county file doesn't lock the UI. */
export async function importMarks(list, { replace = true, onProgress } = {}) {
  if (replace) await clearMarks();
  const db = await openDb();
  const BATCH = 1000;
  for (let i = 0; i < list.length; i += BATCH) {
    const slice = list.slice(i, i + BATCH);
    await new Promise((res, rej) => {
      const t = db.transaction("marks", "readwrite");
      const s = t.objectStore("marks");
      for (const m of slice) s.put({ ...m, cell: cellKey(m.lat, m.lon) });
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
    if (onProgress) onProgress(Math.min(i + BATCH, list.length), list.length);
    await new Promise((r) => setTimeout(r, 0)); // let the paint through
  }
  const count = await marksCount();
  const s = await tx("meta", "readwrite");
  await wrap(s.put({ k: "markfile", count, at: new Date().toISOString() }));
  return count;
}

export async function getMarkMeta() {
  const s = await tx("meta", "readonly");
  return (await wrap(s.get("markfile"))) || null;
}

/* Pulls every mark in the cells covering a bounding box. Caller
   still does the true circular distance filter. */
export async function marksInBox(minLat, maxLat, minLon, maxLon) {
  const db = await openDb();
  const s = db.transaction("marks", "readonly").objectStore("marks").index("cell");
  const y0 = Math.floor(minLat * CELL), y1 = Math.floor(maxLat * CELL);
  const x0 = Math.floor(minLon * CELL), x1 = Math.floor(maxLon * CELL);
  const cells = [];
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) cells.push(`${y}|${x}`);
  if (cells.length > 4000) return { rows: [], truncated: true };
  const rows = [];
  await Promise.all(
    cells.map(
      (c) =>
        new Promise((res) => {
          const r = s.getAll(IDBKeyRange.only(c));
          r.onsuccess = () => { rows.push(...r.result); res(); };
          r.onerror = () => res();
        })
    )
  );
  return { rows, truncated: false };
}

/* ── space accounting ────────────────────────────────────── */
export async function usage() {
  if (navigator.storage?.estimate) {
    const e = await navigator.storage.estimate();
    return { used: e.usage || 0, quota: e.quota || 0 };
  }
  return null;
}
export async function persist() {
  if (navigator.storage?.persist) return navigator.storage.persist();
  return false;
}
