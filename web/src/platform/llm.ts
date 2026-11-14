// Local AI for the browser. The desktop app runs llama.cpp as a subprocess;
// a web page can't do that, so there are two equivalent backends:
//
//   webllm  — the model runs inside the browser on WebGPU (@mlc-ai/web-llm).
//             Fully offline once downloaded. Needs a GPU-capable browser
//             (current Chrome/Edge; Firefox and Safari support is partial).
//   server  — any OpenAI-compatible endpoint you run yourself: llama.cpp's
//             `llama-server`, Ollama, LM Studio, etc. Nothing is downloaded
//             into the page.
//
// Both expose the same `complete()` call, so the reader features don't care
// which one is active.

import type { MLCEngine } from '@mlc-ai/web-llm';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }

export interface WebLlmModel {
  id: string;          // WebLLM model id
  label: string;
  desc: string;
  sizeMb: number;      // rough download size, for the UI only
}

// Same three sizes as the desktop catalog, using WebLLM's prebuilt builds of
// the same Qwen2.5 Instruct checkpoints.
export const WEBLLM_CATALOG: WebLlmModel[] = [
  { id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', label: 'Qwen2.5 0.5B Instruct', desc: 'Fastest, lower quality', sizeMb: 350 },
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen2.5 1.5B Instruct', desc: 'Balanced (recommended)', sizeMb: 900 },
  { id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC',   label: 'Qwen2.5 3B Instruct',   desc: 'Best quality, slower',   sizeMb: 1800 },
];

export async function webgpuAvailable(): Promise<boolean> {
  try {
    const gpu = (navigator as any).gpu;
    if (!gpu) return false;
    return !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------
   WebLLM (in-browser)
   ------------------------------------------------------------------ */

let engine: MLCEngine | null = null;
let engineModelId: string | null = null;
let engineLoading: Promise<MLCEngine> | null = null;

async function loadEngine(modelId: string, onProgress?: (text: string, fraction: number) => void): Promise<MLCEngine> {
  if (engine && engineModelId === modelId) return engine;
  if (engineLoading) await engineLoading.catch(() => {});
  if (engine && engineModelId === modelId) return engine;

  // Dynamic import keeps the WebLLM runtime (a few MB of WASM glue) out of
  // the initial page load — it's only fetched once someone uses local AI.
  const webllm = await import('@mlc-ai/web-llm');
  if (engine) {
    await engine.unload().catch(() => {});
    engine = null;
  }
  engineLoading = webllm.CreateMLCEngine(modelId, {
    initProgressCallback: (report) => onProgress?.(report.text, report.progress),
  });
  try {
    engine = await engineLoading;
    engineModelId = modelId;
    return engine;
  } finally {
    engineLoading = null;
  }
}

export async function webllmInstalled(modelId: string): Promise<boolean> {
  const webllm = await import('@mlc-ai/web-llm');
  return webllm.hasModelInCache(modelId);
}

/** Download (or load from cache) a model. Progress is 0–1. */
export async function webllmInstall(modelId: string, onProgress?: (text: string, fraction: number) => void): Promise<void> {
  await loadEngine(modelId, onProgress);
}

export async function webllmRemove(modelId: string): Promise<void> {
  if (engine && engineModelId === modelId) {
    await engine.unload().catch(() => {});
    engine = null;
    engineModelId = null;
  }
  const webllm = await import('@mlc-ai/web-llm');
  await webllm.deleteModelAllInfoInCache(modelId);
}

/* ------------------------------------------------------------------
   OpenAI-compatible server
   ------------------------------------------------------------------ */

export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/** Returns the model ids the server reports, or throws with a readable reason. */
export async function serverListModels(baseUrl: string): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(8000) });
  } catch {
    throw new Error(`Couldn't reach ${baseUrl}. Check the address and that CORS is allowed for this page.`);
  }
  if (!res.ok) throw new Error(`The server responded with HTTP ${res.status}.`);
  const json = await res.json();
  const ids: string[] = (json.data || []).map((m: { id: string }) => m.id).filter(Boolean);
  return ids;
}

/* ------------------------------------------------------------------
   Shared completion entry point
   ------------------------------------------------------------------ */

export interface LlmTarget {
  provider: 'webllm' | 'server';
  model: string;       // WebLLM model id, or the model name on the server
  serverUrl?: string;  // normalized base URL (ends in /v1) when provider === 'server'
}

export async function complete(target: LlmTarget, messages: ChatMessage[], maxTokens: number): Promise<string> {
  if (target.provider === 'server') {
    if (!target.serverUrl) throw new Error('No local server configured.');
    const res = await fetch(`${target.serverUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: target.model || undefined,
        messages,
        max_tokens: maxTokens,
        temperature: 0.2,
        stream: false,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Server returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
    const json = await res.json();
    return String(json.choices?.[0]?.message?.content ?? '').trim();
  }

  const e = await loadEngine(target.model);
  const reply = await e.chat.completions.create({
    messages,
    max_tokens: maxTokens,
    temperature: 0.2,
  });
  return String(reply.choices[0]?.message?.content ?? '').trim();
}
