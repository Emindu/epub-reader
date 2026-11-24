/* Client for the Tiny Voca worker: lazy start, request/response by id, and
   WAV encoding so the audio drops into the same <audio> pipeline Piper uses. */

import { isSinhalaText } from './sinhala';

export type VocaLang = 'en' | 'si';
/** The user picks female or male. The text's language then decides the voice:
    English F2/M2, Sinhala F1/M1 (the retrained model). Older saves may hold M1/F1. */
export type VocaVoice = 'F2' | 'M2' | 'M1' | 'F1';
export const VOCA_VOICES: Array<{ id: VocaVoice; label: string }> = [
  { id: 'F2', label: 'Tiny Voca · Female (English F2, Sinhala F1)' },
  { id: 'M2', label: 'Tiny Voca · Male (English M2, Sinhala M1)' },
];
export const isFemaleVoice = (voice: VocaVoice): boolean => voice === 'F2' || voice === 'F1';
/** Folds any saved voice into the two choices shown in the list. */
export const normalizeVocaVoice = (voice: string): VocaVoice => (voice === 'M2' || voice === 'M1' ? 'M2' : 'F2');

/** Which engine will read this text. */
export const vocaLangForText = (text: string): VocaLang => (isSinhalaText(text) ? 'si' : 'en');

let worker: Worker | null = null;
const readyPromises: Partial<Record<VocaLang, Promise<void>>> = {};
let nextId = 1;
const readyLangs: Partial<Record<VocaLang, boolean>> = {};
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let onProgress: ((stage: string, step: number, steps: number) => void) | null = null;

export const isVocaReady = (lang: VocaLang = 'en'): boolean => !!readyLangs[lang];
let onReady: (() => void) | null = null;
export function setVocaReadyListener(fn: (() => void) | null): void { onReady = fn; }
export function setVocaProgressListener(fn: ((stage: string, step: number, steps: number) => void) | null): void { onProgress = fn; }

function request<T>(payload: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ ...payload, id }, transfer);
  });
}

function ensureWorker(): void {
  if (worker) return;
  worker = new Worker(new URL('./voca.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent) => {
    const m = e.data;
    if (m.type === 'progress') { onProgress?.(m.stage, m.step, m.steps); return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.type === 'error') p.reject(new Error(m.message));
    else p.resolve(m);
  };
  worker.onerror = (e) => {
    const err = new Error(e.message || 'voca worker crashed');
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    worker = null;
    for (const k of Object.keys(readyPromises) as VocaLang[]) { delete readyPromises[k]; readyLangs[k] = false; }
  };
}

/** Starts the worker (once) and resolves when that language's engine (Python/eSpeak + model) is loaded. */
export function startVoca(lang: VocaLang = 'en'): Promise<void> {
  const existing = readyPromises[lang];
  if (existing) return existing;
  ensureWorker();
  const base = new URL('/voca/', location.href).href;
  const p = request<void>({ type: 'init', base, lang }).then(() => { readyLangs[lang] = true; onReady?.(); });
  readyPromises[lang] = p;
  p.catch(() => { onReady?.(); if (readyPromises[lang] === p) delete readyPromises[lang]; });
  return p;
}

export function wavFromFloat32(samples: Float32Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(out.buffer);
  const tag = (o: number, s: string) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); tag(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/** What the model says about when things are spoken. Times are seconds in the audio. */
export interface VocaTiming {
  spoken: Array<[number, number]>;   // start/end of each spoken word, in order
  tokenStarts: number[];             // start of every phoneme/punctuation token, then the end
}

export interface VocaSamples extends Partial<VocaTiming> { audio: Float32Array; sampleRate: number }

/** Synthesizes `text` to raw mono samples. `speed` 1 = the voice's natural pace. */
export async function vocaSynthesizeSamples(text: string, voice: VocaVoice, speed = 1): Promise<VocaSamples> {
  // The text decides the language, the voice argument decides male or female.
  const lang = vocaLangForText(text);
  const isFemale = isFemaleVoice(voice);
  await startVoca(lang);
  // Sinhala model voices: M1 = 0, F1 = 1. English: F2 = 0, M2 = 1.
  const index = lang === 'si' ? (isFemale ? 1 : 0) : (isFemale ? 0 : 1);
  return request<VocaSamples>({ type: 'synth', text, voice: index, speed, lang });
}

/** Synthesizes `text` and returns a 16-bit mono WAV. */
export async function vocaSynthesize(text: string, voice: VocaVoice, speed = 1): Promise<Uint8Array> {
  return (await vocaSynthesizeTimed(text, voice, speed)).wav;
}

/** Like vocaSynthesize, plus the model's own timing so the highlight can follow the speech exactly. */
export async function vocaSynthesizeTimed(text: string, voice: VocaVoice, speed = 1): Promise<{ wav: Uint8Array; timing: VocaTiming | null }> {
  const m = await vocaSynthesizeSamples(text, voice, speed);
  const timing = m.spoken && m.tokenStarts && m.tokenStarts.length > 1 ? { spoken: m.spoken, tokenStarts: m.tokenStarts } : null;
  return { wav: wavFromFloat32(m.audio, m.sampleRate), timing };
}
