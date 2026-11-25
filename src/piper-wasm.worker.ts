/* Piper neural TTS in a Web Worker, for iOS where the Piper helper process
   can't run. Ported from web/src/platform/piper.worker.ts. Voice models are
   downloaded by the library into the Origin Private File System; the ORT and
   phonemizer WASM come from public/voca/ (see scripts/setup-voca.mjs). */

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

// Resolve against the worker's own URL: under tauri://localhost the origin
// can't be trusted to be a usable base.
const asset = (p: string) => new URL(p, self.location.href).href;
const wasmPaths = {
  onnxWasm: asset('/voca/ort/'),
  piperWasm: asset('/voca/piper/piper_phonemize.wasm'),
  piperData: asset('/voca/piper/piper_phonemize.data'),
};

// Loading an ONNX session takes seconds, so keep one per voice.
const sessions = new Map<string, Promise<tts.TtsSession>>();
function sessionFor(voiceId: string): Promise<tts.TtsSession> {
  let s = sessions.get(voiceId);
  if (!s) {
    s = tts.TtsSession.create({ voiceId, wasmPaths });
    s.catch(() => sessions.delete(voiceId));   // let the next request retry
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
        const buffer = await (await session.predict(msg.text)).arrayBuffer();
        ctx.postMessage({ id: msg.id, ok: true, data: buffer }, [buffer]);
        return;
      }
      case 'download':
        await tts.download(msg.voiceId, p => {
          ctx.postMessage({ id: msg.id, progress: { loaded: p.loaded, total: p.total } });
        });
        ctx.postMessage({ id: msg.id, ok: true });
        return;
      case 'stored':
        ctx.postMessage({ id: msg.id, ok: true, data: await tts.stored() });
        return;
      case 'remove':
        sessions.delete(msg.voiceId);
        await tts.remove(msg.voiceId);
        ctx.postMessage({ id: msg.id, ok: true });
        return;
    }
  } catch (err) {
    ctx.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
