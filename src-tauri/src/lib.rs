use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// Where we look for the piper install:
///   <APPDATA>/com.read.app/piper/
///     piper.exe            (or `piper` on unix)
///     voices/
///       en_US-lessac-medium.onnx
///       en_US-lessac-medium.onnx.json
///
/// The user is expected to download the binary and one or more voices from
/// https://github.com/rhasspy/piper/releases and https://huggingface.co/rhasspy/piper-voices
/// respectively and drop them into this folder. We don't bundle them because
/// (a) the binary + a single voice is ~100MB, and (b) voice choice is deeply
/// personal — we don't want to pick for them.
fn piper_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(base.join("piper"))
}

fn piper_binary(root: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    let name = "piper.exe";
    #[cfg(not(target_os = "windows"))]
    let name = "piper";
    root.join(name)
}

/// Metadata surfaced to the UI for a single installed voice.
#[derive(Serialize)]
pub struct PiperVoice {
    /// Absolute path to the .onnx model — passed back verbatim to `piper_synthesize`.
    path: String,
    /// User-facing label ("en_US-lessac-medium").
    name: String,
    /// Language code ("en_US") when the sidecar .onnx.json is present, else empty.
    lang: String,
    /// Audio sample rate from the model config, needed to build a correct WAV header.
    sample_rate: u32,
}

#[derive(Serialize)]
pub struct PiperStatus {
    binary_exists: bool,
    binary_path: String,
    voices_dir: String,
    voices: Vec<PiperVoice>,
}

/// Minimal shape we care about inside a piper voice's `<voice>.onnx.json`.
#[derive(Deserialize)]
struct VoiceConfig {
    audio: Option<AudioConfig>,
    language: Option<LanguageConfig>,
}

#[derive(Deserialize)]
struct AudioConfig {
    sample_rate: Option<u32>,
}

#[derive(Deserialize)]
struct LanguageConfig {
    code: Option<String>,
}

#[tauri::command]
fn piper_status(app: tauri::AppHandle) -> Result<PiperStatus, String> {
    let root = piper_root(&app)?;
    // Make sure the folders exist so "Open voices folder" from the UI actually
    // has something to open on a fresh install.
    let voices_dir = root.join("voices");
    if !root.exists() {
        fs::create_dir_all(&root).map_err(|e| format!("mkdir piper root: {e}"))?;
    }
    if !voices_dir.exists() {
        fs::create_dir_all(&voices_dir).map_err(|e| format!("mkdir voices: {e}"))?;
    }

    let binary_path = piper_binary(&root);
    let binary_exists = binary_path.exists();

    let mut voices: Vec<PiperVoice> = Vec::new();
    if let Ok(read) = fs::read_dir(&voices_dir) {
        for entry in read.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("onnx") {
                continue;
            }
            let name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();

            // Companion <voice>.onnx.json holds sample rate + language.
            let cfg_path = path.with_extension("onnx.json");
            let (lang, sample_rate) = match fs::read_to_string(&cfg_path) {
                Ok(s) => match serde_json::from_str::<VoiceConfig>(&s) {
                    Ok(cfg) => (
                        cfg.language.and_then(|l| l.code).unwrap_or_default(),
                        cfg.audio.and_then(|a| a.sample_rate).unwrap_or(22050),
                    ),
                    Err(_) => (String::new(), 22050),
                },
                Err(_) => (String::new(), 22050),
            };

            voices.push(PiperVoice {
                path: path.to_string_lossy().into_owned(),
                name,
                lang,
                sample_rate,
            });
        }
    }
    voices.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(PiperStatus {
        binary_exists,
        binary_path: binary_path.to_string_lossy().into_owned(),
        voices_dir: voices_dir.to_string_lossy().into_owned(),
        voices,
    })
}

