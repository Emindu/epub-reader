// Runs Piper neural TTS off the main thread. Synthesis takes ~0.5–2 s of CPU
// per sentence; doing that in a worker keeps scrolling and page turns smooth
// during read-aloud and chapter caching.
//
// The ONNX Runtime and phonemizer WASM files are served from this app's own
// origin (public/ort and public/piper), not from the library's CDN defaults,
// so Piper keeps working offline and doesn't depend on a third-party host.

import * as tts from '@mintplex-labs/piper-tts-web';

type Request =
  | { id: number; op: 'predict'; voiceId: string; text: string }
  | { id: number; op: 'download'; voiceId: string }
  | { id: number; op: 'stored' }
  | { id: number; op: 'remove'; voiceId: string };

const ctx = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<Request>) => void) | null;
};

const base = `${self.location.origin}/`;
const wasmPaths = {
  onnxWasm: `${base}ort/`,
  piperWasm: `${base}piper/piper_phonemize.wasm`,
  piperData: `${base}piper/piper_phonemize.data`,
};

// One loaded model per voice. Loading the ONNX session is slow (seconds), so
// it's kept for the life of the worker.
const sessions = new Map<string, Promise<tts.TtsSession>>();
function sessionFor(voiceId: string): Promise<tts.TtsSession> {
  let s = sessions.get(voiceId);
  if (!s) {
    s = tts.TtsSession.create({ voiceId, wasmPaths });
    // Don't cache a failed load — the next request should retry.
    s.catch(() => sessions.delete(voiceId));
    sessions.set(voiceId, s);
  }
  return s;
}

ctx.onmessage = async (e: MessageEvent<Request>) => {
  const msg = e.data;
  try {
    switch (msg.op) {
      case 'predict': {
        const session = await sessionFor(msg.voiceId);
        const blob = await session.predict(msg.text);
        const buffer = await blob.arrayBuffer();
        ctx.postMessage({ id: msg.id, ok: true, data: buffer }, [buffer]);
        return;
      }
      case 'download': {
        await tts.download(msg.voiceId, progress => {
          ctx.postMessage({ id: msg.id, progress: { loaded: progress.loaded, total: progress.total } });
        });
        ctx.postMessage({ id: msg.id, ok: true });
        return;
      }
      case 'stored': {
        const ids = await tts.stored();
        ctx.postMessage({ id: msg.id, ok: true, data: ids });
        return;
      }
      case 'remove': {
        sessions.delete(msg.voiceId);
        await tts.remove(msg.voiceId);
        ctx.postMessage({ id: msg.id, ok: true });
        return;
      }
    }
  } catch (err) {
    ctx.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
