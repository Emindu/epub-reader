// Storage for synced items. Two implementations with the same contract:
//
//   pull(uid, since, limit) -> { items, cursor, more }
//   push(uid, items)        -> { cursor, results: [{ id, status, item? }] }
//   forBook(uid, book)      -> live (not deleted) items for one book, for a device that just imported it
//   listBooks(uid, limit)   -> live library entries (kind "book"), newest first, for the e-reader feed
//   setFeedToken(uid, hash, expiresAt) -> makes sha256(token) the user's e-reader feed link, replacing any earlier one
//   clearFeedToken(uid)     -> revokes the user's feed link
//   feedForToken(hash)      -> { uid, expiresAt } for a feed link, or null
//   feedForUser(uid)        -> { hash, expiresAt } for the user's current link, or null
//
// Every accepted write gets the user's next sequence number, so a client that
// pulls `since` its last cursor sees each change exactly once, in order.
// Conflicts are last-write-wins on the client's `updatedAt`: an incoming item
// that isn't strictly newer than the stored one comes back as `stale` with the
// stored copy, which the client then adopts.

/** A push that would take the user past their item limit. */
export class QuotaError extends Error {}

/** Change in the user's live item count if `incoming` replaces `stored`. */
function liveDelta(stored, incoming) {
  return (incoming.deleted ? 0 : 1) - (stored && !stored.deleted ? 1 : 0);
}

/** True when the incoming item should replace the stored one (strictly newer wins; ties keep the stored copy). */
function accept(stored, incoming) {
  return !stored || incoming.updatedAt > stored.updatedAt;
}

function toStored(item, seq) {
  return {
    id: item.id,
    kind: item.kind,
    book: item.book,
    key: item.key ?? '',
    updatedAt: item.updatedAt,
    deleted: item.deleted === true,
    data: item.deleted ? null : item.data ?? null,
    seq,
  };
}

export class MemoryStore {
  constructor({ maxItems = Infinity } = {}) { this.users = new Map(); this.feeds = new Map(); this.maxItems = maxItems; }

  user(uid) {
    let u = this.users.get(uid);
    if (!u) { u = { seq: 0, items: new Map() }; this.users.set(uid, u); }
    return u;
  }

  async pull(uid, since, limit) {
    const u = this.user(uid);
    const newer = [...u.items.values()].filter(i => i.seq > since).sort((a, b) => a.seq - b.seq);
    const items = newer.slice(0, limit);
    return { items, cursor: items.length ? items[items.length - 1].seq : since, more: newer.length > limit };
  }

  async forBook(uid, book, limit) {
    return [...this.user(uid).items.values()].filter(i => i.book === book && !i.deleted).slice(0, limit);
  }

  async listBooks(uid, limit) {
    return [...this.user(uid).items.values()].filter(i => i.kind === 'book' && !i.deleted)
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  async setFeedToken(uid, hash, expiresAt) {
    const u = this.user(uid);
    if (u.feed) this.feeds.delete(u.feed.hash);
    u.feed = { hash, expiresAt };
    this.feeds.set(hash, { uid, expiresAt });
  }

  async clearFeedToken(uid) {
    const u = this.user(uid);
    if (u.feed) this.feeds.delete(u.feed.hash);
    u.feed = null;
  }

  async feedForToken(hash) { return this.feeds.get(hash) ?? null; }
  async feedForUser(uid) { return this.user(uid).feed ?? null; }

  async push(uid, items) {
    const u = this.user(uid);
    let live = [...u.items.values()].filter(i => !i.deleted).length;
    for (const item of items) { const st = u.items.get(item.id); if (accept(st, item)) live += liveDelta(st, item); }
    if (live > this.maxItems) throw new QuotaError(`item limit reached (${this.maxItems})`);
    const results = [];
    for (const item of items) {
      const stored = u.items.get(item.id);
      if (accept(stored, item)) {
        u.items.set(item.id, toStored(item, ++u.seq));
        results.push({ id: item.id, status: 'ok' });
      } else {
        results.push({ id: item.id, status: 'stale', item: stored });
      }
    }
    return { cursor: u.seq, results };
  }
}

export class FirestoreStore {
  /** @param {import('firebase-admin/firestore').Firestore} db */
  constructor(db, { maxItems = Infinity } = {}) { this.db = db; this.maxItems = maxItems; }

