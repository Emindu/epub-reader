/* Tiny Voca text-to-speech worker.
   Text -> phonemes runs the original `dizione` Python package inside Pyodide
   (so the pronunciation rules are exactly the model's training front end);
   phonemes -> audio runs the ONNX model in onnxruntime-web. Everything lives
   in this worker so synthesis never blocks the reader UI. Assets come from
   public/voca (see scripts/setup-voca.mjs). */
import * as ort from 'onnxruntime-web/wasm';
import { createSinhalaFrontend } from './sinhala';

const ctx: any = self;
const SAMPLE_RATE = 24000;
const MAX_TOKENS = 500;          // the model takes up to 512 per call, with start/end tokens
const PAUSE_SAMPLES = Math.round(SAMPLE_RATE * 0.22);

type Lang = 'en' | 'si';
/** One loaded voice model: turns text into token ids, and runs the ONNX graph. */
interface Engine {
  session: ort.InferenceSession;
  phonemize: (text: string) => { ids: number[]; stress: number[] } | null;
}

let base = '';
const engines: Partial<Record<Lang, Engine>> = {};
const initPromises: Partial<Record<Lang, Promise<void>>> = {};

function progress(stage: string, step: number, steps: number): void {
  ctx.postMessage({ type: 'progress', stage, step, steps });
}
const STEPS = 6;
let ortReady = false;
function setupOrt(): void {
  if (ortReady) return;
  ort.env.wasm.wasmPaths = base + 'ort/';
  ort.env.wasm.numThreads = 1;            // no cross-origin isolation in the webview, so no threads
  ortReady = true;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function initEnglish(): Promise<void> {
  const progress = (stage: string, step: number) => ctx.postMessage({ type: 'progress', stage, step, steps: STEPS });
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
  const pyPhonemize = py.globals.get('voca_phonemize');

  progress('Loading voice model', 6);
  setupOrt();
  const model = await fetchBytes(base + 'model/onnx/model.onnx');
  const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
  engines.en = {
    session,
    phonemize: (text) => {
      const json = pyPhonemize(text);
      if (!json) return null;
      const [ids, stress]: [number[], number[]] = JSON.parse(json);
      return { ids, stress };
    },
  };
}

/** Sinhala: eSpeak NG (WebAssembly) for pronunciation + the retrained model. */
async function initSinhala(): Promise<void> {
  const steps = 3;
  progress('Loading Sinhala pronunciation (eSpeak)', 1, steps);
  const mod: any = await import(/* @vite-ignore */ base + 'espeak/espeak-ng.js');
  const espeak = await mod.default();
  const worker = new espeak.eSpeakNGWorker();
  worker.set_voice('si');
  const decoder = new TextDecoder();
  // IPA with "_" between phones, like the phonemizer the model was trained with
  const ipa = (piece: string): string => {
    const start: number = worker.text_to_phonemes(piece, 1).ptr;
    let end = start;
    while (espeak.HEAPU8[end]) end++;
    return decoder.decode(espeak.HEAPU8.subarray(start, end));
  };

  progress('Loading Sinhala voice', 2, steps);
  const meta = await (await fetch(base + 'model-si/meta.json', { cache: 'no-cache' })).json();
  const front = createSinhalaFrontend(meta.symbols);

  progress('Loading Sinhala voice model', 3, steps);
  setupOrt();
  // the training step is in the URL, so a retrained model is never served from the cache
  const session = await ort.InferenceSession.create(await fetchBytes(base + 'model-si/model.onnx?v=' + (meta.step ?? 0)), { executionProviders: ['wasm'] });
  engines.si = { session, phonemize: (text) => front(text, ipa) };
}

function init(lang: Lang): Promise<void> {
  return (initPromises[lang] ??= (lang === 'si' ? initSinhala() : initEnglish()).catch((e) => { delete initPromises[lang]; throw e; }));
}

function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) ?? [text];
  return parts.map(s => s.trim()).filter(Boolean);
}

/** One utterance: audio plus when each token starts (seconds from the utterance start). */
interface Piece { audio: Float32Array; ids: number[]; tokenStarts: number[] }

