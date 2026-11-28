# Read sync service

Stores each user's library (entries and book files), highlights, bookmarks,
vocabulary cards, reading progress and reading journal so every device sees the
same library and notes. Book files live in a private Cloud Storage bucket; the
service hands out 15-minute signed URLs to upload or download one file. Runs on Cloud Run, keeps data in Firestore, and signs users in with
Firebase Auth.

```
GET  /health                      liveness probe
GET  /v1/sync?since=<cursor>       changes after the cursor  -> { items, cursor, more }
POST /v1/sync   { items: [...] }   upload changes            -> { cursor, results }
GET  /v1/items?book=<contentKey>   every live item for one book -> { items }
POST /v1/feed                      new e-reader password       -> { token, user, path, expiresAt }
GET  /v1/feed                      is one active?              -> { active, expiresAt }
POST /v1/feed/revoke               stop the current one        -> { active: false }
GET  /opds/                        the library as an OPDS catalogue (KOReader), HTTP Basic auth
```

Every `/v1` request needs `Authorization: Bearer <Firebase ID token>`.

## How sync works

- An item is `{ id, kind, book, key, updatedAt, deleted?, data }`. Kinds: `highlight`,
  `bookmark`, `vocab`, `progress`, `journal` (one per day per device), `reflection`, `readtext` (the exact text read, in chunks).
  `book` is the item's `contentKey` (same on every device), or `*` for journal
  items; `key` names the item within it (cfi, word, day…); and `id` is
  `sha256(kind|book|key)`, so two devices name the same note the same way.
- Each accepted write gets the user's next sequence number, inside a
  Firestore transaction. Pulling `since` the last cursor returns every change
  exactly once, in order, 500 at a time (`more: true` means pull again).
- Conflicts are last write wins on `updatedAt`. A write that isn't strictly
  newer than the stored copy comes back `stale` with the stored copy, which
  the app adopts.
- Deletes are kept as markers (`deleted: true`) so they reach other devices.

Data layout: `users/{uid}` holds `{ seq }`, and `users/{uid}/items/{id}` holds the items.
Book files: `gs://<project>-books/users/{uid}/books/{sha256(contentKey)}` (env `BOOKS_BUCKET`).
A `book` item (`book: '*'`, `key: contentKey`) is a library entry; pushing its delete
removes the book on every device and deletes the stored file.

## E-reader (OPDS) feed

KOReader and other e-readers can browse the synced library over Wi-Fi. They cannot sign in to
Firebase, so they use HTTP Basic auth with an **e-reader password**: Settings → Sync → "Create
e-reader password" calls `POST /v1/feed`, which returns it once.

- 32 random bytes; only the SHA-256 is stored (`feedTokens/{hash}` in Firestore) with an expiry
  (`OPDS_LINK_DAYS`, default 90). Creating a new one replaces the old; `POST /v1/feed/revoke` removes it.
- It travels in the `Authorization` header, not the URL, so it stays out of request logs. The user
  name is ignored. (`OPDS_ALLOW_URL_TOKEN=1` also accepts `/opds/<token>/` for a reader that can't
  send Basic auth; off by default because the secret would then be in URLs and logs.)
- Every bad credential gets the same 401. After 10 failures in 10 minutes an address gets 429, and
  300 failures a minute across all addresses pauses the feed for a minute (the address is the last
  `X-Forwarded-For` entry, which Cloud Run sets).
- The catalogue (`opds.mjs`) lists `book` items whose file is in the bucket. A download is streamed
  through the service with a real file name (`Content-Disposition`), never redirected, so the
  e-reader's credentials are not forwarded to another host.
- A password gives read access to book files and covers only: no notes, journal or progress, no writes.
- In KOReader: search icon → OPDS catalog → + → name, URL, user name, password.

## Run locally

```bash
npm install
npm test        # end-to-end tests against an in-memory store
npm run dev     # :8080, in-memory store; use "Bearer dev:<any-uid>" as the token
```

`SYNC_STORE=memory` accepts fake tokens and loses data on restart. Never set it on Cloud Run.

## Deploy to Cloud Run (one-time setup)

1. Install the gcloud CLI and sign in: `gcloud auth login`.
2. Create a project and turn on billing, or pick an existing one:
   ```bash
   gcloud config set project YOUR_PROJECT_ID
   gcloud services enable run.googleapis.com firestore.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
   ```
3. Create the Firestore database (Native mode; pick a region near you):
   ```bash
   gcloud firestore databases create --location=asia-south1
   ```
4. In the Firebase console (console.firebase.google.com), **Add project** → choose the same
   GCP project. Then **Authentication → Sign-in method → Email/Password → Enable**.
   Under **Project settings → General**, note the **Web API key**: the apps need it.
5. Lock Firestore to the service: in **Firestore → Rules**, paste `firestore.rules` and publish.
6. Deploy from this folder (Cloud Build builds it, no Dockerfile needed):
   ```bash
   gcloud run deploy read-sync --source . --region=asia-south1 \
     --allow-unauthenticated --min-instances=0 --max-instances=3 --memory=256Mi
   ```
   `--allow-unauthenticated` only means Cloud Run lets requests reach the
   service; the service itself rejects anything without a valid Firebase token.
   The default compute service account already has Firestore access in the same project.
7. Check it: `curl https://<service-url>/health` should print `{"ok":true}`.
8. Book files (library sync):
   ```bash
   gcloud services enable storage.googleapis.com iamcredentials.googleapis.com
   gcloud storage buckets create gs://YOUR_PROJECT_ID-books --location=asia-south1 \
     --uniform-bucket-level-access --public-access-prevention
   gcloud storage buckets update gs://YOUR_PROJECT_ID-books --cors-file=cors.json   # app origins, GET/PUT/HEAD
   SA=PROJECT_NUMBER-compute@developer.gserviceaccount.com
   gcloud storage buckets add-iam-policy-binding gs://YOUR_PROJECT_ID-books --member=serviceAccount:$SA --role=roles/storage.objectAdmin
   # lets the service sign URLs with its own identity (no key file)
   gcloud iam service-accounts add-iam-policy-binding $SA --member=serviceAccount:$SA --role=roles/iam.serviceAccountTokenCreator
   gcloud run services update read-sync --region=asia-south1 --update-env-vars=BOOKS_BUCKET=YOUR_PROJECT_ID-books
   ```

To allow another web origin (e.g. a hosted copy of the web app), add
`--set-env-vars=ALLOWED_ORIGINS=https://read.example.com`.

## Access control

- New sign-ups are turned off in Firebase (`client.permissions.disabledUserSignup`), so only
  existing accounts can sign in. To add a person, create their account in the Firebase
  console (Authentication → Users → Add user) or turn sign-up back on.
- `ALLOWED_UIDS` (Cloud Run env) lists the accounts allowed to sync; anyone else gets 403
  even with a valid token. Empty means any signed-in account.
- Per-account caps: `MAX_USER_BYTES` (book storage, default 5 GiB) and `MAX_USER_ITEMS`
  (live items, default 200,000); over a cap the service answers 413.
- The Firebase Web API key is restricted to `identitytoolkit` and `securetoken` (sign-in
  and token refresh), the only Google APIs the apps call with it.
- A billing budget ("Read sync monthly", US$5) emails at 50/90/100 %.

## Cost

With `--min-instances=0`, Cloud Run scales to zero between syncs. A single
user's notes stay well inside the free tiers of Cloud Run and Firestore.
