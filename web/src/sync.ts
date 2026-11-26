/* Cross-device sync (server: sync-server/).

   Accounts are Firebase Auth email + password, spoken to over its REST API so
   the same code works in the Tauri webview (desktop and iOS) and the browser.

   The app describes everything it wants synced as items: { kind, book, key, data }.
   `book` is the record's contentKey (same on every device), or GLOBAL for things
   that belong to no book (journal days). An item's id is sha256(kind|book|key), so
   every device names the same note the same way. How a sync works:

   - A "shadow" remembers each item as last agreed with the server (as a short
     hash). Local items that differ from it were changed here; shadow entries
     whose book is still here but whose item is gone were deleted here (only for
     kinds in DELETABLE: progress or a journal day never "disappears").
   - "Seen" remembers when this device first noticed each local change. That is
     the change's timestamp, so an edit made offline yesterday doesn't beat an
     edit made on another device today just because it synced later.
   - Pull the server's changes since our cursor, apply those not beaten by a
     newer local change, then push the local changes. The server keeps the newer
     of two edits and hands back its copy when ours lost.
   - Removing a book from one device never deletes its notes elsewhere: delete
     markers are only sent while the book is still in the library. A book that
     arrives later (imported, or re-imported) fetches its items by key.

   Pure module: the app passes a SyncHost; this file has no DOM or app state,
   so web/ can copy it as-is. Keep it free of non-erasable TypeScript (enums,
   constructor parameter properties): sync-server/client.test.mjs runs it in Node. */

export const GLOBAL = '*';
/** Kinds whose disappearance means "deleted here". */
const DELETABLE = new Set(['highlight', 'bookmark', 'vocab']);

export type SyncData = Record<string, unknown>;
export interface SyncItem { kind: string; book: string; key: string; data: SyncData }
/** A remote change for the app to store; `data: null` means deleted. */
export interface SyncChange { kind: string; book: string; key: string; data: SyncData | null }

export interface SyncHost {
  /** contentKeys of the books on this device. */
  books(): string[];
  /** Everything stored on this device that syncs, including what earlier syncs brought in. */
  items(): SyncItem[];
  /** Store remote changes and refresh what's on screen. Must be synchronous. */
  apply(changes: SyncChange[]): void;
  /** Status line changed (signed in/out, syncing, error). */
  onStatus(): void;
}

export interface SyncConfig { serviceUrl: string; apiKey: string }

interface Item {
  id: string;
  kind: string;
  book: string;
  key: string;
  updatedAt: number;
  deleted?: boolean;
  data: SyncData | null;
}

interface Auth { uid: string; email: string; idToken: string; refreshToken: string; expiresAt: number }

interface State {
  v: 2;
  uid: string;
  cursor: number;
  /** id -> item as last agreed with the server: f = hash of its data, b/k/y = book/kind/key */
  shadow: Record<string, { f: string; b: string; k: string; y: string }>;
  /** id -> [hash of the data as last seen locally ('' = gone), when that was first seen] */
  seen: Record<string, [string, number]>;
  /** Book keys present at the last sync; a new key means "fetch its items". */
  books: string[];
  lastSyncAt: number;
  lastError: string;
}

const KEY_AUTH = 'read.sync.auth';
const KEY_STATE = 'read.sync.state';
const KEY_DEVICE = 'read.sync.device';
const PUSH_ITEMS = 200;
const PUSH_BYTES = 900_000;
const AUTO_INTERVAL = 5 * 60 * 1000;

const load = <T>(k: string): T | null => {
  try { const raw = localStorage.getItem(k); return raw ? JSON.parse(raw) as T : null; } catch { return null; }
};
const store = (k: string, v: unknown) => localStorage.setItem(k, JSON.stringify(v));

