# Read sync service

Stores each user's highlights and bookmarks so every device sees the same
notes. Runs on Cloud Run, keeps data in Firestore, and signs users in with
Firebase Auth.

```
GET  /health                      liveness probe
GET  /v1/sync?since=<cursor>       changes after the cursor  -> { items, cursor, more }
POST /v1/sync   { items: [...] }   upload changes            -> { cursor, results }
GET  /v1/items?book=<contentKey>   every live item for one book -> { items }
```

Every `/v1` request needs `Authorization: Bearer <Firebase ID token>`.

## How sync works

- An item is one highlight or bookmark: `{ id, kind, book, updatedAt, deleted?, data }`.
  `book` is the item's `contentKey` (same on every device), and `id` is
  `sha256(kind|book|cfi)`, so two devices name the same highlight the same way.
- Each accepted write gets the user's next sequence number, inside a
  Firestore transaction. Pulling `since` the last cursor returns every change
  exactly once, in order, 500 at a time (`more: true` means pull again).
- Conflicts are last write wins on `updatedAt`. A write that isn't strictly
  newer than the stored copy comes back `stale` with the stored copy, which
  the app adopts.
- Deletes are kept as markers (`deleted: true`) so they reach other devices.

Data layout: `users/{uid}` holds `{ seq }`, and `users/{uid}/items/{id}` holds the items.

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

To allow another web origin (e.g. a hosted copy of the web app), add
`--set-env-vars=ALLOWED_ORIGINS=https://read.example.com`.

## Cost

With `--min-instances=0`, Cloud Run scales to zero between syncs. A single
user's notes stay well inside the free tiers of Cloud Run and Firestore.