  userRef(uid) { return this.db.collection('users').doc(uid); }

  async pull(uid, since, limit) {
    const snap = await this.userRef(uid).collection('items')
      .where('seq', '>', since).orderBy('seq').limit(limit + 1).get();
    const docs = snap.docs.map(d => d.data());
    const items = docs.slice(0, limit);
    return { items, cursor: items.length ? items[items.length - 1].seq : since, more: docs.length > limit };
  }

  async forBook(uid, book, limit) {
    // Equality on one field uses Firestore's automatic index; deleted markers are dropped here.
    const snap = await this.userRef(uid).collection('items').where('book', '==', book).limit(limit).get();
    return snap.docs.map(d => d.data()).filter(i => !i.deleted);
  }

  async listBooks(uid, limit) {
    // One equality filter (automatic index); deleted markers and the order are handled here.
    const snap = await this.userRef(uid).collection('items').where('kind', '==', 'book').get();
    return snap.docs.map(d => d.data()).filter(i => !i.deleted)
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  /** Feed links: feedTokens/{sha256(token)} -> { uid, expiresAt }; the user doc remembers the current one. */
  async setFeedToken(uid, hash, expiresAt) {
    const userRef = this.userRef(uid);
    const old = (await userRef.get()).get('feedHash');
    const batch = this.db.batch();
    if (old) batch.delete(this.db.collection('feedTokens').doc(old));
    batch.set(this.db.collection('feedTokens').doc(hash), { uid, expiresAt, createdAt: Date.now() });
    batch.set(userRef, { feedHash: hash, feedExpiresAt: expiresAt }, { merge: true });
    await batch.commit();
  }

  async clearFeedToken(uid) {
    const userRef = this.userRef(uid);
    const old = (await userRef.get()).get('feedHash');
    const batch = this.db.batch();
    if (old) batch.delete(this.db.collection('feedTokens').doc(old));
    batch.set(userRef, { feedHash: null, feedExpiresAt: null }, { merge: true });
    await batch.commit();
  }

  async feedForToken(hash) {
    const snap = await this.db.collection('feedTokens').doc(hash).get();
    return snap.exists && snap.get('uid') ? { uid: snap.get('uid'), expiresAt: snap.get('expiresAt') || 0 } : null;
  }

  async feedForUser(uid) {
    const snap = await this.userRef(uid).get();
    const hash = snap.get('feedHash');
    return hash ? { hash, expiresAt: snap.get('feedExpiresAt') || 0 } : null;
  }

  async push(uid, items) {
    const userRef = this.userRef(uid);
    return this.db.runTransaction(async tx => {
      // Firestore transactions need every read before the first write.
      const userSnap = await tx.get(userRef);
      const refs = items.map(i => userRef.collection('items').doc(i.id));
      const snaps = refs.length ? await tx.getAll(...refs) : [];
      let seq = userSnap.exists ? userSnap.get('seq') || 0 : 0;
      // Live items are counted from here on (accounts older than the count start at 0).
      let live = userSnap.exists ? userSnap.get('live') || 0 : 0;
      items.forEach((item, n) => {
        const stored = snaps[n].exists ? snaps[n].data() : null;
        if (accept(stored, item)) live += liveDelta(stored, item);
      });
      if (live > this.maxItems) throw new QuotaError(`item limit reached (${this.maxItems})`);
      const results = [];
      items.forEach((item, n) => {
        const stored = snaps[n].exists ? snaps[n].data() : null;
        if (accept(stored, item)) {
          tx.set(refs[n], toStored(item, ++seq));
          results.push({ id: item.id, status: 'ok' });
        } else {
          results.push({ id: item.id, status: 'stale', item: stored });
        }
      });
      tx.set(userRef, { seq, live: Math.max(0, live), updatedAt: Date.now() }, { merge: true });
      return { cursor: seq, results };
    });
  }
}
