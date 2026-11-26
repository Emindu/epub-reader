// "Bring your own key" cloud AI — one provider-agnostic adapter.
//
// Two wire formats cover every provider we support:
//   anthropic — Anthropic Messages API (Claude)
//   openai    — OpenAI-style /chat/completions, which OpenAI, Mistral,
//               OpenRouter, Groq, Gemini's compat endpoint and most
//               self-hosted gateways all speak
//
// Callers only use chat() / listModels() and never see the difference. This
// file has no DOM or Tauri dependencies and is byte-identical in the desktop
// (src/byok.ts) and web (web/src/platform/byok.ts) apps — keep them in sync.
//
// All three hosted APIs answer browser CORS preflights, so the webview calls
// them directly; the key is read from a KeyStore only at call time.

export type ProviderKind = 'anthropic' | 'openai';

export interface ProviderPreset {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  defaultModel: string;
  keyHint: string;       // placeholder / what the key looks like
  keyUrl: string;        // where the reader creates a key
  tokenParam: 'max_tokens' | 'max_completion_tokens';
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'anthropic',  label: 'Anthropic (Claude)', kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-5-5', keyHint: 'sk-ant-…', keyUrl: 'https://console.anthropic.com/settings/keys', tokenParam: 'max_tokens' },
  { id: 'openai',     label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini', keyHint: 'sk-…', keyUrl: 'https://platform.openai.com/api-keys', tokenParam: 'max_completion_tokens' },
  { id: 'mistral',    label: 'Mistral AI', kind: 'openai', baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-small-latest', keyHint: 'Mistral API key', keyUrl: 'https://console.mistral.ai/api-keys', tokenParam: 'max_tokens' },
  { id: 'openrouter', label: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini', keyHint: 'sk-or-…', keyUrl: 'https://openrouter.ai/keys', tokenParam: 'max_tokens' },
  { id: 'groq',       label: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile', keyHint: 'gsk_…', keyUrl: 'https://console.groq.com/keys', tokenParam: 'max_tokens' },
  { id: 'custom',     label: 'Custom (OpenAI-compatible)', kind: 'openai', baseUrl: '',
    defaultModel: '', keyHint: 'API key', keyUrl: '', tokenParam: 'max_tokens' },
];

export interface ByokConfig {
  presetId: string;
  kind: ProviderKind;
  baseUrl: string;       // no trailing slash
  model: string;
  enabled: boolean;      // use the cloud provider for chat / explain
  acknowledged: boolean; // reader accepted "text you send leaves this device"
  maxContextTokens: number; // per-request cap on document text sent
  sessionTokenCap: number;  // 0 = unlimited; stops sending once reached
}

export const DEFAULT_MAX_CONTEXT_TOKENS = 60_000;

export function presetById(id: string): ProviderPreset {
  return PROVIDER_PRESETS.find(p => p.id === id) || PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1];
}

export function defaultConfig(presetId = 'anthropic'): ByokConfig {
  const p = presetById(presetId);
  return {
    presetId: p.id, kind: p.kind, baseUrl: p.baseUrl, model: p.defaultModel,
    enabled: false, acknowledged: false,
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS, sessionTokenCap: 0,
  };
}

export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/* ------------------------------------------------------------------
   Key storage. Desktop supplies an OS-keychain store; the web app uses
   localStorage (a browser has nothing safer). Keyed per provider so
   switching providers doesn't lose the other key.
   ------------------------------------------------------------------ */
export interface KeyStore {
  get(providerId: string): Promise<string>;
  set(providerId: string, key: string): Promise<void>;
  remove(providerId: string): Promise<void>;
}

export const localStorageKeyStore: KeyStore = {
  async get(id) { try { return localStorage.getItem(`read.byok.key.${id}`) || ''; } catch { return ''; } },
  async set(id, key) { localStorage.setItem(`read.byok.key.${id}`, key); },
  async remove(id) { try { localStorage.removeItem(`read.byok.key.${id}`); } catch { /* ignore */ } },
};

export function maskKey(key: string): string {
  if (!key) return '';
  return key.length <= 8 ? '••••' : `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/* ------------------------------------------------------------------
   Chat
   ------------------------------------------------------------------ */
export interface Msg { role: 'user' | 'assistant'; content: string; }

export interface ChatOptions {
  system?: string;
  /** Marks the system prompt cacheable (Anthropic prompt caching) — set when it carries the document. */
  cacheSystem?: boolean;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Called with each streamed text fragment. */
  onToken?: (text: string) => void;
}

export class ByokError extends Error {
  constructor(message: string, public status = 0) { super(message); }
}

function friendlyHttpError(status: number, detail: string, cfg: ByokConfig): ByokError {
  let msg: string;
  if (status === 401 || status === 403) msg = 'The provider rejected the API key. Check it in Settings → Cloud AI.';
  else if (status === 404) msg = `Model "${cfg.model}" or endpoint not found. Check the model name and base URL.`;
  else if (status === 413) msg = 'The request was too large for this model. Try a smaller scope.';
  else if (status === 429) msg = 'Rate limit or quota reached. Wait a moment or check your plan and billing.';
  else if (status >= 500) msg = `The provider had a problem (HTTP ${status}). Try again shortly.`;
  else msg = `The provider returned HTTP ${status}.`;
  const d = detail.replace(/\s+/g, ' ').trim().slice(0, 220);
  return new ByokError(d ? `${msg} (${d})` : msg, status);
}

async function postStream(cfg: ByokConfig, url: string, headers: Record<string, string>, body: unknown,
  signal: AbortSignal | undefined, onData: (json: any) => void): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new ByokError(`Couldn't reach ${new URL(url).host}. Check your connection and the base URL.`);
  }
  if (!res.ok) throw friendlyHttpError(res.status, await res.text().catch(() => ''), cfg);
  if (!res.body) throw new ByokError('The provider returned an empty response.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.search(/\r?\n/)) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(buf[nl] === '\r' ? nl + 2 : nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try { onData(JSON.parse(data)); } catch { /* keep-alive or partial line */ }
    }
  }
}

/** Streams a reply and resolves with the full text. */
export async function chat(cfg: ByokConfig, key: string, messages: Msg[], opts: ChatOptions = {}): Promise<string> {
  if (!key) throw new ByokError('No API key set. Add one in Settings → Cloud AI.');
  if (!cfg.model) throw new ByokError('No model selected.');
  const base = normalizeBaseUrl(cfg.baseUrl);
  if (!base) throw new ByokError('No base URL set.');
  const maxTokens = opts.maxTokens ?? 1024;
  let out = '';
  const emit = (t: string) => { if (t) { out += t; opts.onToken?.(t); } };

  if (cfg.kind === 'anthropic') {
    const body: Record<string, unknown> = {
      model: cfg.model, max_tokens: maxTokens, stream: true, messages,
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    };
    if (opts.system) {
      body.system = [{ type: 'text', text: opts.system, ...(opts.cacheSystem ? { cache_control: { type: 'ephemeral' } } : {}) }];
    }
    let apiError = '';
    await postStream(cfg, `${base}/messages`, {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    }, body, opts.signal, (j) => {
      if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') emit(j.delta.text);
      else if (j.type === 'error') apiError = j.error?.message || 'The provider reported an error.';
    });
    if (apiError) throw new ByokError(apiError);
  } else {
    const preset = presetById(cfg.presetId);
    const msgs = opts.system ? [{ role: 'system', content: opts.system }, ...messages] : messages;
    const body: Record<string, unknown> = {
      model: cfg.model, messages: msgs, stream: true,
      [preset.tokenParam]: maxTokens,
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    };
    await postStream(cfg, `${base}/chat/completions`, { Authorization: `Bearer ${key}` }, body, opts.signal, (j) => {
      const c = j.choices?.[0]?.delta?.content;
      // Mistral can return content as an array of typed chunks.
      if (typeof c === 'string') emit(c);
      else if (Array.isArray(c)) for (const part of c) if (typeof part?.text === 'string') emit(part.text);
    });
  }
  if (!out.trim()) throw new ByokError('The model returned an empty reply.');
  return out.trim();
}

/** Model ids the account can use, or throws a readable error (also doubles as a key test). */
export async function listModels(cfg: ByokConfig, key: string): Promise<string[]> {
  if (!key) throw new ByokError('Enter an API key first.');
  const base = normalizeBaseUrl(cfg.baseUrl);
  if (!base) throw new ByokError('Enter a base URL first.');
  const headers: Record<string, string> = cfg.kind === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
    : { Authorization: `Bearer ${key}` };
  let res: Response;
  try {
    res = await fetch(`${base}/models${cfg.kind === 'anthropic' ? '?limit=100' : ''}`, { headers, signal: AbortSignal.timeout(15000) });
  } catch {
    throw new ByokError(`Couldn't reach ${base}. Check your connection and the base URL.`);
  }
  if (!res.ok) throw friendlyHttpError(res.status, await res.text().catch(() => ''), cfg);
  const json = await res.json();
  const ids: string[] = (json.data || []).map((m: { id: string }) => m.id).filter(Boolean);
  return ids.sort((a, b) => a.localeCompare(b));
}

/* ------------------------------------------------------------------
   Token + context helpers
   ------------------------------------------------------------------ */
/** Rough token estimate (≈4 chars per token for English). Display/budgeting only. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function formatTokens(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** A labelled piece of the document the model may cite as [S<n>]. */
export interface Source {
  n: number;
  label: string;   // "Chapter 3 — The Storm"
  ref: string;     // opaque location the app can navigate to
  text: string;
}

export interface SourceSection { label: string; ref: string; text: string; }

const STOP = new Set('a an and are as at be but by for from has have he her his i if in is it its of on or she that the their them they this to was we were what when where which who will with you your not no so do does did can could would should about into than then there these those been being'.split(' '));

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}']+/gu) || []).filter(w => w.length > 1 && !STOP.has(w));
}