/// Synthesize `text` with the given voice model. Returns the full WAV bytes
/// (raw PCM from piper wrapped in a WAV header) which the frontend plays via
/// `HTMLAudioElement`.
///
/// We use `--output-raw` and wrap the header ourselves instead of `--output_file`
/// so there's no disk I/O between synthesis and playback.
/// Async so per-chunk synthesis (~1-2s of piper CPU) doesn't stutter the UI
/// during read-aloud.
#[tauri::command]
async fn piper_synthesize(
    app: tauri::AppHandle,
    text: String,
    voice_path: String,
    length_scale: Option<f32>,
) -> Result<Vec<u8>, String> {
    let root = piper_root(&app)?;
    let binary = piper_binary(&root);
    if !binary.exists() {
        return Err(format!(
            "piper binary not found at {}",
            binary.to_string_lossy()
        ));
    }
    let voice = PathBuf::from(&voice_path);
    if !voice.exists() {
        return Err(format!("voice model not found at {voice_path}"));
    }

    // Look up the sample rate from the voice config; piper's --output-raw
    // hands us naked PCM with no header, so we need to know the rate to
    // build a playable WAV.
    let cfg_path = voice.with_extension("onnx.json");
    let sample_rate: u32 = fs::read_to_string(&cfg_path)
        .ok()
        .and_then(|s| serde_json::from_str::<VoiceConfig>(&s).ok())
        .and_then(|c| c.audio.and_then(|a| a.sample_rate))
        .unwrap_or(22050);

    let root_for_task = root.clone();
    let binary_for_task = binary.clone();
    let voice_for_task = voice.clone();

    let pcm = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let mut cmd = Command::new(&binary_for_task);
        cmd.arg("--model")
            .arg(&voice_for_task)
            .arg("--output-raw")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if let Some(scale) = length_scale {
            let clamped = scale.clamp(0.5, 2.0);
            cmd.arg("--length-scale").arg(format!("{clamped}"));
        }

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        // Piper resolves espeak-ng data relative to the working dir, so run
        // from the piper install root — otherwise phoneme lookups fail
        // silently on fresh installs.
        cmd.current_dir(&root_for_task);

        let mut child = cmd.spawn().map_err(|e| format!("spawn piper: {e}"))?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(text.as_bytes())
                .map_err(|e| format!("write stdin: {e}"))?;
        }

        let mut pcm: Vec<u8> = Vec::new();
        if let Some(mut stdout) = child.stdout.take() {
            stdout
                .read_to_end(&mut pcm)
                .map_err(|e| format!("read stdout: {e}"))?;
        }

        let status = child.wait().map_err(|e| format!("wait piper: {e}"))?;
        if !status.success() {
            let mut stderr_buf = String::new();
            if let Some(mut stderr) = child.stderr.take() {
                let _ = stderr.read_to_string(&mut stderr_buf);
            }
            return Err(format!(
                "piper exited with status {:?}: {stderr_buf}",
                status.code()
            ));
        }

        if pcm.is_empty() {
            return Err("piper produced no audio (stderr was empty too)".into());
        }

        Ok(pcm)
    })
    .await
    .map_err(|e| format!("task join: {e}"))??;

    Ok(wrap_wav(&pcm, sample_rate))
}

/// Download `url` to `<piper_root>/<rel_path>` via the system `curl`.
///
/// **Async on purpose:** the curl subprocess can run for 10–30 seconds on
/// a 30 MB download, and Tauri sync commands (`fn`) run on the main
/// thread — which would freeze the whole window ("Not Responding" in Task
/// Manager). We wrap the blocking subprocess work in `spawn_blocking` so
/// the async runtime can keep servicing other commands (in particular the
/// `piper_file_size` progress poll) while curl runs.
///
/// curl handles the GitHub → S3 redirect chain transparently, doesn't care
/// about CORS, and ships with Windows 10 1803+ / macOS / Linux.
#[tauri::command]
async fn piper_download_file(
    app: tauri::AppHandle,
    url: String,
    rel_path: String,
) -> Result<u64, String> {
    let root = piper_root(&app)?;
    let dest = root.join(&rel_path);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    if dest.exists() {
        let _ = fs::remove_file(&dest);
    }

    let dest_for_task = dest.clone();
    let output = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new("curl");
        cmd.arg("-L")                    // follow redirects (GitHub → S3)
            .arg("--fail")               // exit non-zero on HTTP errors
            .arg("--silent")             // don't clutter stderr with progress
            .arg("--show-error")         // ...but do print the error itself
            .arg("--connect-timeout").arg("30")
            .arg("--retry").arg("2")
            .arg("--output").arg(&dest_for_task)
            .arg(&url);

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        cmd.output()
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
    .map_err(|e| format!("failed to spawn curl (is it installed?): {e}"))?;

    if !output.status.success() {
        // Drop any partial file so a retry starts clean.
        let _ = fs::remove_file(&dest);
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(format!(
            "curl exit {}: {}",
            output.status.code().unwrap_or(-1),
            if stderr.trim().is_empty() { "no output" } else { stderr.trim() }
        ));
    }

    let size = fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    if size == 0 {
        let _ = fs::remove_file(&dest);
        return Err("download produced an empty file".into());
    }
    Ok(size)
}

