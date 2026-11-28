# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Read" — an offline-first EPUB/PDF/TXT/Markdown reader with neural TTS, a local LLM dictionary/chat, SM-2 vocabulary review, RSS news, and web-article import. Two apps share one codebase lineage:

- **Desktop (root)** — Tauri v2: TypeScript/Vite frontend in `src/` + Rust backend in `src-tauri/`.
- **Web (`web/`)** — a separate browser/PWA port with its own `package.json`, `node_modules`, and build. It is *not* imported by the desktop app.

## Commands

Desktop (run from repo root):
```bash
npm install
node scripts/setup-voca.mjs   # fetch Tiny Voca TTS assets into public/voca/ (git-ignored, ~55 MB); needed for that engine
npm run tauri dev             # Vite on fixed port 1520 (HMR 1521) + Rust app
npm run tauri build           # production bundle
npm run build                 # frontend only: tsc type-check + vite build -> dist/
npx tsc --noEmit              # type-check only
cargo check --manifest-path src-tauri/Cargo.toml   # Rust check
```
iOS (needs full Xcode; Xcode 27 also needs `rustup component add llvm-tools` for swift-rs ≥1.0.9 to un-hide Tauri's Swift symbols):
```bash
npm run tauri ios build -- --export-method debugging      # -> src-tauri/gen/apple/build/arm64/Read.ipa
xcrun devicectl device install app --device <UDID> src-tauri/gen/apple/build/arm64/Read.ipa
```
iOS-only config lives in `src-tauri/tauri.ios.conf.json` (bundle id `com.emindu.read` — `com.read.app` is taken on Apple's side and is also the desktop AppData folder name, so don't change it globally; min iOS 15). `src-tauri/gen/apple/project.yml` was hand-edited to link Accelerate.framework (llama.cpp vDSP) and AVFAudio.framework; re-running `tauri ios init` regenerates it and drops those — re-add them and run `xcodegen generate`. Full iPhone guide (setup, weekly reinstall, troubleshooting) is in `IOS.md`; it also covers the patched `tao` in `src-tauri/vendor/tao`, which iOS needs.

Web (run from `web/`):
```bash
npm run dev        # http://localhost:5173
npm run typecheck
npm run build && npm start   # serves dist/ + /api/article on :8080 (PORT env to change)
```

There are no frontend tests and no linter; `tsc` (strict, `noUnusedLocals`/`noUnusedParameters`) is the main correctness gate. The only tests are Rust unit tests at the bottom of `lib.rs` (llama-cli output parsing):
```bash
cargo test --manifest-path src-tauri/Cargo.toml                       # all
cargo test --manifest-path src-tauri/Cargo.toml falls_back_to_interactive_marker   # one test
# real-model test of the linked-in llama.cpp (needs a .gguf, e.g. Qwen2.5 0.5B Instruct)
READ_TEST_GGUF=/path/model.gguf cargo test --manifest-path src-tauri/Cargo.toml --features embedded-llm -- --ignored --nocapture
```
Release builds are slow (tens of minutes cold) partly because Tauri brotli-compresses all of `dist/` — including ~100 MB of `public/voca/` TTS assets — into the binary.

## Architecture

### Desktop frontend (`src/`)
- `src/main.ts` (~11.7k lines) is the entire SPA: no framework, plain DOM. It is organized into banner-comment sections (`/* ===... Section name */`) — Storage, Screen routing, Theme/Settings, Library, Importing, Save Article, News, Opening a book, TOC drawer, Highlights, Vocabulary + SRS, Focus mode, Page navigation, Read-aloud (TTS), Minimal layout, Boot. Grep for the section banner to navigate.
- The markup (library, reader, drawers, popovers, dialogs) lives in the root `index.html` (~80 KB); `main.ts` looks up elements by id. UI changes usually touch both `index.html` and `src/styles.css`.
- Persisted state (settings, library metadata, stats, vocab, etc.) goes to `localStorage` via the helpers in the Storage section (`persistSettings`, debounced `persistLibrarySoon`, ...). In the Tauri apps every `read.*` entry is also mirrored to its own file under AppData/state/ (`src/durable.ts`): `src/boot.ts` is the entry point and restores localStorage from those files before `main.ts` loads whenever they are newer (WebKit reset or rolled back its storage); caches (`read.locations.*`, news items) are not mirrored. Covers are stored one per key (`read.cover.<id>`, written only when they change) and stripped from `read.library` by `saveLibraryRecords()`: keeping them inline made every progress save rewrite ~0.5 MB and grew WebKit's localStorage WAL to ~1 GB on an iPhone. Book bytes are copied into AppData through `@tauri-apps/plugin-fs`.
- Rendering engines: `epubjs` (iframe; theme CSS is injected into the rendition), `pdfjs-dist` (worker), `marked` for Markdown/TXT, and Readability → DOMPurify → Turndown for web articles, which then flow through the Markdown pipeline.
- Smaller modules: `codeblocks.ts` (highlight.js code blocks), `news.ts` (feed definitions + RSS/Atom parsing), `voca.ts` + `voca.worker.ts` (Tiny Voca TTS: Pyodide + onnxruntime-web in a worker, assets served from `public/voca/`), `sinhala.ts` (Sinhala text → phoneme tokens; the model's symbol table is read at runtime from `public/voca/model-si/meta.json`, sourced from `Sinhala/tiny-voca-si.txt`), `piper-wasm.ts` + `piper-wasm.worker.ts` (Piper for iOS, see below).
- **`sinhala.ts` is a line-for-line port of the Python front end the model was trained with — do not "improve" its rules; any change garbles the voice.**

### iOS vs desktop
iOS can't spawn helper processes, so every subprocess-based feature has an in-process path. `IS_IOS` in `main.ts` switches the frontend:
- **Piper**: `synthPiper()` → `piper_synthesize` (desktop) or the WASM worker (iOS; voice "path" is the voice id, no natural-rate since length can't change). iOS chapter caching is built in JS with the same AppData file layout `piper_cache_lookup` reads.
- **Local LLM**: `cfg(embedded_llm)` (set in `build.rs`: always on iOS, or `--features embedded-llm`) links llama.cpp via `llama-cpp-2` + Metal (`src-tauri/src/llm_embedded.rs`) instead of running `llama-cli`. `llm_status` then reports `embedded: true` and the UI hides the binary install step. The cached model must be freed on exit (`llm_embedded::unload`, called from the `RunEvent::Exit` handler) or ggml's Metal teardown aborts.
- **HTTP** (articles, feeds, downloads) uses `ureq` in Rust on all platforms — no `curl`.
- `host_arch` gives the real CPU arch; WebKit's UA says "Intel" on Apple Silicon.

### Phone layout
`main.ts` sets `html[data-device="phone"]` (`IS_PHONE`: coarse pointer, screen < 600pt). `src/mobile.css` holds the whole iPhone redesign, every rule scoped to that attribute: bottom tab bar, reader tool bar, drawers/popovers/modals as bottom sheets. The phone-only elements in `index.html` (`m-*` classes/ids) and `wirePhone()` in `main.ts` only forward to the existing desktop buttons, so behaviour stays in one place. Touch paging and chrome toggling are in `onReaderTap()`.

### Desktop backend (`src-tauri/src/lib.rs`)
All Tauri commands live in this one file and are called from `main.ts` via `invoke('<name>', {...})` (camelCase args on the JS side):
- Piper TTS: `piper_status`, `piper_synthesize`, `piper_batch_synthesize` / `piper_batch_progress` (chapter WAV cache), `piper_cache_lookup`, `piper_cache_delete_book`, downloads (ureq) and archive extraction (system `tar`).
- Local LLM: `llm_status`, `llm_explain`, `llm_word_examples`, `llm_chat_reply`, plus model download/extract. All three generation commands go through `complete()`, which uses the embedded engine or runs `llama-cli` and parses its output (`clean_llm_output`). See `docs/ai-smart-dictionary-architecture.md`.
- Network fetches that need to bypass CORS: `fetch_url_html` (article import), `fetch_feed_xml` (news).

When adding a command: define it in `lib.rs`, register it in the `invoke_handler`, and add any new plugin permissions to `src-tauri/capabilities/default.json`.

### Web port (`web/`)
`web/src/main.ts` is a port of the desktop `main.ts`; native pieces are replaced by `web/src/platform/` (IndexedDB storage, file picker, Piper in a Web Worker via ONNX WASM, WebLLM/OpenAI-compatible LLM, article client). `web/server/article-proxy.mjs` is the SSRF-guarded article fetcher shared by the Vite dev middleware and the production `server.mjs`. `web/src/codeblocks.ts`, `web/src/contentKey.ts` and `web/src/sync.ts` are currently identical copies of their `src/` counterparts. Features added to desktop are ported manually — check whether a change should be mirrored.

### Sync service (`sync-server/`)
A small Node service for Cloud Run that syncs the library (entries + book files in Cloud Storage via signed URLs), highlights, bookmarks, vocab, reading progress and the journal across devices (Firestore + Firebase Auth); separate `package.json`, no build step. Items are matched across devices by `contentKey` (`src/contentKey.ts`). `npm test` runs end-to-end tests against an in-memory store, including `client.test.mjs`, which drives the app's real `src/sync.ts` as two devices (Node runs the .ts directly, so keep `sync.ts` free of non-erasable TypeScript such as enums and constructor parameter properties); `npm run dev` serves on :8080 accepting `Bearer dev:<uid>` tokens. Deploy steps are in `sync-server/README.md`.

The client side is `src/sync.ts` (copied unchanged to `web/src/sync.ts`): Firebase Auth email/password over REST, and a sync that diffs local items against a last-synced shadow in `localStorage`. The app side is the Sync section of `main.ts`: `syncItems()` lists everything that syncs and `applySyncChanges()` stores what arrives; the `save()` helper schedules a sync for `read.marks.*`/`read.vocab.*` (4 s) and `read.library`/`read.journal` (30 s). Library entries are `book` items: one arriving from another device creates a `cloudOnly` record whose file downloads on first open (`downloadCloudBook`, hash-checked), and removing a book removes it on every device (its notes stay in the cloud for a re-import). Journal days sync per device (`read.journal.remote` holds other devices' days) and `journalView()` adds them up for display, so reading time from two devices is never overwritten. The "Text you read" log syncs the same way, per device/day/book in ≤40k-char chunks (`readtext` items; other devices' chunks in `read.journal.text.remote`, merged by `readTextView()`), pruned after 45 days everywhere. The same service serves an OPDS catalogue of the synced library for KOReader (`sync-server/opds.mjs`; Settings → Sync → "Create e-reader link" mints an e-reader password for HTTP Basic auth against `/opds/`; it expires, can be revoked, and failed attempts are throttled). The service URL and Firebase Web API key come from `.env` (`VITE_SYNC_URL`, `VITE_FIREBASE_API_KEY`; public values); without them the Settings → Sync section is hidden.

### Other
- `new wanted design/` and `frontend-for-redesign.zip` are design references for a planned redesign, not built code.
- `src-tauri/2` is a stray file (npm output), not source.
