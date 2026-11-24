# Task: run the trained Sinhala tiny-voca TTS model on this Windows PC

You are setting up a small Sinhala text-to-speech model (tiny-voca, 4.5M parameters,
trained on Kaggle) so it can turn Sinhala text into a WAV file on CPU. Follow the
steps in order and run every "Check" command. Do not skip the line-ending setting
in step 2: without it the patch will not apply on Windows.

## What the user gives you

| File | Where it came from | Purpose |
|---|---|---|
| `tiny-voca-si.pt` (18.2 MB) | Kaggle notebook `tiny-voca-sinhala-2-train`, Output → `model/` | The trained model |
| `tiny-voca-si.onnx` + `tiny-voca-si.json` (optional) | same folder | ONNX version for apps |
| `sinhala.patch` | from the chat | Adds Sinhala support to tiny-voca |

Ask the user where these files are if you can't find them (usually `Downloads`).
Voices in the model: `M1` (male, best quality) and `F1` (female, less training data).

## 1. Prerequisites

- Git for Windows and Python 3.10–3.13 (64-bit). Check: `git --version` and `python --version`.
- About 2 GB of disk space (mostly PyTorch). No GPU is needed.

## 2. Get tiny-voca at the exact version and apply the patch

The patch was made for commit `70759ac61104d021c7f498e32c12f4979511bfa4`. Clone with
`core.autocrlf=false`; Windows' default CRLF conversion makes `git apply` fail with
"patch does not apply".

```powershell
cd $HOME
git -c core.autocrlf=false clone https://github.com/n4ze3m/tiny-voca.git tiny-voca-si
cd tiny-voca-si
git config core.autocrlf false
git checkout 70759ac61104d021c7f498e32c12f4979511bfa4
git apply --check "$HOME\Downloads\sinhala.patch"
git apply "$HOME\Downloads\sinhala.patch"
```

Check: `git status --short` lists `src/tiny_voca/sinhala.py`, `scripts/sinhala_data.py`,
`docs/sinhala.md` and `tests/test_frontend_sinhala.py` as new files.

If `git apply --check` still fails, the patch file itself got CRLF line endings
(for example by opening and saving it in an editor). Re-download it, or try
`git apply --ignore-whitespace`.

## 3. Create a virtual environment and install

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install -e ".[si]"
pip install onnxruntime    # only needed for the ONNX route in step 7
```

If PowerShell blocks `Activate.ps1`, run
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or use
`.\.venv\Scripts\activate.bat` from cmd.

`.[si]` installs `phonemizer-fork==3.3.2` and `espeakng-loader==0.2.4`. The second
ships the eSpeak NG library for Windows; no separate eSpeak install is needed.
**Keep these exact versions.** The model only accepts phonemes from the same front end,
and inference refuses to run if they differ.

## 4. Set the environment variables (every new terminal)

```powershell
$env:TINY_VOCA_LANGUAGE = "si"   # switches tiny-voca from English to Sinhala
$env:PYTHONUTF8 = "1"            # lets Python print Sinhala/IPA text on Windows
```

(cmd: `set TINY_VOCA_LANGUAGE=si` and `set PYTHONUTF8=1`.)
Both must be set **before** Python starts or `tiny_voca` is imported.

Check: run the Sinhala front-end tests. Expected: `Ran 13 tests ... OK`.

```powershell
python -m unittest discover -s tests -p test_frontend_sinhala.py
```

## 5. Generate speech from the command line

Put the model somewhere stable first, e.g. `mkdir models; copy "$HOME\Downloads\tiny-voca-si.pt" models\`.

Write the text to a UTF-8 file. This is safer on Windows than passing Sinhala on
the command line:

```powershell
Set-Content -Encoding utf8 hello.txt "ආයුබෝවන්! ඔබට කොහොමද? මම හෙට උදේ කොළඹට යනවා."
python -m tiny_voca.infer --checkpoint models\tiny-voca-si.pt --voice M1 --text-file hello.txt --output hello.wav
```

Check: the command prints the phonemes of each sentence (for example
`<bos> aː j u b oː w ə n ! ...`) and `Saved X.XXs in N utterances`. `hello.wav` plays
Sinhala speech.

Options: `--voice M1|F1`, `--speed 1.0` (higher is faster), `--pitch-shift 0`
(0.058 ≈ one semitone), `--pitch-range 1.0`, `--text "..."` instead of `--text-file`.
Long text is fine: it is split into sentences.

## 6. Use it from Python

```python
import os
os.environ["TINY_VOCA_LANGUAGE"] = "si"   # before importing tiny_voca
import soundfile as sf
from tiny_voca.infer import load_model, speak_text

