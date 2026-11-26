// Daily reading journal — pure data helpers (no DOM, no Tauri).
//
// What was read is logged automatically while the reader is actively in use
// (time, chapters touched, progress made). Highlights, notes and new words are
// not logged here: they already carry their own timestamps, so the journal
// view collects them by date. Byte-identical in the desktop (src/journal.ts)
// and web (web/src/platform/journal.ts) apps — keep them in sync.

export const KEY_JOURNAL = 'read.journal';

export interface JournalBookDay {
  id: string;
  title: string;
  author: string;
  format: string;
  seconds: number;
  firstAt: number;
  lastAt: number;
  startProgress: number;   // 0..1 when first seen today
  endProgress: number;     // 0..1 latest
  sections: string[];      // chapter / section labels touched, in order
}

export interface JournalDay {
  books: Record<string, JournalBookDay>;
  reflection: string;
  aiReflection?: string;
}

export type Journal = Record<string, JournalDay>;

/** Local calendar day as YYYY-MM-DD (a reading day ends at the reader's midnight, not UTC's). */
export function dayKey(d: Date = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function parseDayKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function shiftDay(key: string, delta: number): string {
  const d = parseDayKey(key);
  d.setDate(d.getDate() + delta);
  return dayKey(d);
}

/** [start, end) of the local day in epoch ms. */
export function dayRange(key: string): [number, number] {
  const start = parseDayKey(key);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [start.getTime(), end.getTime()];
}

export function formatDayLong(key: string): string {
  return parseDayKey(key).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

export function formatDuration(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 1) return seconds >= 15 ? '<1m' : '0m';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export interface BookInfo {
  id: string;
  title: string;
  author: string;
  format: string;
  progress: number;
}

/** Credits `ms` of active reading to the book on the given day, noting the section being read. */
export function recordReading(journal: Journal, key: string, book: BookInfo, section: string, ms: number, now = Date.now()): void {
  const day = (journal[key] ||= { books: {}, reflection: '' });
  const b = (day.books[book.id] ||= {
    id: book.id, title: book.title, author: book.author, format: book.format,
    seconds: 0, firstAt: now, lastAt: now, startProgress: book.progress, endProgress: book.progress, sections: [],
  });
  b.seconds += ms / 1000;
  b.lastAt = now;
  b.endProgress = book.progress;
  b.title = book.title;
  const label = section.trim().slice(0, 120);
  if (label && !b.sections.includes(label) && b.sections.length < 80) b.sections.push(label);
}

/** Seconds read on each of the 7 days ending at `key`, for the week strip. */
export function weekStrip(journal: Journal, key: string): { key: string; label: string; seconds: number }[] {
  const out: { key: string; label: string; seconds: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const k = shiftDay(key, -i);
    const day = journal[k];
    const seconds = day ? Object.values(day.books).reduce((a, b) => a + b.seconds, 0) : 0;
    out.push({ key: k, label: parseDayKey(k).toLocaleDateString(undefined, { weekday: 'short' }), seconds });
  }
  return out;
}

/* ---- Summary of one day (assembled by the app from the journal + marks + vocab) ---- */
export interface DayHighlight { book: string; chapter: string; text: string; }
export interface DayNote { book: string; chapter: string; text: string; }
export interface DayWord { book: string; word: string; definition: string; }

export interface DayExcerpt { book: string; label: string; text: string; truncated: boolean; /** true when logged while reading (read-aloud, focus, selection), not estimated */ exact?: boolean; }

export interface DaySummary {
  key: string;
  books: JournalBookDay[];
  highlights: DayHighlight[];
  notes: DayNote[];
  words: DayWord[];
  totalSeconds: number;
  /** The text that was read, when the export asks for it. */
  excerpts?: DayExcerpt[];
}

const pct = (x: number) => `${Math.round(Math.max(0, Math.min(1, x)) * 100)}%`;

export function progressText(b: JournalBookDay): string {
  const a = pct(b.startProgress), z = pct(b.endProgress);
  return a === z ? `at ${z}` : `${a} → ${z}`;
}

export function summaryMarkdown(s: DaySummary, reflection: string): string {
  const lines: string[] = [`# Reading journal — ${formatDayLong(s.key)}`, ''];
  if (!s.books.length && !s.highlights.length && !s.notes.length && !s.words.length) {
    lines.push('_No reading recorded._', '');
  } else {
    lines.push(`**Time read:** ${formatDuration(s.totalSeconds)} across ${s.books.length} ${s.books.length === 1 ? 'title' : 'titles'}`, '');
  }
  if (s.books.length) {
    lines.push('## What I read', '');
    for (const b of s.books) {
      lines.push(`- **${b.title}**${b.author ? ` — ${b.author}` : ''} · ${formatDuration(b.seconds)} · ${progressText(b)}`);
      if (b.sections.length) lines.push(`  - Sections: ${b.sections.join('; ')}`);
    }
    lines.push('');
  }
  if (s.excerpts?.length) {
    const nExact = s.excerpts.filter(x => x.exact).length;
    const note = nExact === s.excerpts.length
      ? '_The passages I read today (read aloud, in focus mode, or selected)._'
      : nExact === 0
        ? '_Approximate: the chapters / pages / stretch of text covered today._'
        : '_Passages logged while I read, plus approximate coverage where nothing was logged._';
    lines.push('## Text I read', '', note, '');
    for (const x of s.excerpts) {
      lines.push(`### ${x.book}${x.label ? ` — ${x.label}` : ''}`, '');
      for (const para of x.text.split(/\n{2,}/)) {
        const p = para.replace(/\s*\n\s*/g, ' ').trim();
        if (p) lines.push(`> ${p}`, '>');
      }
      if (lines[lines.length - 1] === '>') lines.pop();
      lines.push('');
      if (x.truncated) lines.push('_…shortened to keep the file a manageable size._', '');
    }
  }
  if (s.highlights.length) {
    lines.push('## Highlights', '');
    for (const h of s.highlights) lines.push(`> ${h.text.replace(/\s+/g, ' ').trim()}`, `> — ${h.book}${h.chapter ? ` › ${h.chapter}` : ''}`, '');
  }
  if (s.notes.length) {
    lines.push('## Notes', '');
    for (const n of s.notes) lines.push(`- ${n.text.replace(/\n+/g, ' ')} _(${n.book}${n.chapter ? ` › ${n.chapter}` : ''})_`);
    lines.push('');
  }
  if (s.words.length) {
    lines.push('## New words', '');
    for (const w of s.words) lines.push(`- **${w.word}** — ${w.definition}`);
    lines.push('');
  }
  if (reflection.trim()) lines.push('## Reflection', '', reflection.trim(), '');
  return lines.join('\n').trimEnd() + '\n';
}

/** Prompt for an AI end-of-day reflection. The reader's own draft is included so the model builds on it. */
export function reflectionPrompt(s: DaySummary, draft: string): { system: string; user: string } {
  const system =
    'You are a thoughtful reading companion helping someone reflect at the end of their day. ' +
    'Be warm, specific and brief. Use only what is in their reading log — never invent details about the books. ' +
    'Write in Markdown.';
  const user =
    `Here is my reading log for today.\n\n${summaryMarkdown(s, '')}\n` +
    (draft.trim() ? `My own thoughts so far:\n"""\n${draft.trim()}\n"""\n\n` : '') +
    'Please give me:\n' +
    '1. **Recap** — 2-3 sentences on what I read and what seemed to matter.\n' +
    '2. **Themes & connections** — links between what I read today (and my highlights), if any.\n' +
    '3. **Questions to reflect on** — 3 specific questions drawn from my highlights and notes.\n' +
    '4. **Tomorrow** — one small suggestion for what to read or revisit next.';
  return { system, user };
}

/* ---- The text that was actually read (for the export) ---- */

export function capWords(text: string, maxWords: number): { text: string; truncated: boolean } {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return { text: text.trim(), truncated: false };
  // Keep paragraph breaks for the part we keep: cut the original text at the word boundary.
  let seen = 0;
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  let cut = text.length;
  while ((m = re.exec(text))) {
    if (++seen > maxWords) { cut = m.index; break; }
  }
  return { text: text.slice(0, cut).trim(), truncated: true };
}

/**
 * The part of a text between two reading-progress fractions, widened to at
 * least `minChars` (a pasted note read to 0.5% is still a screenful) and
 * snapped outward to paragraph edges.
 */
export function sliceByProgress(text: string, start: number, end: number, minChars = 3000): string {
  const len = text.length;
  if (!len) return '';
  let a = Math.floor(Math.max(0, Math.min(1, Math.min(start, end))) * len);
  let b = Math.ceil(Math.max(0, Math.min(1, Math.max(start, end))) * len);
  if (b - a < minChars) b = Math.min(len, a + minChars);
  const pa = text.lastIndexOf('\n\n', a);
  if (pa >= 0 && a - pa < 1500) a = pa + 2;
  const pb = text.indexOf('\n\n', b);
  if (pb >= 0 && pb - b < 1500) b = pb;
  else {
    // Next paragraph break is far away: end at the previous one instead of mid-paragraph.
    const prev = text.lastIndexOf('\n\n', b);
    if (prev > a) b = prev;
  }
  return text.slice(a, b).trim();
}

/** A self-contained .md of the day for uploading to an AI chat: front matter + the full log + an editable ask. */
export function exportMarkdown(s: DaySummary, reflection: string): string {
  const q = (t: string) => '"' + t.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const fm = [
    '---',
    'type: reading-journal',
    `date: ${s.key}`,
    `minutes_read: ${Math.round(s.totalSeconds / 60)}`,
    s.books.length ? 'titles:' : 'titles: []',
    ...s.books.map(b => `  - ${q(b.title)}`),
    `highlights: ${s.highlights.length}`,
    `new_words: ${s.words.length}`,
    '---',
    '',
  ];
  const ask = [
    '',
    '## Ask',
    '',
    '_Edit or replace this before sending._ Using the reading log above, help me consolidate what I learned today: ' +
      'summarise the key ideas, connect them to each other, quiz me with a few questions, and point out anything I may have missed or misunderstood.',
    '',
  ];
  return fm.join('\n') + '\n' + summaryMarkdown(s, reflection) + ask.join('\n');
}

/* ---- Exact text read: sentences read aloud / in focus mode, and passages selected ---- */
export const KEY_JOURNAL_TEXT = 'read.journal.text';
export const READ_TEXT_DAY_CAP = 400_000;   // characters kept per day, across all books

export interface ReadSection { label: string; parts: string[]; }
export interface ReadBook { title: string; chars: number; sections: ReadSection[]; }
export type DayReadText = Record<string, ReadBook>;
export type ReadTextStore = Record<string, DayReadText>;

/**
 * Logs a piece of text the reader actually read. Consecutive sentences from the
 * same paragraph are joined into one part; a new paragraph (or a selection)
 * starts a new part. Text already logged is skipped. Returns true if added.
 */
export function addReadText(store: ReadTextStore, key: string, bookId: string, title: string, label: string, text: string, newPara: boolean): boolean {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return false;
  const day = (store[key] ||= {});
  const total = Object.values(day).reduce((a, b) => a + b.chars, 0);
  if (total + t.length > READ_TEXT_DAY_CAP) return false;
  const book = (day[bookId] ||= { title, chars: 0, sections: [] });
  book.title = title;
  const lab = label.trim().slice(0, 120);
  let sec = book.sections.length && book.sections[book.sections.length - 1].label === lab
    ? book.sections[book.sections.length - 1]
    : book.sections.find(x => x.label === lab);
  if (!sec) { sec = { label: lab, parts: [] }; book.sections.push(sec); }
  const recent = sec.parts.slice(-60);
  if (recent.some(p => p.includes(t))) return false;
  const last = sec.parts.length - 1;
  // A selection that contains earlier sentences replaces them rather than repeating them.
  if (newPara || last < 0) sec.parts.push(t);
  else sec.parts[last] += ' ' + t;
  book.chars += t.length + 1;
  return true;
}

/** Drops logged text for days older than keepDays (the day list itself stays in the journal). */
export function pruneReadText(store: ReadTextStore, today: string, keepDays = 45): void {
  const cutoff = shiftDay(today, -keepDays);
  for (const k of Object.keys(store)) if (k < cutoff) delete store[k];
}

export function readBookWords(b: ReadBook): number {
  let n = 0;
  for (const s of b.sections) for (const p of s.parts) n += p.split(/\s+/).filter(Boolean).length;
  return n;
}
