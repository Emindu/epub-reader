# Building Read for iOS (Tauri v2) — spike

Needs a Mac with Xcode and an Apple Developer account. Not buildable on Windows.

```
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
npm install
node scripts/setup-voca.mjs
npm run tauri ios init      # generates src-tauri/gen/apple
npm run tauri ios dev       # simulator; add a device name to run on a phone
```

Set your team under Signing in the generated Xcode project (or `bundle > iOS > developmentTeam` in tauri.conf.json).

## What to measure in the spike
1. Does Tiny Voca start (Pyodide + ORT in WKWebView) and how long does it take?
2. Synthesis speed vs realtime on a real phone, and memory (Xcode memory gauge; the WebView is killed if too high).
3. Does audio continue when the screen locks? (Expected: no — needs a native audio-session plugin.)
4. EPUB import via the file picker, and storage under AppData.
5. Touch behavior of the reader and drawers.

## Known desktop-only parts
Piper and the local LLM use helper processes and are hidden/unusable on iOS.