/// Report the size of a file inside the piper root — used by the JS side
/// to poll progress while a `piper_download_file` command is in flight.
#[tauri::command]
fn piper_file_size(app: tauri::AppHandle, rel_path: String) -> Result<u64, String> {
    let root = piper_root(&app)?;
    let path = root.join(&rel_path);
    if !path.exists() {
        return Ok(0);
    }
    fs::metadata(&path)
        .map(|m| m.len())
        .map_err(|e| format!("stat: {e}"))
}

/// -----------------------------------------------------------------------
/// Chapter cache ("audiobook mode")
///
/// A cached chapter is a single WAV file on disk containing the concatenated
/// synthesis of every sentence in the chapter, plus a sidecar JSON with the
/// per-sentence start times (in seconds). Once cached, TTS playback loads
/// the WAV and plays through — no synth latency, no chunk seams.
///
/// Cache path scheme:
///   <piper_root>/cache/<book_id>/<section_key>_<voice_id>.wav
///   <piper_root>/cache/<book_id>/<section_key>_<voice_id>.json
///
/// section_key is a caller-provided token (sanitized href), voice_id is the
/// voice model's basename. Both are unstable-looking strings but we don't
/// need collision-proof — the JS side owns key generation.
/// -----------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
pub struct CachedChapter {
    /// Path relative to <piper_root>/cache/ — JS reads via the fs plugin.
    rel_path: String,
    /// Cumulative start time (seconds) of each sentence in the WAV.
    sentence_starts: Vec<f32>,
    /// Total duration of the WAV in seconds. Useful for early bailout / UI.
    total_duration: f32,
    /// Sample rate the voice was rendered at (needed by JS for computing
    /// timings from byte offsets, though it also lives in the WAV header).
    sample_rate: u32,
}

fn cache_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = piper_root(app)?;
    Ok(root.join("cache"))
}

fn cache_wav_path(
    app: &tauri::AppHandle,
    book_id: &str,
    section_key: &str,
    voice_id: &str,
) -> Result<PathBuf, String> {
    Ok(cache_root(app)?
        .join(book_id)
        .join(format!("{}_{}.wav", section_key, voice_id)))
}

fn cache_meta_path(
    app: &tauri::AppHandle,
    book_id: &str,
    section_key: &str,
    voice_id: &str,
) -> Result<PathBuf, String> {
    Ok(cache_root(app)?
        .join(book_id)
        .join(format!("{}_{}.json", section_key, voice_id)))
}

