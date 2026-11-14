// Piper neural TTS for the browser, plus the chapter audio cache.
//
// Synthesis runs in piper.worker.ts via @mintplex-labs/piper-tts-web (the
// same ONNX voice models the desktop app downloads from Hugging Face). Voice
// models are stored in the Origin Private File System by that library.
//
// The chapter cache mirrors the desktop format: one concatenated WAV per
// (book, section, voice) plus the start time of every sentence, so cached
// playback highlights sentences exactly like live playback does.

import { blobDeletePrefix, blobGet, blobPut } from './storage';

export interface CachedChapter {
  sentence_starts: number[];
  total_duration: number;
  sample_rate: number;
  wav: Uint8Array;
}

type WorkerReply =
  | { id: number; ok: true; data?: unknown }
  | { id: number; ok: false; error: string }
  | { id: number; progress: { loaded: number; total: number } };

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  onProgress?: (loaded: number, total: number) => void;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./piper.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      const reply = e.data;
      const entry = pending.get(reply.id);
      if (!entry) return;
      if ('progress' in reply) {
        entry.onProgress?.(reply.progress.loaded, reply.progress.total);
        return;
      }
      pending.delete(reply.id);
      if (reply.ok) entry.resolve(reply.data);
      else entry.reject(new Error(reply.error));
    };
    worker.onerror = (e) => {
      // A crashed worker fails every request in flight; the next call
      // starts a fresh one.
      for (const [, entry] of pending) entry.reject(new Error(e.message || 'Piper worker crashed'));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

function call<T>(message: Record<string, unknown> & { op: string }, transfer: Transferable[] = [],
  onProgress?: (loaded: number, total: number) => void): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
    getWorker().postMessage({ id, ...message }, transfer);
  });
}

/** Voice ids already downloaded into this browser. */
export function piperStored(): Promise<string[]> {
  return call<string[]>({ op: 'stored' });
}

export function piperDownload(voiceId: string, onProgress?: (loaded: number, total: number) => void): Promise<void> {
  return call<void>({ op: 'download', voiceId }, [], onProgress).then(() => undefined);
}

export function piperRemove(voiceId: string): Promise<void> {
  return call<void>({ op: 'remove', voiceId }).then(() => undefined);
}

/** Synthesize `text` and return a playable WAV file as bytes. */
export async function piperSynthesize(text: string, voiceId: string): Promise<Uint8Array> {
  const buffer = await call<ArrayBuffer>({ op: 'predict', voiceId, text });
  return new Uint8Array(buffer);
}

/* ------------------------------------------------------------------
   WAV helpers
   ------------------------------------------------------------------ */

interface ParsedWav {
  sampleRate: number;
  pcm: Uint8Array;
}

// Reads the sample rate and the raw PCM payload out of a 16-bit mono WAV.
// Walks RIFF chunks rather than assuming a fixed 44-byte header, since the
// synthesizer may add extra chunks.
export function parseWav(bytes: Uint8Array): ParsedWav {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off: number) => String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
  if (bytes.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error('Piper returned audio in an unexpected format.');
  }
  let sampleRate = 0;
  let bits = 0;
  let pcm: Uint8Array | null = null;
  let off = 12;
  while (off + 8 <= bytes.byteLength) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      pcm = bytes.subarray(body, Math.min(body + size, bytes.byteLength));
    }
    off = body + size + (size & 1);
  }
  if (!pcm || !sampleRate) throw new Error('Piper returned audio without sample data.');
  if (bits !== 16) throw new Error(`Unsupported Piper bit depth: ${bits}`);
  return { sampleRate, pcm };
}

// Wraps raw 16-bit mono PCM in a WAV header so an <audio> element can play it.
export function wrapWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(out.buffer);
  const write = (off: number, s: string) => { for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i); };
  write(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);          // fmt chunk size
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);           // block align
  view.setUint16(34, 16, true);          // bits per sample
  write(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

/* ------------------------------------------------------------------
   Chapter cache
   ------------------------------------------------------------------ */

const cacheWavKey = (bookId: string, sectionKey: string, voiceId: string) =>
  `piper-cache/${bookId}/${sectionKey}_${voiceId}.wav`;
const cacheMetaKey = (bookId: string, sectionKey: string, voiceId: string) =>
  `piper-cache/${bookId}/${sectionKey}_${voiceId}.json`;

export async function piperCacheLookup(bookId: string, sectionKey: string, voiceId: string): Promise<CachedChapter | null> {
  const [wav, metaBytes] = await Promise.all([
    blobGet(cacheWavKey(bookId, sectionKey, voiceId)),
    blobGet(cacheMetaKey(bookId, sectionKey, voiceId)),
  ]);
  if (!wav || !metaBytes) return null;
  const meta = JSON.parse(new TextDecoder().decode(metaBytes));
  return {
    sentence_starts: meta.sentence_starts ?? [],
    total_duration: meta.total_duration ?? 0,
    sample_rate: meta.sample_rate ?? 22050,
    wav,
  };
}

export async function piperCacheDeleteBook(bookId: string): Promise<void> {
  await blobDeletePrefix(`piper-cache/${bookId}/`);
}

/**
 * Synthesize every sentence in order and store the result as one cached
 * chapter. `onProgress` is called after each sentence with (done, total).
 */
export async function piperBatchSynthesize(
  bookId: string,
  sectionKey: string,
  voiceId: string,
  sentences: string[],
  // Silence (ms) appended after each sentence so headings and paragraph ends
  // breathe instead of running into the next line.
  pausesMs: number[] = [],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const chunks: Uint8Array[] = [];
  const sentenceStarts: number[] = [];
  let sampleRate = 0;
  let byteCount = 0;
  let done = 0;
  const total = sentences.length;

  for (let i = 0; i < sentences.length; i++) {
    const text = sentences[i];
    const trimmed = text.trim();
    if (!trimmed) {
      done++;
      onProgress?.(done, total);
      continue;
    }
    const wav = await piperSynthesize(trimmed, voiceId);
    const parsed = parseWav(wav);
    if (!sampleRate) sampleRate = parsed.sampleRate;
    if (parsed.sampleRate !== sampleRate) throw new Error('Piper changed sample rate mid-chapter.');

    // Start time = bytes so far / bytes per second, matching the desktop
    // cache math exactly (16-bit mono, so 2 bytes per sample).
    sentenceStarts.push(byteCount / (sampleRate * 2));
    chunks.push(parsed.pcm);
    byteCount += parsed.pcm.byteLength;
    const pauseMs = Math.min(pausesMs[i] ?? 0, 5000);
    if (pauseMs > 0) {
      const silence = new Uint8Array(Math.round(sampleRate * pauseMs / 1000) * 2);   // zeros = silence
      chunks.push(silence);
      byteCount += silence.byteLength;
    }
    done++;
    onProgress?.(done, total);
  }

  if (byteCount === 0 || !sampleRate) throw new Error('No audio was produced (is the section empty?)');

  const pcm = new Uint8Array(byteCount);
  let off = 0;
  for (const c of chunks) { pcm.set(c, off); off += c.byteLength; }

  const meta = {
    voice: voiceId,
    section: sectionKey,
    sentence_starts: sentenceStarts,
    total_duration: byteCount / (sampleRate * 2),
    sample_rate: sampleRate,
  };
  await blobPut(cacheWavKey(bookId, sectionKey, voiceId), wrapWav(pcm, sampleRate));
  await blobPut(cacheMetaKey(bookId, sectionKey, voiceId), new TextEncoder().encode(JSON.stringify(meta)));
}