/** JSON with sorted keys, so the same data always prints the same way. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val).sort().map(k => [k, (val as Record<string, unknown>)[k]]))
      : val);
}

/** Short hash of an item's data (cyrb53): only compared for equality, never sent. */
function hashData(data: unknown): string {
  const str = canonical(data);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const idCache = new Map<string, string>();
async function itemId(kind: string, book: string, key: string): Promise<string> {
  const name = `${kind}|${book}|${key}`;
  let id = idCache.get(name);
  if (!id) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name));
    id = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    idCache.set(name, id);
  }
  return id;
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** Firebase Auth's error codes, in words people can act on. */
function authMessage(code: string): string {
  const c = code.split(' ')[0];
  return ({
    EMAIL_EXISTS: 'An account with this email already exists. Sign in instead.',
    EMAIL_NOT_FOUND: 'Wrong email or password.',
    INVALID_PASSWORD: 'Wrong email or password.',
    INVALID_LOGIN_CREDENTIALS: 'Wrong email or password.',
    INVALID_EMAIL: 'That email address doesn\'t look right.',
    WEAK_PASSWORD: 'Use a password of at least 6 characters.',
    MISSING_PASSWORD: 'Enter a password.',
    USER_DISABLED: 'This account has been disabled.',
    TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Wait a few minutes and try again.',
    TOKEN_EXPIRED: 'Your session expired. Sign in again.',
    USER_NOT_FOUND: 'Your session expired. Sign in again.',
    INVALID_REFRESH_TOKEN: 'Your session expired. Sign in again.',
  } as Record<string, string>)[c] || `Sign-in failed (${c}).`;
}

export class Sync {
  private auth: Auth | null = load<Auth>(KEY_AUTH);
  private running: Promise<void> | null = null;
  private again = false;
  private changeTimer = 0;
  private changeDue = 0;
  private syncing = false;

  private config: SyncConfig;
  private host: SyncHost;
  /** Random, per install: names this device's own journal entries. */
  readonly deviceId: string;

  // Plain fields rather than constructor parameter properties, so Node can run this
  // file directly (type stripping) in sync-server/client.test.mjs.
  constructor(config: SyncConfig, host: SyncHost) {
    this.config = config;
    this.host = host;
    let device = localStorage.getItem(KEY_DEVICE);
    if (!device) { device = randomId(); localStorage.setItem(KEY_DEVICE, device); }
    this.deviceId = device;
  }

  get configured(): boolean { return !!(this.config.serviceUrl && this.config.apiKey); }
  get email(): string | null { return this.auth?.email ?? null; }
  get busy(): boolean { return this.syncing; }

  status(): { lastSyncAt: number; lastError: string } {
    const s = this.state();
    return { lastSyncAt: s?.lastSyncAt ?? 0, lastError: s?.lastError ?? '' };
  }