/// Synthesize an ordered list of sentences into a single WAV on disk.
/// Async + spawn_blocking because a chapter can be dozens of sentences =
/// tens of seconds of piper CPU; we don't want the UI to freeze.
///
/// Returns the cache descriptor the JS side can pass to piper_cache_lookup
/// on the next open — but callers should read the WAV bytes via the fs
/// plugin (BaseDirectory.AppData + rel_path prefixed with "piper/cache/").
#[tauri::command]
async fn piper_batch_synthesize(
    app: tauri::AppHandle,
    book_id: String,
    section_key: String,
    voice_path: String,
    sentences: Vec<String>,
    length_scale: Option<f32>,
) -> Result<CachedChapter, String> {
    let root = piper_root(&app)?;
    let binary = piper_binary(&root);
    if !binary.exists() {
        return Err(format!(
            "piper binary not found at {}",
            binary.to_string_lossy()
        ));
    }
    let voice = PathBuf::from(&voice_path);
    if !voice.exists() {
        return Err(format!("voice model not found at {voice_path}"));
    }

    let voice_id = voice
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("voice")
        .to_string();

    let cfg_path = voice.with_extension("onnx.json");
    let sample_rate: u32 = fs::read_to_string(&cfg_path)
        .ok()
        .and_then(|s| serde_json::from_str::<VoiceConfig>(&s).ok())
        .and_then(|c| c.audio.and_then(|a| a.sample_rate))
        .unwrap_or(22050);

    let wav_path = cache_wav_path(&app, &book_id, &section_key, &voice_id)?;
    let meta_path = cache_meta_path(&app, &book_id, &section_key, &voice_id)?;

    if let Some(parent) = wav_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir cache: {e}"))?;
    }

    let root_for_task = root.clone();
    let binary_for_task = binary.clone();
    let voice_for_task = voice.clone();
    let sentences_for_task = sentences.clone();

    let (all_pcm, sentence_starts, total_duration) =
        tauri::async_runtime::spawn_blocking(move || -> Result<(Vec<u8>, Vec<f32>, f32), String> {
            let mut all_pcm: Vec<u8> = Vec::new();
            let mut sentence_starts: Vec<f32> = Vec::new();
            let bytes_per_sec = (sample_rate * 2) as f32; // mono, 16-bit

            for (i, text) in sentences_for_task.iter().enumerate() {
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    continue;
                }

                let start_time = all_pcm.len() as f32 / bytes_per_sec;
                sentence_starts.push(start_time);

                let mut cmd = Command::new(&binary_for_task);
                cmd.arg("--model")
                    .arg(&voice_for_task)
                    .arg("--output-raw")
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());

                if let Some(scale) = length_scale {
                    let clamped = scale.clamp(0.5, 2.0);
                    cmd.arg("--length-scale").arg(format!("{clamped}"));
                }

                #[cfg(target_os = "windows")]
                {
                    use std::os::windows::process::CommandExt;
                    cmd.creation_flags(0x08000000);
                }

                cmd.current_dir(&root_for_task);

                let mut child = cmd
                    .spawn()
                    .map_err(|e| format!("spawn piper (sentence {i}): {e}"))?;

                if let Some(mut stdin) = child.stdin.take() {
                    stdin
                        .write_all(text.as_bytes())
                        .map_err(|e| format!("write stdin (sentence {i}): {e}"))?;
                }

                let mut pcm: Vec<u8> = Vec::new();
                if let Some(mut stdout) = child.stdout.take() {
                    stdout
                        .read_to_end(&mut pcm)
                        .map_err(|e| format!("read stdout (sentence {i}): {e}"))?;
                }

                let status = child.wait().map_err(|e| format!("wait piper (sentence {i}): {e}"))?;
                if !status.success() {
                    let mut stderr_buf = String::new();
                    if let Some(mut stderr) = child.stderr.take() {
                        let _ = stderr.read_to_string(&mut stderr_buf);
                    }
                    return Err(format!("piper exit on sentence {i}: {stderr_buf}"));
                }

                all_pcm.extend_from_slice(&pcm);
            }

            let total_duration = all_pcm.len() as f32 / bytes_per_sec;
            Ok((all_pcm, sentence_starts, total_duration))
        })
        .await
        .map_err(|e| format!("task join: {e}"))??;

    if all_pcm.is_empty() {
        return Err("no audio synthesized (all sentences empty?)".into());
    }

    let wav = wrap_wav(&all_pcm, sample_rate);
    fs::write(&wav_path, &wav).map_err(|e| format!("write cached wav: {e}"))?;

    // Path relative to cache root — that's what the JS side needs to feed
    // to fs plugin as `piper/cache/<rel_path>`.
    let cache = cache_root(&app)?;
    let rel_path = wav_path
        .strip_prefix(&cache)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| wav_path.to_string_lossy().into_owned());

    let desc = CachedChapter {
        rel_path,
        sentence_starts: sentence_starts.clone(),
        total_duration,
        sample_rate,
    };

    let meta_json = serde_json::json!({
        "voice": voice_id,
        "section": section_key,
        "sentence_starts": sentence_starts,
        "total_duration": total_duration,
        "sample_rate": sample_rate,
    });
    fs::write(&meta_path, meta_json.to_string())
        .map_err(|e| format!("write cached meta: {e}"))?;

    Ok(desc)
}

