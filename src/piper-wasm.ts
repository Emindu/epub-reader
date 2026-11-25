/* Client for the iOS Piper worker (piper-wasm.worker.ts). On iOS a voice's
   "path" is just its Piper voice id (e.g. en_US-lessac-medium), so
   ttsSettings.piperVoicePath and PiperStatus keep the desktop shape. */

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
    worker = new Worker(new URL('./piper-wasm.worker.ts', import.meta.url), { type: 'module' });
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
    worker.onerror = e => {
      // A crashed worker (often iOS reclaiming memory) fails everything in
      // flight; the next call starts a fresh one.
      for (const [, entry] of pending) entry.reject(new Error(e.message || 'Piper worker crashed'));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

function call<T>(message: { op: string } & Record<string, unknown>,
  onProgress?: (loaded: number, total: number) => void): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
    getWorker().postMessage({ id, ...message });
  });
}

/** Voice ids already downloaded on this device. */
export const piperWasmStored = (): Promise<string[]> => call<string[]>({ op: 'stored' });

export const piperWasmDownload = (voiceId: string, onProgress?: (loaded: number, total: number) => void): Promise<void> =>
  call<void>({ op: 'download', voiceId }, onProgress);

export const piperWasmRemove = (voiceId: string): Promise<void> => call<void>({ op: 'remove', voiceId });

/** Synthesize `text` and return a playable 16-bit mono WAV. */
export async function piperWasmSynthesize(text: string, voiceId: string): Promise<Uint8Array> {
  return new Uint8Array(await call<ArrayBuffer>({ op: 'predict', voiceId, text }));
}

/** Sample rate + raw 16-bit PCM of a mono WAV. Walks RIFF chunks rather than
    assuming a 44-byte header, since the synthesizer may add extra chunks. */
export function parseWav(bytes: Uint8Array): { sampleRate: number; pcm: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off: number) => String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
  if (bytes.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Piper returned audio in an unexpected format.');
  let sampleRate = 0, bits = 0, pcm: Uint8Array | null = null, off = 12;
  while (off + 8 <= bytes.byteLength) {
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (tag(off) === 'fmt ') { sampleRate = view.getUint32(body + 4, true); bits = view.getUint16(body + 14, true); }
    else if (tag(off) === 'data') pcm = bytes.subarray(body, Math.min(body + size, bytes.byteLength));
    off = body + size + (size & 1);
  }
  if (!pcm || !sampleRate) throw new Error('Piper returned audio without sample data.');
  if (bits !== 16) throw new Error(`Unsupported Piper bit depth: ${bits}`);
  return { sampleRate, pcm };
}

/** Wraps raw 16-bit mono PCM in a WAV header. */
export function wrapWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(out.buffer);
  const write = (off: number, s: string) => { for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i); };
  write(0, 'RIFF'); view.setUint32(4, 36 + pcm.byteLength, true); write(8, 'WAVE');
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}
