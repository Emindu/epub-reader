# Smart Dictionary — AI "Explain in Context" Architecture

Technical documentation for the local‑LLM word‑meaning feature added to **Read**.

When a reader looks up a word, the app shows the usual dictionary/Wikipedia
definition **and**, if a local model is installed, offers an **"Explain in
context"** button. Clicking it runs a small instruction‑tuned LLM entirely on
the user's machine to explain what the word means *as it is used in that
sentence* — disambiguating senses, handling idioms and technical terms, and
working even when the device is fully offline.

- **Frontend:** TypeScript / Vite single‑page app (`src/main.ts`)
- **Backend:** Rust, Tauri v2 (`src-tauri/src/lib.rs`)
- **Inference:** bundled `llama-cli` (llama.cpp) subprocess + a GGUF model
- **Model (reference):** Qwen2.5‑1.5B‑Instruct, Q4_K_M (~1.1 GB), ChatML template

---

## 1. Component overview

```mermaid
flowchart TB
    subgraph UI["Frontend — src/main.ts (WebView)"]
        LOOKUP["lookupWord()<br/>dictionary + Wikipedia lookup"]
        PREP["prepareAiExplain(word)<br/>offer button if model ready"]
        BTN["'Explain in context' button"]
        RUN["runAiExplain()<br/>invoke + render answer"]
        STATUS["refreshLlmStatus() / isLlmReady()"]
    end

    subgraph CORE["Backend — src-tauri/src/lib.rs (Rust)"]
        CMD_STATUS["#quot;llm_status#quot; command<br/>scan install dir for binary + models"]
        CMD_EXPLAIN["#quot;llm_explain#quot; command<br/>build prompt, spawn, clean output"]
        CLEAN["clean_llm_output()<br/>slice reply out of CLI chrome"]
    end

    subgraph FS["Install dir — %APPDATA%/com.read.app/llm/"]
        BIN["llama-cli.exe (+ DLLs)"]
        MODELS["models/*.gguf"]
    end

    PROC["llama-cli subprocess<br/>(llama.cpp inference on CPU)"]

    STATUS -- "invoke" --> CMD_STATUS
    CMD_STATUS -- "reads" --> FS
    CMD_STATUS -- "LlmStatus" --> STATUS

    LOOKUP --> PREP --> BTN
    BTN -- "click" --> RUN
    RUN -- "invoke('llm_explain')" --> CMD_EXPLAIN
    CMD_EXPLAIN -- "spawn_blocking" --> PROC
    PROC -- "loads" --> BIN
    PROC -- "loads" --> MODELS
    PROC -- "stdout" --> CLEAN
    CLEAN -- "cleaned answer" --> CMD_EXPLAIN
    CMD_EXPLAIN -- "Result<String>" --> RUN
```

The design deliberately mirrors the app's existing **Piper TTS** integration:
same install root under `app_data_dir()`, same `spawn_blocking` +
`CREATE_NO_WINDOW` subprocess pattern, same status‑scan approach.

---

## 2. End‑to‑end request flow

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant UI as Frontend (main.ts)
    participant IPC as Tauri IPC
    participant RS as Rust (lib.rs)
    participant CLI as llama-cli subprocess

    Note over UI: On boot: refreshLlmStatus() → isLlmReady()

    User->>UI: Select / double-tap a word
    UI->>UI: lookupWord() — dictionary + Wikipedia
    UI->>UI: prepareAiExplain(word)<br/>stash word + sentence context
    alt model installed (isLlmReady)
        UI-->>User: Show "Explain in context" button
    else no model
        UI-->>User: Button stays hidden
    end

    User->>UI: Click "Explain in context"
    UI->>UI: runAiExplain() — show "Thinking…", spinner
    UI->>IPC: invoke('llm_explain', {word, sentence, modelPath})
    IPC->>RS: llm_explain(...)
    RS->>RS: validate binary + model exist
    RS->>RS: flatten sentence, build single-line prompt
    RS->>CLI: spawn_blocking: llama-cli -m … -st --jinja …
    CLI->>CLI: apply chat template, run inference (CPU)
    CLI-->>RS: stdout (banner + echo + reply + footer)
    RS->>RS: clean_llm_output(raw, prompt)
    RS-->>IPC: Ok(cleaned answer)
    IPC-->>UI: string
    UI->>UI: dictAiOutput.textContent = answer (XSS-safe)
    UI-->>User: Show explanation, hide button
