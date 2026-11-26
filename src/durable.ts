/* Durable copy of the app's localStorage (Tauri: desktop and iOS).

   localStorage is WebKit's: it can be reset (an iPhone lost all of it once) or
   roll back recent writes (its write-ahead log grew to ~1 GB and was dropped).
   The app keeps using localStorage for fast synchronous reads, and this module
   mirrors every `read.*` entry to its own small file under AppData/state/,
   writing only entries that changed.

   At start-up (before main.ts runs) the two are compared by a save stamp kept
   in both: when the files are newer, localStorage is rebuilt from them.

   Not covered: deleting the app, which on iOS removes AppData too. */

import { readFile, writeFile, readDir, mkdir, remove, BaseDirectory } from '@tauri-apps/plugin-fs';

const DIR = 'state';
const META = `${DIR}/__meta.json`;
const MARK = 'read.__savedAt';
const FLUSH_MS = 1500;
const base = { baseDir: BaseDirectory.AppData };

/** Caches that rebuild themselves: not worth the writes. */
const SKIP = [/^read\.locations\./, /^read\.news\.items$/, /^read\.news\.fetched$/];
const persistable = (key: string) => key.startsWith('read.') && key !== MARK && !SKIP.some(r => r.test(key));

const fileOf = (key: string) => `${DIR}/${encodeURIComponent(key)}.txt`;
const keyOf = (name: string) => decodeURIComponent(name.replace(/\.txt$/, ''));
const enc = new TextEncoder();
const dec = new TextDecoder();

const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// The real methods, so restoring and stamping don't count as changes.
const realSet = Storage.prototype.setItem;
const realRemove = Storage.prototype.removeItem;

async function readMeta(): Promise<number> {
  try { return Number(JSON.parse(dec.decode(await readFile(META, base))).savedAt) || 0; } catch { return 0; }
}

/** Rebuild localStorage from the files when they are newer. Call before the app reads anything. */
export async function restoreState(): Promise<void> {
  if (!isTauri()) return;
  await mkdir(DIR, { ...base, recursive: true });
  const fileAt = await readMeta();
  const lsAt = Number(localStorage.getItem(MARK)) || 0;

  if (!fileAt) {
    // First run with this module: copy everything out once.
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && persistable(k)) dirty.add(k);
    }
    return;
  }
  if (fileAt <= lsAt) return;   // localStorage is current

  const names = (await readDir(DIR, base)).filter(e => e.isFile && e.name.endsWith('.txt')).map(e => e.name);
  const onDisk = new Set<string>();
  for (const name of names) {
    const key = keyOf(name);
    if (!persistable(key)) continue;
    try {
      realSet.call(localStorage, key, dec.decode(await readFile(`${DIR}/${name}`, base)));
      onDisk.add(key);
    } catch (err) { console.warn('restore: could not read', name, err); }
  }
  // Entries the files don't have were removed after localStorage last saw them.
  const stale: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && persistable(k) && !onDisk.has(k)) stale.push(k);
  }
  for (const k of stale) realRemove.call(localStorage, k);
  realSet.call(localStorage, MARK, String(fileAt));
  console.info(`restored ${onDisk.size} saved entries (localStorage was behind)`);
}

const dirty = new Set<string>();
let timer = 0;
let flushing: Promise<void> | null = null;

function schedule(): void {
  if (!timer) timer = window.setTimeout(() => { timer = 0; void flush(); }, FLUSH_MS);
}

/** Write changed entries to their files, then stamp both sides. */
function flush(): Promise<void> {
  if (flushing) { schedule(); return flushing; }
  if (!dirty.size) return Promise.resolve();
  const keys = [...dirty];
  dirty.clear();
  flushing = (async () => {
    try {
      for (const k of keys) {
        const v = localStorage.getItem(k);
        if (v === null) await remove(fileOf(k), base).catch(() => { /* already gone */ });
        else await writeFile(fileOf(k), enc.encode(v), base);
      }
      const at = Date.now();
      await writeFile(META, enc.encode(JSON.stringify({ savedAt: at })), base);
      realSet.call(localStorage, MARK, String(at));
    } catch (err) {
      console.warn('durable: save failed, will retry', err);
      for (const k of keys) dirty.add(k);
      schedule();
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

/** Mirror every later localStorage change to the files. */
export function startMirroring(): void {
  if (!isTauri()) return;
  Storage.prototype.setItem = function (key: string, value: string) {
    realSet.call(this, key, value);
    if (this === localStorage && persistable(key)) { dirty.add(key); schedule(); }
  };
  Storage.prototype.removeItem = function (key: string) {
    realRemove.call(this, key);
    if (this === localStorage && persistable(key)) { dirty.add(key); schedule(); }
  };
  // Leaving the app (backgrounded on iOS, window hidden on desktop): save now.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void flush(); });
  window.addEventListener('pagehide', () => { void flush(); });
  if (dirty.size) schedule();
}