/// Fast-path lookup — returns Some if there's a cached WAV + meta on disk
/// for this book+section+voice combo. JS calls this on TTS start to decide
/// between cached and pipelined playback.
#[tauri::command]
fn piper_cache_lookup(
    app: tauri::AppHandle,
    book_id: String,
    section_key: String,
    voice_id: String,
) -> Result<Option<CachedChapter>, String> {
    let wav_path = cache_wav_path(&app, &book_id, &section_key, &voice_id)?;
    let meta_path = cache_meta_path(&app, &book_id, &section_key, &voice_id)?;
    if !wav_path.exists() || !meta_path.exists() {
        return Ok(None);
    }

    let meta_str = fs::read_to_string(&meta_path).map_err(|e| format!("read cached meta: {e}"))?;
    let json: serde_json::Value =
        serde_json::from_str(&meta_str).map_err(|e| format!("parse cached meta: {e}"))?;

    let cache = cache_root(&app)?;
    let rel_path = wav_path
        .strip_prefix(&cache)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| wav_path.to_string_lossy().into_owned());

    Ok(Some(CachedChapter {
        rel_path,
        sentence_starts: json["sentence_starts"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_f64().map(|f| f as f32)).collect())
            .unwrap_or_default(),
        total_duration: json["total_duration"].as_f64().map(|f| f as f32).unwrap_or(0.0),
        sample_rate: json["sample_rate"].as_u64().map(|u| u as u32).unwrap_or(22050),
    }))
}

/// Delete every cached chapter for a book (called when the book is removed
/// from the library so we don't leak megabytes for books the user threw out).
#[tauri::command]
fn piper_cache_delete_book(app: tauri::AppHandle, book_id: String) -> Result<(), String> {
    let cache = cache_root(&app)?;
    let book_dir = cache.join(&book_id);
    if book_dir.exists() {
        fs::remove_dir_all(&book_dir).map_err(|e| format!("delete cache: {e}"))?;
    }
    Ok(())
}

