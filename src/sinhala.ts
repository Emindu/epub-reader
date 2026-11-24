/* Sinhala front end for the retrained Tiny Voca model: text -> phoneme tokens.
   A line-for-line port of tiny_voca/sinhala.py + the shared parts of text.py
   (see Sinhala/sinhala.patch). The model only understands tokens produced this
   way, so do not "improve" the rules: any change here makes the voice garbled.
   eSpeak NG itself is injected (it runs as WebAssembly in the worker). */

const SPECIALS = ['<pad>', '<bos>', '<eos>', '<sp>', '<unk>'];
const PUNCTUATION = [',', '.', '?', '!', ';', ':', '"', "'", '(', ')', '—', '…'];
const VOWELS = ['ɐ', 'ə', 'aː', 'i', 'iː', 'u', 'uː', 'e', 'eː', 'o', 'oː', 'æ', 'æː', 'aɪ', 'aʊ'];
const BOS = '<bos>', EOS = '<eos>', SP = '<sp>', UNK = '<unk>';
const STRESS_MARKS: Array<[string, number]> = [['ˈ', 1], ['ˌ', 2]];

const PRENASAL: Record<string, string> = { 'ᵐ|b': 'ᵐb', 'ⁿ|d': 'ⁿd', 'ⁿ|ɖ': 'ⁿɖ', 'ᵑ|ɡ': 'ᵑɡ' };
const FALLBACK: Record<string, string[]> = {
  'ᵐ': ['m'], 'ⁿ': ['n'], 'ᵑ': ['ŋ'], 'a': ['ɐ'], 'ɑ': ['aː'], 'ɑː': ['aː'], 'ɒ': ['o'], 'ɔ': ['o'],
  'ɔː': ['oː'], 'ʌ': ['ɐ'], 'ɪ': ['i'], 'ɛ': ['e'], 'ɜː': ['ə'], 'ɜ': ['ə'], 'ɚ': ['ə'], 'ᵻ': ['i'],
  'ʊ': ['u'], 'oʊ': ['oː'], 'əʊ': ['oː'], 'eɪ': ['eː'], 'ɔɪ': ['o', 'i'], 'iə': ['i', 'ə'],
  'eə': ['e', 'ə'], 'ʊə': ['u', 'ə'], 'ɑːɹ': ['aː', 'ɹ'], 'ɔːɹ': ['oː', 'ɹ'], 'oːɹ': ['oː', 'ɹ'],
  'ɪɹ': ['i', 'ɹ'], 'ɛɹ': ['e', 'ɹ'], 'ʊɹ': ['u', 'ɹ'], 'aɪɚ': ['aɪ', 'ə'], 'aɪə': ['aɪ', 'ə'],
  'əl': ['ə', 'l'], 'n̩': ['ə', 'n'], 'l̩': ['ə', 'l'], 'θ': ['t'], 'ð': ['d'], 'z': ['s'],
  'ʒ': ['dʒ'], 'ɾ': ['ɹ'], 'ʔ': [], 'x': ['k'], 'ç': ['h'], 'ɣ': ['ɡ'], 'ʋ': ['w'],
};
const QUOTES: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '`': "'", '´': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"', '«': '"', '»': '"',
  '–': '—', '―': '—', '[': '(', '{': '(', ']': ')', '}': ')',
};
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'jr', 'sr', 'vs', 'etc']);

type Unit = [string, number];
export interface Phonemized { ids: number[]; stress: number[]; symbols: string[]; unknown: string[] }

/** Does this text read as Sinhala (rather than English)? */
export function isSinhalaText(text: string): boolean {
  let sinhala = 0, letters = 0;
  for (const ch of text) {
    if (/\p{L}/u.test(ch)) { letters++; if (ch >= '඀' && ch <= '෿') sinhala++; }
  }
  return sinhala > 0 && sinhala / letters >= 0.3;
}

function normalizeSinhala(text: string): string {
  return text.normalize('NFC').replace(/[‍‌­﻿]/g, '').replace(/ශ/g, 'ෂ').replace(/෴/g, '.');
}

function normalizeText(text: string): string {
  text = normalizeSinhala(text);
  text = text.normalize('NFKC');
  text = Array.from(text, c => QUOTES[c] ?? c).join('');
  text = text.replace(/\.{3,}/g, '…');
  text = text.replace(/-{2,}|\s-\s/g, '—');
  return text.replace(/\s+/g, ' ').trim();
}

