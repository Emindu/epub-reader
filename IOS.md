# Read on iPhone

Read runs on iOS as a Tauri v2 app: a small native shell (Rust + Swift from Tauri) around the same web UI as desktop, with an iPhone-specific layout (`src/mobile.css`).

## ⚠️ After 7 days: reinstall

The app is signed with a **free Apple ID** ("Personal Team"). Apple only lets such installs run for **7 days**. After that, iOS refuses to open it ("Read is no longer available").

**Your data is kept** as long as you reinstall over the existing app. **Do not delete Read from the phone** — deleting it erases your library, highlights, vocabulary and progress.

To reinstall (≈5 minutes with the build cache, 15–20 without):

1. Plug the iPhone into the Mac with a cable and **unlock it**.
2. From the `epub-reader/` folder run:

   ```bash
   npm run tauri ios build -- --export-method debugging
   xcrun devicectl device install app --device 00008101-000554D01E12001E src-tauri/gen/apple/build/arm64/Read.ipa
   ```

3. Open Read. That's it — the 7-day clock restarts.

If the install fails with a signing error, open **Xcode → Settings → Accounts**, select your Apple ID and make sure you're still signed in, then retry.

**To stop reinstalling weekly:** join the Apple Developer Program ($99/year; installs then last a year and TestFlight can update over the air), or use SideStore/AltStore, which re-sign free installs automatically.

## One-time setup (a new Mac)

- Full **Xcode** (App Store), opened once; `sudo xcodebuild -license accept`
- `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`
- `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`
- `rustup component add llvm-tools` — needed by swift-rs ≥ 1.0.9 on Xcode 27 (otherwise the link fails with undefined `_register_plugin` etc.)
- `brew install cocoapods`
- `npm install && node scripts/setup-voca.mjs`
- Xcode → Settings → Accounts → add your Apple ID; the team ID goes in `src-tauri/tauri.conf.json` (`bundle.iOS.developmentTeam`, currently `HJ985CJ366`)
- On the iPhone: Settings → Privacy & Security → **Developer Mode** on; after the first install, Settings → General → VPN & Device Management → trust your Apple ID.

## Project specifics

- **iOS-only config:** `src-tauri/tauri.ios.conf.json` — bundle id `com.emindu.read` (`com.read.app` is taken on Apple's side, and is also the desktop data-folder name, so don't change it globally), minimum iOS 15.
- **`src-tauri/Info.ios.plist`** (merged into the generated `Info.plist` at build time — note that removing a key here does *not* remove it from `gen/apple/tauri-app_iOS/Info.plist`):
  - `UIApplicationSceneManifest` — iOS 27 refuses to launch apps without the UIScene lifecycle.
  - `UIBackgroundModes: audio` — read-aloud keeps playing with the screen locked.
  - `CFBundleDocumentTypes` — Read appears in the share sheet for EPUB/PDF/TXT/Markdown ("Open in Read").
- **Patched `tao` in `src-tauri/vendor/tao`** (`[patch.crates-io]` in `Cargo.toml`): stock tao 0.35.3 hands UIKit a freed `UISceneConfiguration` once the scene manifest is present, crashing at launch. Remove the patch once an upstream tao fixes it.
- **`src-tauri/gen/apple/project.yml`** was hand-edited to link `Accelerate.framework` (llama.cpp) and `AVFAudio.framework`. Re-running `tauri ios init` regenerates it — re-add both and run `xcodegen generate` in `gen/apple`.
- Desktop-only pieces have iOS replacements: Piper runs as WASM (`src/piper-wasm.ts`), llama.cpp is linked in (`src-tauri/src/llm_embedded.rs`), HTTP uses `ureq` instead of `curl`.

## Testing in the simulator (optional, ~11 GB)

```bash
xcodebuild -downloadPlatform iOS        # 8 GB runtime; stop it after the first runtime installs
xcrun simctl create "Read iPhone 13" com.apple.CoreSimulator.SimDeviceType.iPhone-13 com.apple.CoreSimulator.SimRuntime.iOS-27-2
npm run tauri ios build -- --target aarch64-sim --debug
xcrun simctl install booted src-tauri/gen/apple/build/arm64-sim/Read.app && xcrun simctl launch booted com.emindu.read
```

Debug builds are inspectable: `ios_webkit_debug_proxy` (Homebrew) exposes the webview so JS can be evaluated from the Mac; `idb` (facebook/fb tap) drives taps, swipes and screenshots.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| App won't open after a week | 7-day free signing expired — reinstall (above). |
| Crash right at launch | Check the crash: `xcrun devicectl device info files --device <UDID> --domain-type systemCrashLogs`. A crash in `_connectUISceneFromFBSScene` means the tao patch isn't being used. |
| `No space left on device` during build | Clear `src-tauri/target/aarch64-apple-ios-sim` and `src-tauri/target/debug` (regenerable). |
| Build fails with Swift/`MacOSX.sdk` errors | swift-rs must be ≥ 1.0.9 (`cargo update -p swift-rs`). |
| Install says device locked | Unlock the phone and retry. |
| `CodeSign failed` with `errSecInternalComponent` (everything else compiled) | `codesign` can't read the signing key from the login keychain. In Terminal run `security unlock-keychain ~/Library/Keychains/login.keychain-db` and `security set-key-partition-list -S apple-tool:,apple:,codesign: -s ~/Library/Keychains/login.keychain-db` (both ask for your Mac password), then rebuild in that same Terminal. A background or agent shell (e.g. Claude Code) can't unlock the keychain, so run the iOS build in your own Terminal. |