/// Extract a downloaded archive that lives inside the piper root.
///
/// We use the system `tar` binary (bsdtar on Windows 10+ / macOS / Linux)
/// so we don't have to pull the ~1MB `zip` crate into the bundle. Works on
/// both `.zip` and `.tar.gz`.
///
/// The Piper release archive nests everything inside a top-level `piper/`
/// directory. We detect that and hoist the contents up so the binary lands
/// at `<piper_root>/piper.exe` where the synth command looks for it.
/// Async so tar's extraction (~1-2s on the piper zip) doesn't block the
/// main thread the same way curl would.
#[tauri::command]
async fn piper_extract_downloaded_archive(
    app: tauri::AppHandle,
    archive_name: String,
) -> Result<(), String> {
    let root = piper_root(&app)?;
    let archive = root.join(&archive_name);
    if !archive.exists() {
        return Err(format!("archive not found: {}", archive.to_string_lossy()));
    }

    let root_for_task = root.clone();
    let archive_for_task = archive.clone();
    let output = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new("tar");
        cmd.arg("-xf").arg(&archive_for_task).arg("-C").arg(&root_for_task);

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        cmd.output()
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
    .map_err(|e| format!("failed to run tar: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "tar exit {}: {}",
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    // Piper's release zip contains a top-level `piper/` directory. Hoist
    // its contents up one level and remove the empty directory.
    let inner = root.join("piper");
    if inner.exists() && inner.is_dir() {
        if let Ok(entries) = fs::read_dir(&inner) {
            for entry in entries.flatten() {
                let src = entry.path();
                let dst = root.join(entry.file_name());
                // fs::rename fails across drives; on same-drive-in-appdata
                // it's cheap. If a same-name file already exists (re-install),
                // remove it first so rename doesn't error on Windows.
                if dst.exists() {
                    if dst.is_dir() {
                        let _ = fs::remove_dir_all(&dst);
                    } else {
                        let _ = fs::remove_file(&dst);
                    }
                }
                fs::rename(&src, &dst)
                    .map_err(|e| format!("hoist {}: {e}", entry.file_name().to_string_lossy()))?;
            }
        }
        let _ = fs::remove_dir(&inner);
    }

    // Delete the archive itself — we don't need it once extracted.
    let _ = fs::remove_file(&archive);
    Ok(())
}

/// -----------------------------------------------------------------------
/// Local LLM (llama.cpp) — powers the "smart dictionary" and future
/// text-understanding features (summaries, explain-this-passage, etc.)
///
/// Layout mirrors the piper install so the setup story is identical:
///   <APPDATA>/com.read.app/llm/
///     llama-cli.exe        (or `llama-cli` on unix)
///     models/
///       qwen2.5-1.5b-instruct-q4_k_m.gguf
///
/// The user downloads a llama.cpp release binary from
///   https://github.com/ggml-org/llama.cpp/releases
/// and a small instruct GGUF (Qwen2.5-1.5B-Instruct is a good default) from
/// Hugging Face, then drops both into this folder. Same reasoning as piper for
/// not bundling: the binary + a usable model is 1-2 GB, and the size/quality
/// tradeoff is a choice we don't want to make on the user's behalf.
/// -----------------------------------------------------------------------

fn llm_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(base.join("llm"))
}

fn llm_binary(root: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    let name = "llama-cli.exe";
    #[cfg(not(target_os = "windows"))]
    let name = "llama-cli";
    root.join(name)
}

/// Metadata surfaced to the UI for a single installed GGUF model.
#[derive(Serialize)]
pub struct LlmModel {
    /// Absolute path to the .gguf — passed back verbatim to `llm_explain`.
    path: String,
    /// User-facing label (the file stem).
    name: String,
    /// On-disk size, so the UI can show "1.1 GB" next to the model name.
    size_bytes: u64,
}

#[derive(Serialize)]
pub struct LlmStatus {
    binary_exists: bool,
    binary_path: String,
    models_dir: String,
    models: Vec<LlmModel>,
}

#[tauri::command]
fn llm_status(app: tauri::AppHandle) -> Result<LlmStatus, String> {
    let root = llm_root(&app)?;
    let models_dir = root.join("models");
    // Create the folders on first look so "Open models folder" from the UI
    // has somewhere to open on a fresh install — same as piper_status.
    if !root.exists() {
        fs::create_dir_all(&root).map_err(|e| format!("mkdir llm root: {e}"))?;
    }
    if !models_dir.exists() {
        fs::create_dir_all(&models_dir).map_err(|e| format!("mkdir models: {e}"))?;
    }

    let binary_path = llm_binary(&root);
    let binary_exists = binary_path.exists();

    let mut models: Vec<LlmModel> = Vec::new();
    if let Ok(read) = fs::read_dir(&models_dir) {
        for entry in read.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("gguf") {
                continue;
            }
            let name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            let size_bytes = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            models.push(LlmModel {
                path: path.to_string_lossy().into_owned(),
                name,
                size_bytes,
            });
        }
    }
    models.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(LlmStatus {
        binary_exists,
        binary_path: binary_path.to_string_lossy().into_owned(),
        models_dir: models_dir.to_string_lossy().into_owned(),
        models,
    })
}

