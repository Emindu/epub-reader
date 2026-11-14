// Binary storage for books and cached audio.
//
// The desktop app keeps these as files under AppData. In the browser the
// closest equivalent is IndexedDB, which holds large binary values, survives
// reloads, and is far bigger than localStorage (~5 MB). Keys look like file
// paths ("books/<id>.epub", "piper-cache/<book>/<section>_<voice>.wav") so the
// reader code can treat them the same way it treated relative paths.

const DB_NAME = 'read-web';
const DB_VERSION = 1;
const STORE = 'blobs';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
  }
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(db => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export async function blobPut(key: string, data: Uint8Array): Promise<void> {
  // Copy into a fresh buffer so later mutation of the caller's array can't
  // race the write.
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  await run('readwrite', store => store.put(copy, key));
}

export async function blobGet(key: string): Promise<Uint8Array | null> {
  const value = await run<Uint8Array | undefined>('readonly', store => store.get(key));
  return value ?? null;
}

export async function blobHas(key: string): Promise<boolean> {
  const count = await run<number>('readonly', store => store.count(key));
  return count > 0;
}

export async function blobDelete(key: string): Promise<void> {
  await run('readwrite', store => store.delete(key));
}

export async function blobDeletePrefix(prefix: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const range = IDBKeyRange.bound(prefix, prefix + '￿');
    const cursorReq = store.openKeyCursor(range);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * Ask the browser to keep our data even under storage pressure. Without this
 * a browser may evict the whole library when disk space runs low. Harmless
 * if denied or unsupported.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* unsupported */ }
  return false;
}
