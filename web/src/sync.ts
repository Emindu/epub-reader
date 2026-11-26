/* Cross-device sync of highlights and bookmarks (server: sync-server/).

   Accounts are Firebase Auth email + password, spoken to over its REST API so
   the same code works in the Tauri webview (desktop and iOS) and the browser.

   How a sync works, without touching any of the app's highlight code:
   - Every note becomes an item named sha256(kind|book|cfi), where `book` is the
     record's contentKey, so all devices name the same highlight the same way.
   - A "shadow" remembers what each item looked like at the last sync. Local
     items that differ from it were edited here; shadow entries whose book is
     still here but whose item is gone were deleted here.
   - Pull the server's changes since our cursor, apply those that aren't
     beaten by a newer local edit, then push the local edits. The server keeps
     the newer of two edits and hands back its copy when ours lost.
   - Removing a book from one device never deletes its notes elsewhere: notes
     only get delete markers while their book is still in the library. A book
     that arrives later (imported, or re-imported) fetches its notes by key.

   Pure module: the app passes a SyncHost; this file has no DOM or app state,
   so web/ can copy it as-is. */

export type SyncKind = 'highlight' | 'bookmark';

export interface SyncMark { cfi: string; [field: string]: unknown }
export interface SyncMarks { highlights: SyncMark[]; bookmarks: SyncMark[] }

export interface SyncHost {
  /** Library items that can sync: per-device id plus the cross-device key. */
  books(): { id: string; contentKey: string }[];
  readMarks(bookId: string): SyncMarks;
  writeMarks(bookId: string, marks: SyncMarks): void;
  /** Called synchronously right after remote changes were written. */
  onRemoteChange(bookIds: string[]): void;
  /** Status line changed (signed in/out, syncing, error). */
  onStatus(): void;
}

export interface SyncConfig { serviceUrl: string; apiKey: string }

interface Item {
  id: string;
  kind: SyncKind;
  book: string;
  updatedAt: number;
  deleted?: boolean;
  data: SyncMark | null;
}

interface Auth { uid: string; email: string; idToken: string; refreshToken: string; expiresAt: number }

interface State {
  uid: string;
  cursor: number;
  /** id -> { b: book key, f: fingerprint of the data last agreed with the server } */
  shadow: Record<string, { b: string; f: string }>;
  /** Book keys present at the last sync; a new key means "fetch its notes". */
  books: string[];
  lastSyncAt: number;
  lastError: string;
}

const KEY_AUTH = 'read.sync.auth';
const KEY_STATE = 'read.sync.state';
const PUSH_CHUNK = 200;
const AUTO_INTERVAL = 5 * 60 * 1000;
const CHANGE_DELAY = 4000;

const load = <T>(k: string): T | null => {
  try { const raw = localStorage.getItem(k); return raw ? JSON.parse(raw) as T : null; } catch { return null; }
};
const store = (k: string, v: unknown) => localStorage.setItem(k, JSON.stringify(v));

/** JSON with sorted keys, so the same note always prints the same way. */
function fingerprint(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val).sort().map(k => [k, (val as Record<string, unknown>)[k]]))
      : val);
}

const idCache = new Map<string, string>();
async function itemId(kind: SyncKind, book: string, cfi: string): Promise<string> {
  const name = `${kind}|${book}|${cfi}`;
  let id = idCache.get(name);
  if (!id) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name));
    id = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    idCache.set(name, id);
  }
  return id;
}

