// Speicherschicht: IndexedDB, alles lokal auf dem Geraet.
// Stores: members, sessions, attendance, settings (key/value).

const DB_NAME = 'dlrg-anwesenheit';
const DB_VERSION = 1;
export const STORES = ['members', 'sessions', 'attendance', 'settings'];

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('members')) db.createObjectStore('members', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'id' }).createIndex('datum', 'datum');
      }
      if (!db.objectStoreNames.contains('attendance')) {
        const s = db.createObjectStore('attendance', { keyPath: 'id' });
        s.createIndex('einheitId', 'einheitId');
        s.createIndex('mitgliedId', 'mitgliedId');
      }
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Datenbank ist in einem anderen Tab geoeffnet.'));
  });
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Speichern abgebrochen.'));
  });
}

const asPromise = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export async function getAll(store) {
  const db = await openDb();
  return asPromise(db.transaction(store).objectStore(store).getAll());
}

export async function get(store, key) {
  const db = await openDb();
  return asPromise(db.transaction(store).objectStore(store).get(key));
}

/** Einen oder mehrere Datensaetze speichern (eine Transaktion). */
export async function put(store, ...records) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  for (const r of records) tx.objectStore(store).put(r);
  return done(tx);
}

/** Mehrere Stores in einer Transaktion schreiben: { members: [...], attendance: [...] } */
export async function putMany(changes) {
  const db = await openDb();
  const names = Object.keys(changes);
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) for (const r of changes[n]) tx.objectStore(n).put(r);
  return done(tx);
}

/**
 * Schreiben und Loeschen ueber mehrere Stores in EINER Transaktion.
 * puts: { store: [records] }, dels: { store: [keys] }
 */
export async function apply(puts = {}, dels = {}) {
  const names = [...new Set([...Object.keys(puts), ...Object.keys(dels)])];
  if (!names.length) return;
  const db = await openDb();
  const tx = db.transaction(names, 'readwrite');
  for (const n of Object.keys(dels)) for (const k of dels[n]) tx.objectStore(n).delete(k);
  for (const n of Object.keys(puts)) for (const r of puts[n]) tx.objectStore(n).put(r);
  return done(tx);
}

export async function remove(store, key) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return done(tx);
}

export async function getSetting(key, fallback = null) {
  const row = await get('settings', key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  return put('settings', { key, value });
}

/** Alles lesen (fuer Backup und Export). */
export async function readAll() {
  const [members, sessions, attendance, settings] = await Promise.all(STORES.map(getAll));
  return { members, sessions, attendance, settings };
}

/** Alles in EINER Transaktion ersetzen - entweder komplett oder gar nicht (Restore). */
export async function replaceAll(data) {
  const db = await openDb();
  const tx = db.transaction(STORES, 'readwrite');
  for (const n of STORES) {
    const s = tx.objectStore(n);
    s.clear();
    for (const r of data[n] || []) s.put(r);
  }
  return done(tx);
}

/** Browser bitten, die Daten nicht bei Speicherknappheit zu loeschen. */
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch (e) {
    /* nicht unterstuetzt */
  }
  return false;
}