/// Extract just the model's answer from llama-cli's stdout.
///
/// In single-turn conversation mode the CLI prints a startup banner, echoes
/// the user turn (prefixed with `> `), then the generated reply, then a stats
/// footer (`[ Prompt: … ]`) and `Exiting…`. Since we know the exact `prompt`
/// we sent, the reply is reliably the text *after* the last echo of that
/// prompt and *before* the footer — that boundary survives banner changes
/// across llama.cpp builds far better than trying to blocklist banner lines.
fn clean_llm_output(raw: &str, prompt: &str) -> String {
    // 1. Drop everything up to and including the echoed prompt, if present.
    //    Fall back to the last interactive `> ` marker, then to the raw text.
    let after_prompt = raw
        .rfind(prompt)
        .map(|i| &raw[i + prompt.len()..])
        .or_else(|| {
            // Fallback: no verbatim prompt match. The interactive echo is a
            // single line beginning with "\n> "; the reply starts on the next
            // line, so skip past the newline that ends the echoed prompt line.
            raw.rfind("\n> ").map(|i| {
                let rest = &raw[i + 3..];
                rest.find('\n').map_or(rest, |nl| &rest[nl + 1..])
            })
        })
        .unwrap_or(raw);

    // 2. Cut the trailing interactive chrome and any stray template tokens.
    let mut out = after_prompt.to_string();
    for marker in [
        "[ Prompt:", "\nExiting", "Exiting...", "[end of text]",
        "<|im_end|>", "<|eot_id|>", "</s>", "<end_of_turn>",
    ] {
        if let Some(idx) = out.find(marker) {
            out.truncate(idx);
        }
    }

    // 3. Strip a leading prompt glyph / whitespace the CLI may leave behind.
    out.trim().trim_start_matches('>').trim().to_string()
}

