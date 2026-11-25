//! llama.cpp linked into the app, for platforms that can't spawn `llama-cli`
//! (iOS). Built when `cfg(embedded_llm)` is set — always on iOS, and on
//! desktop with `--features embedded-llm` (handy for testing on a Mac).
//!
//! Callers pass the same single-turn prompt they'd hand `llama-cli`; the
//! model's own chat template (baked into the GGUF) is applied here, which is
//! what `llama-cli --jinja` does. Unlike the CLI there's no banner or prompt
//! echo to strip, so the output is the reply as-is.

use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{LlamaChatMessage, LlamaChatTemplate, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;

/// Same context size `run_llama_cli` passes with `-c`.
const N_CTX: u32 = 4096;

static BACKEND: OnceLock<Result<LlamaBackend, String>> = OnceLock::new();

/// The last model used, kept loaded: loading a 1 GB GGUF takes seconds, and
/// a reader asking about several words in a row shouldn't pay that each time.
/// The mutex also serializes generations, so two never hold memory at once.
static MODEL: Mutex<Option<(PathBuf, LlamaModel)>> = Mutex::new(None);

fn backend() -> Result<&'static LlamaBackend, String> {
    BACKEND
        .get_or_init(|| {
            let mut b = LlamaBackend::init().map_err(|e| format!("llama.cpp init: {e}"))?;
            b.void_logs();
            Ok(b)
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// Free the cached model. Must run before the process exits: ggml's Metal
/// device asserts (and aborts) in its static destructor if model buffers are
/// still alive.
pub fn unload() {
    if let Ok(mut slot) = MODEL.lock() {
        *slot = None;
    }
}

/// Generate a reply to `prompt` (one user turn). Blocking — call from
/// `spawn_blocking`.
pub fn generate(model_path: &Path, prompt: &str, n_predict: u32) -> Result<String, String> {
    let backend = backend()?;
    let mut slot = MODEL.lock().map_err(|_| "llm engine poisoned by an earlier crash".to_string())?;

    if slot.as_ref().map_or(true, |(p, _)| p != model_path) {
        *slot = None; // free the old model before loading the next one
        // Offload every layer to the GPU (Metal); llama.cpp clamps to the real count.
        let params = LlamaModelParams::default().with_n_gpu_layers(999);
        let model = LlamaModel::load_from_file(backend, model_path, &params)
            .map_err(|e| format!("load model: {e}"))?;
        *slot = Some((model_path.to_path_buf(), model));
    }
    let model = &slot.as_ref().expect("model loaded above").1;

    // Apply the GGUF's chat template; fall back to ChatML (Qwen's format) for
    // models that don't ship one.
    let template = match model.chat_template(None) {
        Ok(t) => t,
        Err(_) => LlamaChatTemplate::new("chatml").map_err(|e| format!("chat template: {e}"))?,
    };
    let message = LlamaChatMessage::new("user".into(), prompt.into())
        .map_err(|e| format!("prompt: {e}"))?;
    let formatted = model
        .apply_chat_template(&template, &[message], true)
        .map_err(|e| format!("apply chat template: {e}"))?;

    let vocab = model.vocab();
    let tokens = vocab.tokenize(formatted.as_bytes(), true, true);
    let budget = N_CTX as usize;
    if tokens.len() + n_predict as usize > budget {
        return Err(format!(
            "prompt too long for the model's context ({} tokens + {n_predict} to generate > {budget})",
            tokens.len()
        ));
    }

    let ctx_params = LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(N_CTX))
        .with_n_batch(N_CTX);
    let mut ctx = model
        .new_context(backend, ctx_params)
        .map_err(|e| format!("create context: {e}"))?;

    // Prompt: one batch, logits only for the last token.
    let mut batch = LlamaBatch::new(budget, 1);
    let last = tokens.len() as i32 - 1;
    for (i, token) in tokens.iter().enumerate() {
        batch
            .add(*token, i as i32, &[0], i as i32 == last)
            .map_err(|e| format!("batch: {e}"))?;
    }
    ctx.decode(&mut batch).map_err(|e| format!("decode prompt: {e}"))?;

    // Same sampling as llama-cli's defaults with `--temp 0.2`.
    let mut sampler = LlamaSampler::chain_simple([
        LlamaSampler::top_k(40),
        LlamaSampler::top_p(0.95, 1),
        LlamaSampler::min_p(0.05, 1),
        LlamaSampler::temp(0.2),
        LlamaSampler::dist(0x5EED),
    ]);

    // Collect bytes, not strings: a multi-byte character can span two tokens.
    let mut out: Vec<u8> = Vec::new();
    let mut pos = tokens.len() as i32;
    for _ in 0..n_predict {
        let token = sampler.sample(&ctx, batch.n_tokens() - 1);
        if vocab.is_eog(token) {
            break;
        }
        out.extend(vocab.token_to_piece(token, false, None));
        batch.clear();
        batch.add(token, pos, &[0], true).map_err(|e| format!("batch: {e}"))?;
        pos += 1;
        ctx.decode(&mut batch).map_err(|e| format!("decode: {e}"))?;
    }

    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

#[cfg(test)]
mod tests {
    /// Runs a real model, so it's opt-in:
    /// READ_TEST_GGUF=/path/to/model.gguf cargo test --features embedded-llm -- --ignored
    #[test]
    #[ignore]
    fn explains_a_word_with_a_real_model() {
        let path = std::env::var("READ_TEST_GGUF").expect("set READ_TEST_GGUF to a .gguf file");
        let prompt = "In the sentence below, explain what 'wound' means as it is used here. Give the \
specific sense in 1-2 plain sentences. Be concise. Sentence: The nurse wound the bandage around his arm.";
        let start = std::time::Instant::now();
        let reply = super::generate(std::path::Path::new(&path), prompt, 120).expect("generate");
        println!("[{:.1}s] {reply}", start.elapsed().as_secs_f32());
        assert!(!reply.is_empty());
        assert!(!reply.contains("<|im_end|>"), "template tokens leaked: {reply}");

        // Second call reuses the loaded model.
        let start = std::time::Instant::now();
        let again = super::generate(std::path::Path::new(&path), "Say hello in one word.", 16).expect("generate");
        println!("[{:.1}s, cached model] {again}", start.elapsed().as_secs_f32());
        super::unload();
    }
}