```

Two properties fall out of this flow:

- **Stale‑response guard.** `runAiExplain()` captures the `word` at click time
  and, when the answer arrives, only renders it if `aiExplainWord === word`. If
  the reader moved on to another word (or closed the popover, which calls
  `resetAiExplain()`), the late answer is dropped.
- **Non‑blocking UI.** A 1–2 B model on CPU takes a few seconds. The Rust
  command is `async` and does the actual work inside
  `tauri::async_runtime::spawn_blocking`, so the WebView thread never stalls.

---

## 3. Model / binary discovery (`llm_status`)

`llm_status` is what makes the feature *conditional* — the UI only ever offers
the button when this scan confirms a working install.

```mermaid
flowchart TD
    START["llm_status(app)"] --> ROOT["root = app_data_dir()/llm"]
    ROOT --> MK["create llm/ and llm/models/ if missing"]
    MK --> BIN{"llama-cli(.exe)<br/>exists in root?"}
    BIN -->|yes| BE["binary_exists = true"]
    BIN -->|no| BN["binary_exists = false"]
    BE --> SCAN["read models/ dir"]
    BN --> SCAN
    SCAN --> LOOP{"for each *.gguf"}
    LOOP -->|match| PUSH["push LlmModel{path, name, size_bytes}"]
    PUSH --> LOOP
    LOOP -->|done| SORT["sort models by name"]
    SORT --> RET["return LlmStatus"]

    RET --> READY{"binary_exists<br/>&& models.length > 0 ?"}
    READY -->|yes| ON["isLlmReady() = true → button offered"]
    READY -->|no| OFF["isLlmReady() = false → button hidden"]
```

`LlmStatus` shape (serialized to the frontend):

| Field           | Type          | Meaning                                        |
| --------------- | ------------- | ---------------------------------------------- |
| `binary_exists` | `bool`        | `llama-cli(.exe)` present in the install root  |
| `binary_path`   | `string`      | Absolute path to the binary                    |
| `models_dir`    | `string`      | Absolute path to `llm/models/`                 |
| `models`        | `LlmModel[]`  | One entry per `.gguf` found                    |

`LlmModel` = `{ path, name, size_bytes }`. `path` is passed back **verbatim** as
`modelPath` on the next `llm_explain` call — the frontend never constructs
paths itself. Currently `runAiExplain()` uses `models[0]` (first model,
alphabetically).

---

## 4. Prompt construction & output cleaning

The subtlest part of the pipeline. This llama.cpp build prints a startup
**banner**, **echoes the prompt** (prefixed `> `), then the reply, then a stats
**footer** (`[ Prompt: … ]`) and `Exiting…` — all on **stdout**, even with
`--no-display-prompt`. So the raw stdout is *not* just the answer.

```mermaid
flowchart LR
    subgraph INPUT["Prompt build (Rust)"]
        S["sentence"] --> FLAT["flatten:<br/>trim + split_whitespace + join(' ')"]
        FLAT --> HASSENT{"sentence empty?"}
        HASSENT -->|no| PCTX["'In the sentence below, explain<br/>what #quot;WORD#quot; means … Sentence: FLAT'"]
        HASSENT -->|yes| PWORD["'Explain the word or phrase<br/>#quot;WORD#quot; concisely …'"]
    end

    PCTX --> ARGS
    PWORD --> ARGS

    subgraph ARGS["llama-cli invocation"]
        FLAGS["-m model -st --jinja --simple-io<br/>--no-display-prompt -p PROMPT<br/>-n 32..512 -c 4096 --temp 0.2<br/>stdin=null, CREATE_NO_WINDOW"]
    end

    ARGS --> RAW["raw stdout:<br/>banner + '#gt; PROMPT' + REPLY + '[ Prompt: … ]' + Exiting"]

    subgraph CLEANING["clean_llm_output(raw, prompt)"]
        RAW --> C1["1. slice AFTER last echo of exact prompt<br/>(fallback: last interactive '#gt; ' marker)"]
        C1 --> C2["2. truncate at first chrome/template marker:<br/>'[ Prompt:', 'Exiting', '[end of text]',<br/>im_end, eot_id, #lt;/s#gt;, end_of_turn"]
        C2 --> C3["3. trim + strip leading '>' glyph"]
    end

    C3 --> OUT["cleaned answer"]