/** Yields [isPunctuation, piece]: digits groups, contractions, abbreviations stay inside the text piece. */
function chunks(text: string): Array<[boolean, string]> {
  const out: Array<[boolean, string]> = [];
  const P = new Set(PUNCTUATION);
  const alnum = (c: string) => !!c && /[\p{L}\p{N}]/u.test(c);
  const alpha = (c: string) => !!c && /\p{L}/u.test(c);
  const digit = (c: string) => !!c && /\p{Nd}/u.test(c);
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!P.has(ch)) continue;
    const prev = i ? text[i - 1] : '';
    const next = i + 1 < text.length ? text[i + 1] : '';
    if (ch === "'" && alnum(prev) && alnum(next)) continue;
    if ('.,:'.includes(ch) && digit(prev) && digit(next)) continue;
    if (ch === '.') {
      const m = /([A-Za-z]+)$/.exec(text.slice(0, i));
      if (m && ABBREVIATIONS.has(m[1].toLowerCase())) continue;
      if (alpha(prev) && alpha(next)) continue;
    }
    if (text.slice(start, i).trim()) out.push([false, text.slice(start, i).trim()]);
    out.push([true, ch]);
    start = i + 1;
  }
  if (text.slice(start).trim()) out.push([false, text.slice(start).trim()]);
  return out;
}

function merge(units: Unit[]): Unit[] {
  const merged: Unit[] = [];
  for (let i = 0; i < units.length; i++) {
    const [phone, stress] = units[i];
    const next = units[i + 1];
    if (next && PRENASAL[phone + '|' + next[0]]) {
      merged.push([PRENASAL[phone + '|' + next[0]], stress || next[1]]);
      i++;
    } else merged.push([phone, stress]);
  }
  return merged;
}

/** Words of one eSpeak output line as lists of [phone, stress]. */
function parse(output: string): Unit[][] {
  const words: Unit[][] = [];
  for (const word of output.split(/\s+/).filter(Boolean)) {
    const units: Unit[] = [];
    for (let unit of word.split('_')) {
      let stress = 0;
      for (const [mark, level] of STRESS_MARKS) {
        if (unit.includes(mark)) { stress = stress || level; unit = unit.split(mark).join(''); }
      }
      unit = unit.replace(/\([a-z-]+\)/g, '').replace(/\p{Cf}/gu, '');
      if (unit) units.push([unit, stress]);
    }
    if (units.length) words.push(merge(units));
  }
  return words;
}

export function createSinhalaFrontend(symbols: string[]) {
  const idOf = new Map(symbols.map((s, i) => [s, i] as const));
  const phones = new Set(symbols.slice(SPECIALS.length + PUNCTUATION.length));
  const vowels = new Set(VOWELS);

  const splitUnit = (unit: string): string[] | null => {
    const pieces: string[] = [];
    let rest = unit;
    while (rest) {
      let hit = false;
      for (let size = Math.min(4, rest.length); size > 0; size--) {
        if (phones.has(rest.slice(0, size))) { pieces.push(rest.slice(0, size)); rest = rest.slice(size); hit = true; break; }
      }
      if (!hit) return null;
    }
    return pieces;
  };
  const canonical = (phone: string): string[] | null => {
    if (phones.has(phone)) return [phone];
    if (FALLBACK[phone]) return FALLBACK[phone];
    const stripped = phone.normalize('NFD').replace(/[̀-ͯ]/g, '');
    for (const c of [stripped, stripped.replace(/ː/g, '')]) {
      if (phones.has(c)) return [c];
      if (FALLBACK[c]) return FALLBACK[c];
    }
    return splitUnit(phone) ?? splitUnit(stripped);
  };

  /** `espeak(piece)` must return eSpeak's IPA with "_" between phones and " " between words. */
  return function phonemize(text: string, espeak: (piece: string) => string): Phonemized | null {
    const out: string[] = [BOS], stress: number[] = [0], unknown: string[] = [];
    const isPhone = (s: string) => phones.has(s) || s === UNK;
    for (const [punct, piece] of chunks(normalizeText(text))) {
      if (punct) {
        if (out[out.length - 1] !== piece) { out.push(piece); stress.push(0); }
        continue;
      }
      for (const word of parse(espeak(piece))) {
        if (isPhone(out[out.length - 1])) { out.push(SP); stress.push(0); }
        for (const [phone, level] of word) {
          let mapped = canonical(phone);
          if (!mapped) { unknown.push(phone); mapped = [UNK]; }
          let carrier = mapped.findIndex(m => vowels.has(m));
          if (carrier < 0) carrier = 0;
          mapped.forEach((m, i) => { out.push(m); stress.push(i === carrier ? level : 0); });
        }
      }
    }
    out.push(EOS); stress.push(0);
    if (!out.some(isPhone)) return null;     // nothing to pronounce
    return { ids: out.map(s => idOf.get(s)!), stress, symbols: out, unknown };
  };
}