model = load_model("models/tiny-voca-si.pt", device="cpu")   # load once, reuse
print(model.config.speakers)                                   # ('M1', 'F1')
wave, spoken = speak_text(model, "ශ්‍රී ලංකාව සුන්දර රටකි.", voice="M1", speed=1.0)
sf.write("out.wav", wave.numpy(), model.config.sample_rate)    # 24 kHz mono
```

`speak_text` raises `tiny_voca.text.NothingToPronounce` when the text has nothing
readable (only emoji or symbols, for example).

## 7. Optional: ONNX (no PyTorch needed at run time)

Text still has to be turned into phoneme ids with `tiny_voca.text.phonemize`, so the
patched tiny-voca and `.[si]` stay installed. Only the model itself runs in ONNX Runtime.

```python
import json, os
os.environ["TINY_VOCA_LANGUAGE"] = "si"
import numpy as np, onnxruntime as ort, soundfile as sf
from tiny_voca.text import phonemize, frontend_fingerprint

meta = json.load(open("models/tiny-voca-si.json", encoding="utf-8"))
assert meta["frontend_fingerprint"] == frontend_fingerprint(), "front end differs from training"
session = ort.InferenceSession("models/tiny-voca-si.onnx", providers=["CPUExecutionProvider"])

p = phonemize("ශ්‍රී ලංකාව සුන්දර රටකි.")    # one sentence per call
feeds = {
    "tokens": np.array([p.ids], dtype=np.int64),
    "stress": np.array([p.stress], dtype=np.int64),
    "voice": np.array([meta["voices"].index("M1")], dtype=np.int64),
    "speed": np.array([1.0], np.float32),
    "pitch_shift": np.array([0.0], np.float32),
    "pitch_range": np.array([1.0], np.float32),
}
audio, durations = session.run(["audio", "durations"], feeds)
sf.write("out_onnx.wav", np.clip(audio[0], -0.99, 0.99), meta["sample_rate"])
```

The ONNX graph speaks one utterance at a time (up to 512 tokens / about 32 s of
audio). For long text, split it into sentences and join the audio, as
`speak_text` does.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `patch does not apply` | CRLF line endings: redo step 2 with `core.autocrlf=false` |
| `checkpoint was trained with a different phoneme inventory/front end` | `TINY_VOCA_LANGUAGE=si` not set before Python started, or different `phonemizer-fork`/`espeakng-loader` versions: reinstall `pip install -e ".[si]"` |
| `vocab_size must equal the phoneme inventory size` | Same: the env var is missing, so the English inventory was loaded |
| `UnicodeEncodeError` | Set `PYTHONUTF8=1` (step 4) |
| `the Sinhala front end needs: pip install ...` | Run `pip install -e ".[si]"` inside the activated venv |
| `--voice must be one of M1, F1` | Use `M1` or `F1` (case-sensitive) |
| `tiny-voca only reads Sinhala script with this model` | The text contained nothing pronounceable |

## Notes for the agent

- Do not change `src/tiny_voca/sinhala.py`, the symbol list, or the pinned
  versions. Any change to the front end makes the trained model unusable.
- Pronunciation comes from eSpeak NG's Sinhala rules plus fixes in `sinhala.py`.
  If the user reports a mispronounced word, look at `phonemize(text).symbols`
  first and report it rather than editing the inventory.
- Licences: tiny-voca code is Apache-2.0; eSpeak NG and the Path Nirvana training
  voices are GPL-3.0, and the speakers allow only non-obscene, non-offensive speech.
  That's fine for personal use; flag it before the model goes into a distributed product.