  /** Sync now if signed in, then every few minutes and when the app comes back to the front. */
  start(): void {
    if (!this.configured) return;
    window.setInterval(() => { if (this.auth) void this.syncNow(); }, AUTO_INTERVAL);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.auth) void this.syncNow();
    });
    window.addEventListener('online', () => { if (this.auth) void this.syncNow(); });
    if (this.auth) void this.syncNow();
  }

  /** Something synced changed locally: sync within `delayMs`. Bursts share one sync;
      a sooner request moves the pending one earlier, a later one never delays it. */
  noteChanged(delayMs = 4000): void {
    if (!this.auth) return;
    const due = Date.now() + delayMs;
    if (this.changeTimer && this.changeDue <= due) return;
    clearTimeout(this.changeTimer);
    this.changeDue = due;
    this.changeTimer = window.setTimeout(() => { this.changeTimer = 0; void this.syncNow(); }, delayMs);
  }

  // ---- Account ----------------------------------------------------------

  async signIn(email: string, password: string, create: boolean): Promise<void> {
    const op = create ? 'signUp' : 'signInWithPassword';
    const res = await this.authFetch(`https://identitytoolkit.googleapis.com/v1/accounts:${op}`, {
      email: email.trim(), password, returnSecureToken: true,
    });
    this.setAuth({
      uid: res.localId, email: res.email, idToken: res.idToken, refreshToken: res.refreshToken,
      expiresAt: Date.now() + Number(res.expiresIn) * 1000,
    });
    await this.syncNow();
  }

  async sendPasswordReset(email: string): Promise<void> {
    await this.authFetch('https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode', {
      requestType: 'PASSWORD_RESET', email: email.trim(),
    });
  }

  /** Forget the account on this device. Notes stay here and on the server. */
  signOut(): void {
    this.auth = null;
    localStorage.removeItem(KEY_AUTH);
    localStorage.removeItem(KEY_STATE);
    this.host.onStatus();
  }

  private setAuth(a: Auth): void {
    // Another account's shadow and cursor would be wrong for this one.
    if (this.state()?.uid !== a.uid) localStorage.removeItem(KEY_STATE);
    this.auth = a;
    store(KEY_AUTH, a);
    this.host.onStatus();
  }

  private async authFetch(url: string, body: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${url}?key=${encodeURIComponent(this.config.apiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(authMessage(json?.error?.message || `HTTP ${res.status}`));
    return json;
  }

  /** A valid ID token, refreshed when it's within a minute of expiring. */
  private async token(): Promise<string> {
    const a = this.auth;
    if (!a) throw new Error('Not signed in');
    if (a.expiresAt - Date.now() > 60_000) return a.idToken;
    const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(this.config.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: a.refreshToken }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = authMessage(json?.error?.message || `HTTP ${res.status}`);
      if (res.status === 400) this.signOut();       // refresh token revoked or account deleted
      throw new Error(msg);
    }
    this.setAuth({ ...a, idToken: json.id_token, refreshToken: json.refresh_token, expiresAt: Date.now() + Number(json.expires_in) * 1000 });
    return json.id_token;
  }

  private async api(path: string, body?: unknown): Promise<any> {
    const res = await fetch(this.config.serviceUrl.replace(/\/$/, '') + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${await this.token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error || `Sync service error (HTTP ${res.status})`);
    return json;
  }

  // ---- Sync -------------------------------------------------------------

  private state(): State | null {
    const s = load<State>(KEY_STATE);
    return s && s.v === 2 ? s : null;     // older formats: start over (a full merge, nothing is lost)
  }

  /** Run a sync; a call while one is running queues exactly one more. */
  syncNow(): Promise<void> {
    if (!this.auth) return Promise.resolve();
    if (this.running) { this.again = true; return this.running; }
    this.syncing = true;
    this.host.onStatus();
    this.running = (async () => {
      do {
        this.again = false;
        const s: State = this.state()
          ?? { v: 2, uid: this.auth!.uid, cursor: 0, shadow: {}, seen: {}, books: [], lastSyncAt: 0, lastError: '' };
        try {
          await this.run(s);
          s.lastSyncAt = Date.now();
          s.lastError = '';
        } catch (err) {
          s.lastError = err instanceof Error ? err.message : String(err);
          console.warn('sync failed:', err);
        }
        if (this.auth && this.auth.uid === s.uid) store(KEY_STATE, s);
      } while (this.again && this.auth);
    })().finally(() => {
      this.running = null;
      this.syncing = false;
      this.host.onStatus();
    });
    return this.running;
  }

  private async run(s: State): Promise<void> {
    const present = new Set(this.host.books());
    present.add(GLOBAL);

    // 1. Read everything local, and note when each change was first noticed. This runs
    //    before any network call, so even offline the timestamps stay close to the edit.
    const now = Date.now();
    const local = new Map<string, SyncItem & { f: string }>();
    for (const it of this.host.items()) {
      const id = await itemId(it.kind, it.book, it.key);
      local.set(id, { ...it, f: hashData(it.data) });
    }
    for (const [id, it] of local) {
      if (s.seen[id]?.[0] !== it.f) s.seen[id] = [it.f, now];
    }
    for (const [id, seen] of Object.entries(s.seen)) {
      if (local.has(id)) continue;
      if (!s.shadow[id]) delete s.seen[id];             // never synced: nothing to delete anywhere
      else if (seen[0] !== '') s.seen[id] = ['', now];  // just disappeared
    }

    // 2. What changed here since the last sync.
    const dirty = new Map<string, Item>();
    for (const [id, it] of local) {
      if (s.shadow[id]?.f === it.f) continue;
      dirty.set(id, { id, kind: it.kind, book: it.book, key: it.key, updatedAt: s.seen[id][1], data: it.data });
    }
    for (const [id, sh] of Object.entries(s.shadow)) {
      if (local.has(id)) continue;
      if (!present.has(sh.b)) { delete s.shadow[id]; delete s.seen[id]; continue; }   // book left this device: forget, don't delete everywhere
      if (!DELETABLE.has(sh.k)) continue;
      dirty.set(id, { id, kind: sh.k, book: sh.b, key: sh.y, updatedAt: s.seen[id]?.[1] ?? now, deleted: true, data: null });
    }

    // 3. What changed elsewhere.
    const remote: Item[] = [];
    let cursor = s.cursor;
    for (let more = true; more;) {
      const page = await this.api(`/v1/sync?since=${cursor}`);
      remote.push(...page.items);
      cursor = page.cursor;
      more = page.more;
    }
    // Books new to this device since the last sync: their older items are behind the cursor.
    if (s.cursor > 0) {
      const known = new Set(s.books);
      for (const book of present) {
        if (known.has(book) || book === GLOBAL) continue;
        const { items } = await this.api(`/v1/items?book=${encodeURIComponent(book)}`);
        remote.push(...items);
      }
    }

    // 4. Apply remote changes unless a newer local change beats them.
    this.apply(s, present, remote.filter(r => {
      const d = dirty.get(r.id);
      if (d && d.updatedAt >= r.updatedAt) return false;
      dirty.delete(r.id);
      return true;
    }));
    s.cursor = cursor;
    s.books = [...present].filter(b => b !== GLOBAL);

    // 5. Send local changes in size-bounded batches; adopt the server's copy where ours lost.
    const outgoing = [...dirty.values()].map(({ id, kind, book, key, updatedAt, deleted, data }) =>
      deleted ? { id, kind, book, key, updatedAt, deleted: true } : { id, kind, book, key, updatedAt, data });
    let batch: typeof outgoing = [], bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      const sent = batch;
      batch = []; bytes = 0;
      const { results } = await this.api('/v1/sync', { items: sent });
      const lost: Item[] = [];
      for (const r of results as { id: string; status: string; item?: Item }[]) {
        const item = sent.find(c => c.id === r.id);
        if (!item) continue;
        if (r.status === 'ok') {
          if ('deleted' in item) { delete s.shadow[item.id]; delete s.seen[item.id]; }
          else s.shadow[item.id] = { f: hashData(item.data), b: item.book, k: item.kind, y: item.key };
        } else if (r.item) {
          lost.push(r.item);
        }
      }
      this.apply(s, present, lost);
    };
    for (const item of outgoing) {
      const size = JSON.stringify(item).length;
      if (batch.length >= PUSH_ITEMS || (batch.length && bytes + size > PUSH_BYTES)) await flush();
      batch.push(item);
      bytes += size;
    }
    await flush();
  }

  /** Hand remote items to the app and record them as agreed. Synchronous, so the app's
      in-memory copies are refreshed before any other code runs. */
  private apply(s: State, present: Set<string>, items: Item[]): void {
    const changes: SyncChange[] = [];
    for (const r of items) {
      if (!present.has(r.book)) continue;   // not on this device: fetched by key if it arrives
      const key = r.key ?? '';
      if (r.deleted) {
        if (!s.shadow[r.id] && !s.seen[r.id]) continue;   // never had it
        delete s.shadow[r.id];
        delete s.seen[r.id];
        changes.push({ kind: r.kind, book: r.book, key, data: null });
        continue;
      }
      if (!r.data) continue;
      const f = hashData(r.data);
      const known = s.shadow[r.id]?.f === f && s.seen[r.id]?.[0] === f;
      s.shadow[r.id] = { f, b: r.book, k: r.kind, y: key };
      s.seen[r.id] = [f, r.updatedAt];
      if (!known) changes.push({ kind: r.kind, book: r.book, key, data: r.data });   // skip echoes of our own pushes
    }
    if (changes.length) this.host.apply(changes);
  }
}