```

Why slice on the echoed prompt rather than blocklist banner lines? **We know the
exact prompt string we sent**, so the reply is reliably the text *after* the
last echo of that prompt and *before* the `[ Prompt:` footer. That boundary
survives banner/format changes across llama.cpp builds far better than trying to
enumerate banner lines. The prompt is kept to a **single line** (sentence
whitespace collapsed) precisely so the CLI echoes it verbatim and the slice is
exact.

Key invocation flags:

| Flag                  | Purpose                                                        |
| --------------------- | ------------------------------------------------------------- |
| `-st` / `--single-turn` | One user turn, then exit — no interactive loop               |
| `--jinja`             | Apply the model's **embedded** chat template (ChatML for Qwen)|
| `--simple-io`         | Plain IO for subprocesses — no ANSI/cursor escape codes       |
| `--no-display-prompt` | Ask the CLI not to echo (honored by *some* builds)            |
| `-n 200` (32–512)     | Max predicted tokens; clamped from `max_tokens`               |
| `-c 4096`             | Context window                                                |
| `--temp 0.2`          | Low temperature — factual, low‑variance explanations          |
| `stdin = null`        | A build that ignores `-st` gets EOF and exits, never hangs    |

`clean_llm_output` is locked in by **3 unit tests** in `lib.rs`
(`extracts_reply_between_prompt_echo_and_footer`,
`strips_template_tokens_when_prompt_absent`,
`falls_back_to_interactive_marker`).

---

## 5. Frontend button state machine

```mermaid
stateDiagram-v2
    [*] --> Hidden

    Hidden --> Offered: prepareAiExplain()<br/>[isLlmReady && word]
    Hidden --> Hidden: prepareAiExplain()<br/>[no model / no word]

    Offered --> Busy: click → runAiExplain()<br/>disable, spinner, "Thinking…"
    Busy --> Answered: invoke resolves<br/>[word still current]<br/>render answer, hide button
    Busy --> Error: invoke rejects<br/>show error text
    Busy --> Hidden: word changed / popover closed<br/>(stale response dropped)

    Answered --> Hidden: hideDictPopover() → resetAiExplain()
    Error --> Hidden: hideDictPopover() → resetAiExplain()
    Offered --> Hidden: hideDictPopover() → resetAiExplain()
```

The answer is written with `el.dictAiOutput.textContent = answer` — never
`innerHTML` — so model output can never inject markup into the page. The button
hides itself after answering because a second click would just regenerate the
same explanation.

---

## 6. Install layout

```
%APPDATA%/com.read.app/llm/          ← llm_root(app)
├── llama-cli.exe                     ← llm_binary(root)  (Windows)
├── *.dll                             ← llama.cpp runtime DLLs
└── models/
    └── qwen2.5-1.5b-instruct-q4_k_m.gguf
```

- **App identifier:** `com.read.app` (productName "Read")
- `app_data_dir()` resolves to `%APPDATA%/com.read.app/` on Windows.
- The binary is bundled/installed alongside the model; the model file(s) live in
  `models/`. Any `.gguf` dropped there is auto‑discovered on the next
  `llm_status` scan.

---

## 7. Design notes & known limitations

- **Fully offline.** Once the binary + model are installed, the feature needs no
  network. It is the *only* dictionary path that still works with no connection —
  hence `prepareAiExplain()` is called even on the offline/"no result" branch of
  `lookupWord()`.
- **Cold‑load per call.** Each `llm_explain` spawns a fresh `llama-cli` process
  that loads the ~1 GB model from disk before generating. First‑token latency is
  dominated by this load. A persistent `llama-server` would amortize it — the
  natural next step past prototype.
- **No streaming yet.** The command returns the whole answer at once; the UI
  shows a static "Thinking…" until it resolves. Token streaming over Tauri
  events is a planned enhancement.
- **Model‑quality ceiling.** A 1.5 B model occasionally paraphrases rather than
  truly explains (e.g. it disambiguated "bank → river's edge" well, but
  paraphrased a harder example). This is a model‑size trade‑off, not a pipeline
  bug; a larger GGUF can be dropped into `models/` without code changes.

---

## 8. Extending the pipeline

Because discovery is directory‑based and inference is a plain subprocess, the
feature extends without frontend churn:

- **Swap/add models** → drop a `.gguf` into `llm/models/`; it appears on the next
  `llm_status`. (Add UI model‑selection to move past `models[0]`.)
- **New AI actions** (summarize passage, simplify sentence, translate) → add a
  sibling Rust command that reuses the same prompt‑build + `clean_llm_output`
  path with a different instruction template.
- **Ask‑the‑Book (RAG)** → the same `llama-cli` install serves as the generation
  backend; add an embedding + retrieval layer over the EPUB text.
