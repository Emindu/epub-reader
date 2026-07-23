# Read — Minimalist EPUB & Document Reader

**Read** is a modern, high-performance desktop application for reading e-books and documents. Built with **Tauri v2**, **TypeScript**, and **Rust**, it offers an offline-first, distraction-free reading experience with neural text-to-speech, built-in dictionary lookups, spaced-repetition vocabulary learning, bionic focus reading, and customizable typography.

---

## ✨ Features

### 📖 Multi-Format Document Reader
- **Supported Formats**: Full support for **EPUB**, **PDF**, **Plain Text (.txt)**, and **Markdown (.md)** files.
- **Reading Modes**: Switch between **Paginated**, **Two-Page Spread**, and **Continuous Scroll** layouts.
- **Table of Contents & Navigation**: Interactive chapter navigation tree, page estimation, progress percentages, and chapter time remaining.
- **Reflow & Window Management**: Automatic responsive reflow on window resize or minimization without breaking reading location.

### 🎧 Neural Text-To-Speech (TTS) & Audiobook Mode
- **Piper Neural TTS Integration**: Embedded Rust engine to download and execute offline high-quality neural voice models (ONNX models via Piper).
- **System Speech Engine**: Built-in fallback to native OS Web Speech API voices.
- **Audiobook Pre-Caching ("Batch Synthesis")**: Cache entire chapters into high-fidelity WAV files with sentence timestamp tracking for instant, seamless playback.
- **Playback Controls**: Adjustable speech rate (0.5x – 2.0x), natural pitch preservation option, sentence/word skipping, and automatic chapter progression.

### 🧠 Vocabulary Journal & Spaced Repetition (SRS)
- **Instant Dictionary Lookup**: Select any word to instantly view definitions, phonetics, and usage (via Free Dictionary API).
- **Contextual Flashcards**: Automatically saves the surrounding sentence context when adding words to your vocabulary list.
- **SM-2 Flashcard Review System**: Built-in spaced repetition algorithm to review saved words with "Again", "Good", and "Easy" ratings.
- **Daily Card Capping**: Intelligent daily limit (10 new cards/day) to prevent review pile overwhelm.

### ⚡ Bionic Focus & Speed Reading
- **RSVP Focus Mode**: Rapid Serial Visual Presentation mode with customizable WPM (120 – 800 WPM) for high-speed reading.
- **Focus Tracker**: Dynamic word or sentence highlight follow-along on hover.

### 🎨 Design & Typography Engine
- **Curated Themes**: 9 hand-crafted color palettes including *Default*, *Flexoki*, *Ayu*, *Catppuccin*, *Everforest*, *Gruvbox*, *Nord*, *Rosé Pine*, and *Solarized*.
- **Appearance Modes**: Dark Mode and Light Mode support with smooth transition effects.
- **Custom Fonts & Spacing**: Choose between Serif (*Newsreader*), Sans (*Inter*), and Monospace (*JetBrains Mono*) font families, with custom line heights, text scaling (70%–300%), and margin widths.

### 📌 Bookmarks, Highlights & Analytics
- **Multi-Color Highlights**: Yellow, Green, Blue, and Pink highlight annotations attached to book locations (EPUB CFI).
- **Bookmarks**: Quickly pin locations within any book or chapter.
- **Reading Statistics**: Streak tracking (consecutive days read) and total reading time log.
- **Local Library Storage**: Imported books are safely adopted into `AppData` for persistent offline reading.

---

## 🏗️ Architecture

Read uses a decoupled architecture separating the lightweight native OS shell (Rust/Tauri) from the web presentation and reader engines (TypeScript/HTML/CSS).

```
┌─────────────────────────────────────────────────────────────────┐
│                      Frontend UI (Webview)                      │
│                                                                 │
│  ┌───────────────────────┐ ┌─────────────────────────────────┐  │
│  │     Library View      │ │          Reader Screen          │  │
│  │ (Book Grid, Storage)  │ │ (Epub.js, PDF.js, Marked.js)    │  │
│  └───────────────────────┘ └─────────────────────────────────┘  │
│                                                                 │
│  ┌───────────────────────┐ ┌─────────────────────────────────┐  │
│  │   Vocabulary & SRS    │ │    Speed Reading & Focus      │  │
│  │     (SM-2 Engine)     │ │        (RSVP Engine)            │  │
│  └───────────────────────┘ └─────────────────────────────────┘  │
└────────────────────────────────┬────────────────────────────────┘
                                 │ Tauri IPC Commands / Events
┌────────────────────────────────┴────────────────────────────────┐
│                      Tauri Backend (Rust)                       │
│                                                                 │
│  ┌───────────────────────┐ ┌─────────────────────────────────┐  │
│  │ Native Filesystem     │ │  Piper Neural TTS Manager       │  │
│  │ (App Data Storage)    │ │  (Status, Download, Synthesize) │  │
│  └───────────────────────┘ └─────────────────────────────────┘  │
│                                                                 │
│  ┌───────────────────────┐ ┌─────────────────────────────────┐  │
│  │ Chapter Audio Cache   │ │  Binary / Voice Archiver        │  │
│  │ (WAV Concatenation)   │ │  (Curl + Tar Subprocesses)      │  │
│  └───────────────────────┘ └─────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Component Breakdown

1. **Backend Shell (Rust / Tauri v2)**:
   - Location: [`src-tauri/`](file:///d:/One%20Drive/OneDrive%20-%20D%20F%20N%20TECHNOLOGY%20%28PVT%29%20LTD/Documents/personal/epub-reader/src-tauri/)
   - **`lib.rs`**: Core Tauri commands for Piper TTS engine control (`piper_synthesize`, `piper_batch_synthesize`), model download manager (`piper_download_file`), voice catalogue indexing, and file unarchiving via system `curl` / `tar`.
   - **Tauri Plugins**: Uses `tauri-plugin-fs` for persistent app storage, `tauri-plugin-dialog` for native open dialogs, and `tauri-plugin-opener` for native folder navigation.

2. **Frontend Layer (TypeScript / Vite)**:
   - Location: [`src/`](file:///d:/One%20Drive/OneDrive%20-%20D%20F%20N%20TECHNOLOGY%20%28PVT%29%20LTD/Documents/personal/epub-reader/src/)
   - **`main.ts`**: Single-page application logic driving library management, reader engine lifecycle, theme management, dictionary popups, vocabulary flashcards, reading statistics, and speech controls.
   - **`styles.css`**: Design system tokens, glassmorphic dark/light UI themes, typography styling, custom scrollbars, and drawer transitions.
   - **`index.html`**: Semantic structure for Library and Reader screens, drawer panels, popovers, and dialogs.

3. **Core Rendering Engines**:
   - **EPUB**: Rendered via `epubjs` into an iframe sandbox with custom CSS overrides for theme synchronization.
   - **PDF**: Rendered via `pdfjs-dist` using web worker threads (`pdf.worker.min.mjs`).
   - **Markdown / Text**: Rendered natively via HTML DOM and compiled through `marked`.

---

## 🛠️ Development & Building

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://www.rust-lang.org/) (v1.75+)
- Windows, macOS, or Linux

### Setup
```bash
# Clone the repository
git clone https://github.com/Emindu/epub-reader.git
cd epub-reader

# Install dependencies
npm install

# Run application in development mode
npm run tauri dev
```

### Production Build
```bash
# Build the native application binary
npm run tauri build
```

---

## 📄 License

MIT