/** Splits long section text into ~`words`-word chunks on paragraph/sentence edges, keeping the section's ref. */
export function chunkSections(sections: SourceSection[], words = 320): SourceSection[] {
  const out: SourceSection[] = [];
  for (const sec of sections) {
    const parts = sec.text.split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z“"])/);
    let cur: string[] = [];
    let count = 0;
    const flush = () => {
      if (cur.length) out.push({ label: sec.label, ref: sec.ref, text: cur.join(' ').trim() });
      cur = []; count = 0;
    };
    for (const p of parts) {
      const w = p.split(/\s+/).filter(Boolean).length;
      if (!w) continue;
      if (count + w > words && count > 0) flush();
      cur.push(p.trim());
      count += w;
    }
    flush();
  }
  return out;
}

/** BM25-ranks chunks against the query and returns the best ones that fit `tokenBudget`, in book order. */
export function selectRelevant(chunks: SourceSection[], query: string, tokenBudget: number): SourceSection[] {
  const q = Array.from(new Set(tokenize(query)));
  if (q.length === 0) return chunks.slice(0, Math.max(1, Math.floor(tokenBudget / 450)));
  const docs = chunks.map(c => tokenize(c.text));
  const N = docs.length;
  const avgLen = docs.reduce((a, d) => a + d.length, 0) / Math.max(1, N);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const k1 = 1.4, b = 0.75;
  const scored = docs.map((d, i) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const n = df.get(t) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const norm = 1 - b + b * (d.length / (avgLen || 1));
      score += idf * ((f * (k1 + 1)) / (f + k1 * norm));
    }
    return { i, score };
  }).filter(s => s.score > 0).sort((a, b2) => b2.score - a.score);

  const picked: number[] = [];
  let used = 0;
  for (const s of scored) {
    const cost = estimateTokens(chunks[s.i].text) + 12;
    if (used + cost > tokenBudget) continue;
    picked.push(s.i);
    used += cost;
  }
  return picked.sort((a, b2) => a - b2).map(i => chunks[i]);
}

