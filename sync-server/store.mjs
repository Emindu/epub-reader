// Storage for synced items. Two implementations with the same contract:
//
//   pull(uid, since, limit) -> { items, cursor, more }
//   push(uid, items)        -> { cursor, results: [{ id, status, item? }] }
//   forBook(uid, book)      -> live (not deleted) items for one book, for a device that just imported it
//
// Every accepted write gets the user's next sequence number, so a client that
// pulls `since` its last cursor sees each change exactly once, in order.
// Conflicts are last-write-wins on the client's `updatedAt`: an incoming item
// that isn't strictly newer than the stored one comes back as `stale` with the
// stored copy, which the client then adopts.

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
  constructor() { this.users = new Map(); }

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

  async push(uid, items) {
    const u = this.user(uid);
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
  constructor(db) { this.db = db; }

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

  async push(uid, items) {
    const userRef = this.userRef(uid);
    return this.db.runTransaction(async tx => {
      // Firestore transactions need every read before the first write.
      const userSnap = await tx.get(userRef);
      const refs = items.map(i => userRef.collection('items').doc(i.id));
      const snaps = refs.length ? await tx.getAll(...refs) : [];
      let seq = userSnap.exists ? userSnap.get('seq') || 0 : 0;
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
      tx.set(userRef, { seq, updatedAt: Date.now() }, { merge: true });
      return { cursor: seq, results };
    });
  }
}
