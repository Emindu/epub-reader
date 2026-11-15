/* Tiny Voca text-to-speech worker.
   Text -> phonemes runs the original `dizione` Python package inside Pyodide
   (so the pronunciation rules are exactly the model's training front end);
   phonemes -> audio runs the ONNX model in onnxruntime-web. Everything lives
   in this worker so synthesis never blocks the reader UI. Assets come from
   public/voca (see scripts/setup-voca.mjs). */
import * as ort from 'onnxruntime-web/wasm';

const ctx: any = self;
const SAMPLE_RATE = 24000;
const MAX_TOKENS = 500;          // the model takes up to 512 per call, with start/end tokens
const PAUSE_SAMPLES = Math.round(SAMPLE_RATE * 0.22);

let base = '';
let session: ort.InferenceSession | null = null;
let phonemize: ((text: string) => string) | null = null;
let initPromise: Promise<void> | null = null;

const STEPS = 6;
function progress(stage: string, step: number): void {
  ctx.postMessage({ type: 'progress', stage, step, steps: STEPS });
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function init(): Promise<void> {
  progress('Loading Python runtime', 1);
  const pyMod: any = await import(/* @vite-ignore */ base + 'pyodide/pyodide.mjs');
  const py: any = await pyMod.loadPyodide({ indexURL: base + 'pyodide/' });

  progress('Loading numpy', 2);
  const { file } = await (await fetch(base + 'pyodide/numpy.json')).json();
  await py.loadPackage(base + 'pyodide/' + file);

  progress('Loading pronunciation rules', 3);
  const files: string[] = await (await fetch(base + 'dizione/files.json')).json();
  for (const f of files) {
    const dest = '/voca/py/dizione/' + f;
    py.FS.mkdirTree(dest.slice(0, dest.lastIndexOf('/')));
    py.FS.writeFile(dest, await fetchBytes(base + 'dizione/' + f));
  }
  progress('Loading dictionary', 4);
  py.FS.mkdirTree('/voca/data');
  for (const f of ['align.json', 'g2p.json', 'g2p.npz', 'homographs.json', 'lexicon.tsv']) {
    py.FS.writeFile('/voca/data/' + f, await fetchBytes(base + 'model/phonemizer/' + f));
  }
  progress('Starting phonemizer', 5);
  py.runPython(`
import sys, os, json
sys.path.insert(0, '/voca/py')
os.environ['DIZIONE_DATA'] = '/voca/data'
import dizione
dizione.get()

def voca_phonemize(text):
    try:
        p = dizione.phonemize(text)
    except ValueError:
        return ''
    return json.dumps([list(p.ids), list(p.stress)])
`);
  phonemize = py.globals.get('voca_phonemize');

  progress('Loading voice model', 6);
  ort.env.wasm.wasmPaths = base + 'ort/';
  ort.env.wasm.numThreads = 1;            // no cross-origin isolation in the webview, so no threads
  const model = await fetchBytes(base + 'model/onnx/model.onnx');
  session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
}

function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) ?? [text];
  return parts.map(s => s.trim()).filter(Boolean);
}

/** Phonemize and run one utterance; null when there is nothing to pronounce. */
async function runOne(text: string, voice: number, speed: number): Promise<Float32Array | null> {
  const json = phonemize!(text);
  if (!json) return null;
  const [ids, stress]: [number[], number[]] = JSON.parse(json);
  if (ids.length > MAX_TOKENS + 12) return undefined as any;   // caller splits further
  const f32 = (v: number) => new ort.Tensor('float32', Float32Array.of(v), [1]);
  const out = await session!.run({
    tokens: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
    stress: new ort.Tensor('int64', BigInt64Array.from(stress, BigInt), [1, ids.length]),
    voice: new ort.Tensor('int64', BigInt64Array.of(BigInt(voice)), [1]),
    speed: f32(speed),
    pitch_shift: f32(0),
    pitch_range: f32(1),
  });
  return new Float32Array((out.audio.data as Float32Array));
}

async function synth(text: string, voice: number, speed: number): Promise<Float32Array> {
  const pieces: Float32Array[] = [];
  const push = (a: Float32Array | null) => {
    if (!a) return;
    if (pieces.length) pieces.push(new Float32Array(PAUSE_SAMPLES));
    pieces.push(a);
  };
  const whole = await runOne(text, voice, speed);
  if (whole !== undefined) {
    push(whole);
  } else {
    for (const sentence of splitSentences(text)) {
      let a = await runOne(sentence, voice, speed);
      if (a === undefined) {           // one enormous sentence: cut it at commas / words
        const words = sentence.split(/\s+/);
        for (let i = 0; i < words.length; i += 40) push(await runOne(words.slice(i, i + 40).join(' '), voice, speed));
        continue;
      }
      push(a);
    }
  }
  let total = 0;
  for (const p of pieces) total += p.length;
  const audio = new Float32Array(total || Math.round(SAMPLE_RATE * 0.15));   // silence if nothing was said
  let at = 0;
  for (const p of pieces) { audio.set(p, at); at += p.length; }
  return audio;
}

ctx.onmessage = async (event: MessageEvent) => {
  const msg = event.data;
  try {
    if (msg.type === 'init') {
      base = msg.base;
      initPromise ??= init();
      await initPromise;
      ctx.postMessage({ type: 'ready', id: msg.id });
    } else if (msg.type === 'synth') {
      await initPromise;
      const audio = await synth(msg.text, msg.voice, msg.speed);
      ctx.postMessage({ type: 'audio', id: msg.id, audio, sampleRate: SAMPLE_RATE }, [audio.buffer]);
    }
  } catch (err) {
    initPromise = msg.type === 'init' ? null : initPromise;
    ctx.postMessage({ type: 'error', id: msg.id, message: String((err as any)?.message ?? err) });
  }
};
