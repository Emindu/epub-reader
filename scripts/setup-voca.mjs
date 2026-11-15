// Fetches the assets for the "Tiny Voca" read-aloud engine into public/voca/.
//   node scripts/setup-voca.mjs
// Big files (Pyodide, numpy, onnxruntime wasm, model) are git-ignored; the
// vendored dizione phonemizer sources in public/voca/dizione/ are committed.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'voca');
const nm = join(root, 'node_modules');
const pyVersion = JSON.parse(readFileSync(join(nm, 'pyodide', 'package.json'), 'utf8')).version;

mkdirSync(join(out, 'pyodide'), { recursive: true });
mkdirSync(join(out, 'ort'), { recursive: true });
mkdirSync(join(out, 'model', 'onnx'), { recursive: true });
mkdirSync(join(out, 'model', 'phonemizer'), { recursive: true });

for (const f of ['pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json', 'pyodide.mjs']) {
  copyFileSync(join(nm, 'pyodide', f), join(out, 'pyodide', f));
}
for (const f of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  copyFileSync(join(nm, 'onnxruntime-web', 'dist', f), join(out, 'ort', f));
}

async function download(url, dest, sha256) {
  if (existsSync(dest) && statSync(dest).size > 0) return;
  console.log('download', url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha256 && createHash('sha256').update(buf).digest('hex') !== sha256) throw new Error(`${url}: checksum mismatch`);
  writeFileSync(dest, buf);
}

// numpy wheel for Pyodide (used by the unknown-word model in dizione)
const lock = JSON.parse(readFileSync(join(nm, 'pyodide', 'pyodide-lock.json'), 'utf8'));
const np = lock.packages.numpy;
await download(`https://cdn.jsdelivr.net/pyodide/v${pyVersion}/full/${np.file_name}`, join(out, 'pyodide', np.file_name), np.sha256);
writeFileSync(join(out, 'pyodide', 'numpy.json'), JSON.stringify({ file: np.file_name }));

// model + phonemizer data from Hugging Face (Apache-2.0)
const hf = 'https://huggingface.co/n4ze3m/tiny-voca/resolve/main/';
const files = ['config.json', 'onnx/model.onnx', 'phonemizer/align.json', 'phonemizer/g2p.json', 'phonemizer/g2p.npz',
  'phonemizer/homographs.json', 'phonemizer/lexicon.tsv', 'phonemizer/sources.json', 'phonemizer/LICENSE.cmudict',
  'phonemizer/LICENSE.homograph-data'];
for (const f of files) await download(hf + f, join(out, 'model', f));
console.log('voca assets ready in', out);
