/* Client for the Tiny Voca worker: lazy start, request/response by id, and
   WAV encoding so the audio drops into the same <audio> pipeline Piper uses. */

export type VocaVoice = 'F2' | 'M2';
export const VOCA_VOICES: Array<{ id: VocaVoice; label: string }> = [
  { id: 'F2', label: 'Tiny Voca · F2 (female)' },
  { id: 'M2', label: 'Tiny Voca · M2 (male)' },
];

let worker: Worker | null = null;
let readyPromise: Promise<void> | null = null;
let nextId = 1;
let ready = false;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let onProgress: ((stage: string, step: number, steps: number) => void) | null = null;

export const isVocaReady = (): boolean => ready;
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

/** Starts the worker (once) and resolves when Python + the model are loaded. */
export function startVoca(): Promise<void> {
  if (readyPromise) return readyPromise;
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
  };
  const base = new URL('/voca/', location.href).href;
  readyPromise = request<void>({ type: 'init', base }).then(() => { ready = true; onReady?.(); });
  readyPromise.catch(() => { onReady?.(); worker?.terminate(); worker = null; readyPromise = null; });
  return readyPromise;
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

/** Synthesizes `text` to raw mono samples. `speed` 1 = the voice's natural pace. */
export async function vocaSynthesizeSamples(text: string, voice: VocaVoice, speed = 1): Promise<{ audio: Float32Array; sampleRate: number }> {
  await startVoca();
  return request<{ audio: Float32Array; sampleRate: number }>(
    { type: 'synth', text, voice: voice === 'M2' ? 1 : 0, speed });
}

/** Synthesizes `text` and returns a 16-bit mono WAV. */
export async function vocaSynthesize(text: string, voice: VocaVoice, speed = 1): Promise<Uint8Array> {
  const m = await vocaSynthesizeSamples(text, voice, speed);
  return wavFromFloat32(m.audio, m.sampleRate);
}