export interface BuiltContext {
  sources: Source[];
  tokens: number;
  mode: 'whole' | 'excerpts';
  note: string;   // human-readable summary of what is being sent
}

/** Turns scope text into numbered sources, retrieving excerpts when the whole thing exceeds the budget. */
export function buildContext(sections: SourceSection[], question: string, tokenBudget: number): BuiltContext {
  const total = sections.reduce((a, s) => a + estimateTokens(s.text) + 12, 0);
  let chosen: SourceSection[];
  let mode: BuiltContext['mode'];
  if (total <= tokenBudget) {
    chosen = sections; mode = 'whole';
  } else {
    chosen = selectRelevant(chunkSections(sections), question, tokenBudget); mode = 'excerpts';
    if (chosen.length === 0) chosen = chunkSections(sections).slice(0, Math.max(1, Math.floor(tokenBudget / 450)));
  }
  const sources = chosen.map((s, i) => ({ n: i + 1, label: s.label, ref: s.ref, text: s.text }));
  const tokens = sources.reduce((a, s) => a + estimateTokens(s.text) + 12, 0);
  const note = mode === 'whole'
    ? `${sources.length === 1 ? sources[0].label : `${sources.length} sections`} · ~${formatTokens(tokens)} tokens`
    : `${sources.length} relevant excerpts of a long text · ~${formatTokens(tokens)} tokens`;
  return { sources, tokens, mode, note };
}

/** System prompt carrying the document. Cacheable: identical across follow-up turns when sources don't change. */
export function buildSystemPrompt(bookTitle: string, sources: Source[], opts: { selection?: string } = {}): string {
  const docs = sources.map(s => `<source id="S${s.n}" title=${JSON.stringify(s.label)}>\n${s.text}\n</source>`).join('\n');
  return [
    `You are a reading companion helping a reader with "${bookTitle}". Answer using the sources below. `,
    `If the answer isn't in them, say so plainly — don't invent details about the text. Be concise and clear; Markdown is fine.`,
    `When you rely on a source, cite it inline as [S1], [S2] etc. using the ids given. Quote short phrases only when helpful.`,
    opts.selection ? `\nThe reader has highlighted this passage and is asking about it:\n<selection>\n${opts.selection}\n</selection>` : '',
    `\n${docs}`,
  ].join('\n');
}

/* Explain-in-context / word examples prompts (same asks as the local-model path). */
const flat = (s: string) => s.trim().split(/\s+/).filter(Boolean).join(' ');

export function explainPrompt(word: string, sentence: string): string {
  const w = flat(word), s = flat(sentence);
  return s
    ? `In the sentence below, explain what '${w}' means as it is used here. Give the specific sense in 1-2 plain sentences. If it is an idiom, figure of speech, or technical term, say so and give the plain meaning. Be concise and do not repeat the sentence back. Sentence: ${s}`
    : `Explain the word or phrase '${w}' concisely for a reader. Give its meaning in 1-2 plain sentences, then one short example of use.`;
}

export function examplesPrompt(word: string, sentence: string): string {
  const w = flat(word), s = flat(sentence);
  const avoid = s ? ` Don't reuse the reader's own sentence: "${s}".` : '';
  return `Give 3 short example sentences that each use the word or phrase '${w}' in a different context or sense than the others, to help a reader learn how it's used. Number them 1-3, one sentence per line, with no extra commentary before or after.${avoid}`;
}
