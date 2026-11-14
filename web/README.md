# Read — web app

The browser version of Read. It has the same reader, library, typography,
focus mode, dictionary, vocabulary/SRS, reading stats, neural TTS and local AI
as the desktop app, and runs in any modern browser — including as an installed
(PWA) app.

## Run it

```bash
cd web
npm install
npm run dev          # development server on http://localhost:5173
```

Production:

```bash
npm run build        # type-checks and writes dist/
npm start            # serves dist/ on http://localhost:8080 (PORT to change)
```

`npm start` needs only Node 18+ (no extra dependencies). The server also hosts
the **Save article** importer, which can't run from a plain static host.

## What's different from the desktop app

| Feature | Desktop (Tauri) | Web |
|---|---|---|
| Book storage | App data folder | IndexedDB in the browser (persistent-storage requested) |
| Import | Native file dialog | Browser file picker |
| Save article | Rust `curl` fetch | `/api/article` on the Read server (SSRF-guarded) |
| Neural TTS (Piper) | Piper binary + voices | Piper in a Web Worker (ONNX Runtime WASM, served locally) |
| Chapter audio cache | WAV files on disk | WAV + timing metadata in IndexedDB |
| Speed change with Piper | Natural (re-synthesised) or fast | Fast only — the browser port can't change synthesis length; `preservesPitch` keeps the voice natural |
| Local AI | llama.cpp subprocess + GGUF | **In this browser** (WebLLM on WebGPU, Qwen2.5 1.5B/0.5B/3B) **or** your own OpenAI-compatible server (llama-server, Ollama, LM Studio) |
| Open data folder | Yes | Not applicable |

### Local AI notes

- **In this browser** needs a WebGPU-capable browser (current Chrome or Edge).
  Models download once (roughly 350 MB – 1.8 GB) and are cached by the browser.
- **My own server** needs the server to allow cross-origin requests from this
  page. llama.cpp's `llama-server` does this by default; Ollama needs
  `OLLAMA_ORIGINS` set to include this page's origin.

## Layout

```
web/
  index.html            app shell + modals
  src/
    main.ts             reader UI and logic (ported from the desktop app)
    platform/           browser implementations of the native-only pieces
      storage.ts        IndexedDB key/value store for book bytes and audio
      files.ts          file picker, clipboard, external links
      article.ts        client for the article importer endpoint
      piper.ts          Piper client, WAV helpers, chapter cache
      piper.worker.ts   Piper synthesis off the main thread
      llm.ts            WebLLM + OpenAI-compatible completions
      prompts.ts        explain / examples / chat prompts (same as desktop)
  server/
    article-proxy.mjs   article fetcher with SSRF guards (shared by dev + prod)
    server.mjs          production static server + article endpoint
  public/
    ort/                ONNX Runtime WASM (served locally)
    piper/              Piper phonemizer WASM + data (served locally)
```

## Security notes

- The article endpoint refuses private, loopback and link-local addresses on
  every redirect hop, accepts only http/https on ports 80/443, caps responses
  at 20 MB, and requires a custom request header that cross-origin pages can't
  send without a CORS preflight that this server never grants.
- The DNS check and the fetch are separate lookups, so a hostile DNS server
  could in principle rebind between them. For a publicly exposed deployment,
  run the server behind an egress firewall that blocks private ranges.