/** Phonemize and run one utterance; null when there is nothing to pronounce. */
async function runOne(engine: Engine, text: string, voice: number, speed: number): Promise<Piece | null> {
  const p = engine.phonemize(text);
  if (!p) return null;
  const { ids, stress } = p;
  if (ids.length > MAX_TOKENS + 12) return undefined as any;   // caller splits further
  const f32 = (v: number) => new ort.Tensor('float32', Float32Array.of(v), [1]);
  const out = await engine.session.run({
    tokens: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
    stress: new ort.Tensor('int64', BigInt64Array.from(stress, BigInt), [1, ids.length]),
    voice: new ort.Tensor('int64', BigInt64Array.of(BigInt(voice)), [1]),
    speed: f32(speed),
    pitch_shift: f32(0),
    pitch_range: f32(1),
  });
  const audio = new Float32Array((out.audio.data as Float32Array));
  // The model also reports how long each token lasts. Its unit is not assumed:
  // scale the durations so they add up to the audio that actually came out.
  const tokenStarts: number[] = [];
  const dur = out.durations?.data as ArrayLike<number> | undefined;
  if (dur && dur.length >= ids.length) {
    let sum = 0;
    for (let i = 0; i < ids.length; i++) sum += Number(dur[i]);
    const secPerUnit = sum > 0 ? (audio.length / SAMPLE_RATE) / sum : 0;
    let acc = 0;
    for (let i = 0; i < ids.length; i++) { tokenStarts.push(acc * secPerUnit); acc += Number(dur[i]); }
    tokenStarts.push(acc * secPerUnit);
  }
  return { audio, ids, tokenStarts };
}

// Token ids (see dizione/symbols.py): 0-4 specials (4 = unknown phone), 5-16 punctuation, 17+ phones.
const isSpeechToken = (id: number) => id >= 17 || id === 4;

export interface SynthResult {
  audio: Float32Array;
  spoken: Array<[number, number]>;   // [start, end] seconds of each spoken word (a run of phones)
  tokenStarts: number[];             // start second of every token, then the end; whole text
}

async function synth(engine: Engine, text: string, voice: number, speed: number): Promise<SynthResult> {
  const pieces: Float32Array[] = [];
  const spoken: Array<[number, number]> = [];
  const tokenStarts: number[] = [];
  let clock = 0;   // seconds of audio placed so far
  const push = (p: Piece | null) => {
    if (!p) return;
    if (pieces.length) { pieces.push(new Float32Array(PAUSE_SAMPLES)); clock += PAUSE_SAMPLES / SAMPLE_RATE; }
    const ts = p.tokenStarts;
    if (ts.length === p.ids.length + 1) {
      let runStart = -1;
      for (let i = 0; i < p.ids.length; i++) {
        const sp = isSpeechToken(p.ids[i]);
        if (sp && runStart < 0) runStart = i;
        if (runStart >= 0 && (!sp || i === p.ids.length - 1)) {
          const endTok = sp ? i + 1 : i;
          spoken.push([clock + ts[runStart], clock + ts[endTok]]);
          runStart = -1;
        }
      }
      for (let i = 0; i < p.ids.length; i++) tokenStarts.push(clock + ts[i]);
    }
    pieces.push(p.audio);
    clock += p.audio.length / SAMPLE_RATE;
  };
  const whole = await runOne(engine, text, voice, speed);
  if (whole !== undefined) {
    push(whole);
  } else {
    for (const sentence of splitSentences(text)) {
      let a = await runOne(engine, sentence, voice, speed);
      if (a === undefined) {           // one enormous sentence: cut it at commas / words
        const words = sentence.split(/\s+/);
        for (let i = 0; i < words.length; i += 40) push(await runOne(engine, words.slice(i, i + 40).join(' '), voice, speed));
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
  tokenStarts.push(audio.length / SAMPLE_RATE);
  return { audio, spoken, tokenStarts };
}

ctx.onmessage = async (event: MessageEvent) => {
  const msg = event.data;
  try {
    if (msg.type === 'init') {
      base = msg.base;
      await init(msg.lang === 'si' ? 'si' : 'en');
      ctx.postMessage({ type: 'ready', id: msg.id });
    } else if (msg.type === 'synth') {
      const lang: Lang = msg.lang === 'si' ? 'si' : 'en';
      await init(lang);
      const r = await synth(engines[lang]!, msg.text, msg.voice, msg.speed);
      ctx.postMessage({ type: 'audio', id: msg.id, audio: r.audio, spoken: r.spoken, tokenStarts: r.tokenStarts, sampleRate: SAMPLE_RATE }, [r.audio.buffer]);
    }
  } catch (err) {
    ctx.postMessage({ type: 'error', id: msg.id, message: String((err as any)?.message ?? err) });
  }
};