/// Ask the local model to explain `word` *as it is used in* `sentence`.
///
/// This is the backing command for the smart dictionary: unlike the Free
/// Dictionary API, it disambiguates the sense in context and can handle
/// idioms, phrases, and technical terms the dictionary can't.
///
/// Async + spawn_blocking for the same reason as piper: a 1-2B model on CPU
/// takes a few seconds to answer, and we can't block the UI thread that long.
///
/// We drive `llama-cli` in single-turn mode with `--jinja` so the model's own
/// chat template (baked into the GGUF) is applied — that keeps instruct models
/// behaving correctly without us hardcoding a per-model prompt format. stdin is
/// wired to /dev/null so a build that doesn't understand `-st` gets EOF and
/// exits rather than hanging forever waiting for interactive input.
#[tauri::command]
async fn llm_explain(
    app: tauri::AppHandle,
    word: String,
    sentence: String,
    model_path: String,
    max_tokens: Option<u32>,
) -> Result<String, String> {
    let root = llm_root(&app)?;
    let binary = llm_binary(&root);
    if !binary.exists() {
        return Err(format!(
            "llama-cli not found at {}",
            binary.to_string_lossy()
        ));
    }
    let model = PathBuf::from(&model_path);
    if !model.exists() {
        return Err(format!("model not found at {model_path}"));
    }

    let word = word.trim().to_string();
    if word.is_empty() {
        return Err("no word/phrase to explain".into());
    }
    let n_predict = max_tokens.unwrap_or(200).clamp(32, 512);

    // Fold instruction + context into one user turn; `--jinja` wraps it in the
    // model's chat template.
    // Kept to a single line (no embedded newlines): the CLI echoes the prompt
    // verbatim and clean_llm_output slices on that echo, which is most reliable
    // when the prompt is one line. We collapse any newlines in the sentence too.
    let sentence_flat = sentence.trim().split_whitespace().collect::<Vec<_>>().join(" ");
    let prompt = if sentence_flat.is_empty() {
        format!(
            "Explain the word or phrase '{word}' concisely for a reader. Give its meaning in \
1-2 plain sentences, then one short example of use. Do not repeat this instruction."
        )
    } else {
        format!(
            "In the sentence below, explain what '{word}' means as it is used here. Give the \
specific sense in 1-2 plain sentences. If it is an idiom, figure of speech, or technical term, \
say so and give the plain meaning. Be concise and do not repeat the sentence back. \
Sentence: {sentence_flat}"
        )
    };

    let binary_for_task = binary.clone();
    let model_for_task = model.clone();
    let root_for_task = root.clone();
    let prompt_for_task = prompt.clone(); // keep `prompt` for clean_llm_output below

    let raw = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let mut cmd = Command::new(&binary_for_task);
        cmd.arg("-m").arg(&model_for_task)
            .arg("-st") // single user turn, then exit (no interactive loop)
            .arg("--jinja") // apply the model's embedded chat template
            .arg("--simple-io") // plain IO for subprocesses: no ANSI/cursor codes
            .arg("--no-display-prompt")
            .arg("-p").arg(&prompt_for_task)
            .arg("-n").arg(n_predict.to_string())
            .arg("-c").arg("4096")
            .arg("--temp").arg("0.2")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Keep model resolution of any sidecar files relative to the install
        // root, mirroring how we run piper.
        cmd.current_dir(&root_for_task);

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        let output = cmd.output().map_err(|e| format!("spawn llama-cli: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let tail: String = stderr.lines().rev().take(4).collect::<Vec<_>>().join(" | ");
            return Err(format!(
                "llama-cli exit {}: {}",
                output.status.code().unwrap_or(-1),
                if tail.trim().is_empty() { "no output" } else { tail.trim() }
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    })
    .await
    .map_err(|e| format!("task join: {e}"))??;

    let cleaned = clean_llm_output(&raw, &prompt);
    if cleaned.is_empty() {
        return Err("model returned an empty answer".into());
    }
    Ok(cleaned)
}

/// Build a minimal PCM/WAV header around raw 16-bit mono samples.
fn wrap_wav(pcm: &[u8], sample_rate: u32) -> Vec<u8> {
    let data_len = pcm.len() as u32;
    let file_len = 36 + data_len;
    let byte_rate = sample_rate * 2; // mono * 2 bytes/sample
    let mut out = Vec::with_capacity(pcm.len() + 44);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&file_len.to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM format
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            piper_status,
            piper_synthesize,
            piper_extract_downloaded_archive,
            piper_download_file,
            piper_file_size,
            piper_batch_synthesize,
            piper_cache_lookup,
            piper_cache_delete_book,
            llm_status,
            llm_explain
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::clean_llm_output;

    // Captured verbatim from `llama-cli b10091 -st --jinja --simple-io
    // --no-display-prompt` — banner, echoed prompt, reply, stats footer.
    const RAW: &str = "\n\nLoading model... \n\n\u{2584}\u{2584}\nbuild      : b10091\n\
available commands:\n  /exit or Ctrl+C     stop or exit\n\n\n\
> In the sentence below, explain what 'wound' means as it is used here. Sentence: The nurse wound the bandage around his arm.\n\
The nurse wrapped the bandage around his arm.\n\n\
[ Prompt: 156.0 t/s | Generation: 33.7 t/s ]\n\n\nExiting...\n";
    const PROMPT: &str =
        "In the sentence below, explain what 'wound' means as it is used here. \
Sentence: The nurse wound the bandage around his arm.";

    #[test]
    fn extracts_reply_between_prompt_echo_and_footer() {
        assert_eq!(
            clean_llm_output(RAW, PROMPT),
            "The nurse wrapped the bandage around his arm."
        );
    }

    #[test]
    fn strips_template_tokens_when_prompt_absent() {
        // Fallback path: no prompt echo, just a reply with an EOG token.
        let raw = "Hello there.<|im_end|>\n";
        assert_eq!(clean_llm_output(raw, "unmatched-prompt"), "Hello there.");
    }

    #[test]
    fn falls_back_to_interactive_marker() {
        let raw = "banner junk\n> some prompt\nThe answer.\n[ Prompt: 1 t/s ]\n";
        assert_eq!(clean_llm_output(raw, "no-match"), "The answer.");
    }
}