const listOf = (marks: SyncMarks, kind: SyncKind) => kind === 'highlight' ? marks.highlights : marks.bookmarks;

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
  private syncing = false;

  private config: SyncConfig;
  private host: SyncHost;

  // Plain fields rather than constructor parameter properties, so Node can run this
  // file directly (type stripping) in sync-server/client.test.mjs.
  constructor(config: SyncConfig, host: SyncHost) {
    this.config = config;
    this.host = host;
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

  /** A note changed locally: sync shortly, batching bursts of edits. */
  noteChanged(): void {
    if (!this.auth) return;
    clearTimeout(this.changeTimer);
    this.changeTimer = window.setTimeout(() => { void this.syncNow(); }, CHANGE_DELAY);
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

  private state(): State | null { return load<State>(KEY_STATE); }

  /** Run a sync; a call while one is running queues exactly one more. */
  syncNow(): Promise<void> {
    if (!this.auth) return Promise.resolve();
    if (this.running) { this.again = true; return this.running; }
    this.syncing = true;
    this.host.onStatus();
    this.running = (async () => {
      do {
        this.again = false;
        const s = this.state() ?? { uid: this.auth!.uid, cursor: 0, shadow: {}, books: [], lastSyncAt: 0, lastError: '' };
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

  private async collect(bookKeys: Map<string, string>): Promise<Map<string, Item & { data: SyncMark }>> {
    const out = new Map<string, Item & { data: SyncMark }>();
    for (const [book, bookId] of bookKeys) {
      const marks = this.host.readMarks(bookId);
      for (const kind of ['highlight', 'bookmark'] as SyncKind[]) {
        for (const m of listOf(marks, kind)) {
          if (!m || typeof m.cfi !== 'string') continue;
          const id = await itemId(kind, book, m.cfi);
          out.set(id, { id, kind, book, updatedAt: 0, data: m });
        }
      }
    }
    return out;
  }

  private async run(s: State): Promise<void> {
    // contentKey -> local book id (first copy wins if the library holds duplicates)
    const bookKeys = new Map<string, string>();
    for (const b of this.host.books()) if (b.contentKey && !bookKeys.has(b.contentKey)) bookKeys.set(b.contentKey, b.id);

    // 1. What changed here since the last sync.
    const now = Date.now();
    const local = await this.collect(bookKeys);
    const dirty = new Map<string, Item>();
    for (const [id, item] of local) {
      if (s.shadow[id]?.f !== this.fp(item.kind, item.data)) dirty.set(id, { ...item, updatedAt: now });
    }
    for (const [id, sh] of Object.entries(s.shadow)) {
      if (local.has(id)) continue;
      if (bookKeys.has(sh.b)) {
        // Deleted here. The id doesn't encode the kind, but the shadow's fingerprint does.
        const kind = (JSON.parse(sh.f) as { __kind?: SyncKind }).__kind;
        if (kind) dirty.set(id, { id, kind, book: sh.b, updatedAt: now, deleted: true, data: null });
        else delete s.shadow[id];
      } else {
        delete s.shadow[id];               // book left this device: forget, don't delete everywhere
      }
    }

    // 2. What changed elsewhere.
    const remote: Item[] = [];
    let cursor = s.cursor;
    for (let more = true; more;) {
      const page = await this.api(`/v1/sync?since=${cursor}`);
      remote.push(...page.items);
      cursor = page.cursor;
      more = page.more;
    }
    // Books new to this device since the last sync: their older notes are behind the cursor.
    if (s.cursor > 0) {
      const known = new Set(s.books);
      for (const book of bookKeys.keys()) {
        if (known.has(book)) continue;
        const { items } = await this.api(`/v1/items?book=${encodeURIComponent(book)}`);
        remote.push(...items);
      }
    }

    // 3. Apply remote changes unless a newer local edit beats them.
    const incoming = remote.filter(r => {
      const d = dirty.get(r.id);
      if (d && d.updatedAt >= r.updatedAt) return false;
      dirty.delete(r.id);
      return true;
    });
    await this.hashBooks(bookKeys, incoming);
    this.apply(s, bookKeys, incoming);
    s.cursor = cursor;
    s.books = [...bookKeys.keys()];

    // 4. Send local edits; adopt the server's copy where ours lost.
    const outgoing = [...dirty.values()];
    for (let i = 0; i < outgoing.length; i += PUSH_CHUNK) {
      const chunk = outgoing.slice(i, i + PUSH_CHUNK);
      const { results } = await this.api('/v1/sync', {
        items: chunk.map(({ id, kind, book, updatedAt, deleted, data }) =>
          deleted ? { id, kind, book, updatedAt, deleted: true } : { id, kind, book, updatedAt, data }),
      });
      const lost: Item[] = [];
      for (const r of results as { id: string; status: string; item?: Item }[]) {
        const sent = chunk.find(c => c.id === r.id);
        if (!sent) continue;
        if (r.status === 'ok') {
          if (sent.deleted) delete s.shadow[sent.id];
          else s.shadow[sent.id] = { b: sent.book, f: this.fp(sent.kind, sent.data) };
        } else if (r.item) {
          lost.push(r.item);
        }
      }
      await this.hashBooks(bookKeys, lost);
      this.apply(s, bookKeys, lost);
    }
  }

  /** Make sure every note in the books these items touch has its id cached, so the
      synchronous apply() can find a deleted note from its id alone. */
  private async hashBooks(bookKeys: Map<string, string>, items: Item[]): Promise<void> {
    for (const book of new Set(items.filter(i => i.deleted).map(i => i.book))) {
      const bookId = bookKeys.get(book);
      if (!bookId) continue;
      const marks = this.host.readMarks(bookId);
      for (const kind of ['highlight', 'bookmark'] as SyncKind[]) {
        for (const m of listOf(marks, kind)) if (m && typeof m.cfi === 'string') await itemId(kind, book, m.cfi);
      }
    }
  }

  /** Fingerprint that also records the kind, so a delete can be sent later from the shadow alone. */
  private fp(kind: SyncKind, data: SyncMark | null): string {
    return fingerprint({ ...(data ?? {}), __kind: kind });
  }

  /** Write remote items into the books they belong to. Synchronous, so the open
      book's in-memory copy is refreshed (onRemoteChange) before other code runs. */
  private apply(s: State, bookKeys: Map<string, string>, items: Item[]): void {
    const touched = new Map<string, SyncMarks>();
    const changed = new Set<string>();
    for (const r of items) {
      const bookId = bookKeys.get(r.book);
      if (!bookId) continue;                // not on this device: fetched by key if it arrives
      if (!r.deleted && r.data && s.shadow[r.id]?.f === this.fp(r.kind, r.data)) continue;   // already have it (often our own push echoed back)
      let marks = touched.get(bookId);
      if (!marks) { marks = this.host.readMarks(bookId); touched.set(bookId, marks); }
      const list = listOf(marks, r.kind);
      if (r.deleted) {
        const idx = list.findIndex(m => this.idSync(r.kind, r.book, m.cfi) === r.id);
        if (idx >= 0) { list.splice(idx, 1); changed.add(bookId); }
        delete s.shadow[r.id];
        continue;
      }
      const cfi = r.data?.cfi;
      if (!r.data || typeof cfi !== 'string') continue;
      const idx = list.findIndex(m => m.cfi === cfi);
      if (idx >= 0) list[idx] = r.data; else list.push(r.data);
      changed.add(bookId);
      s.shadow[r.id] = { b: r.book, f: this.fp(r.kind, r.data) };
    }
    if (!changed.size) return;
    for (const bookId of changed) this.host.writeMarks(bookId, touched.get(bookId)!);
    this.host.onRemoteChange([...changed]);
  }

  /** Id of a note already hashed during collect() (every local note is). */
  private idSync(kind: SyncKind, book: string, cfi: string): string | undefined {
    return idCache.get(`${kind}|${book}|${cfi}`);
  }
}
