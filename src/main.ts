import { open } from '@tauri-apps/plugin-dialog';
import { readFile, writeFile, mkdir, remove, exists, BaseDirectory } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { openPath } from '@tauri-apps/plugin-opener';
import ePub, { Book, Rendition, Location, NavItem } from 'epubjs';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { marked } from 'marked';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;


/* ============================================================
   Types
   ============================================================ */
type Theme = 'default' | 'flexoki' | 'ayu' | 'catppuccin' | 'everforest' | 'gruvbox' | 'nord' | 'rosepine' | 'solarized';
type Appearance = 'light' | 'dark';
type FontKind = 'serif' | 'sans' | 'mono';
type LineKind = 'compact' | 'normal' | 'relaxed';
type MarginKind = 'narrow' | 'medium' | 'wide';
type LayoutKind = 'paginated' | 'spread' | 'scroll';
type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink';
type FocusTracker = 'off' | 'word' | 'sentence';
export type BookFormat = 'epub' | 'pdf' | 'txt' | 'md';

interface Settings {
  theme: Theme;
  appearance: Appearance;
  font: FontKind;
  sizePct: number;
  line: LineKind;
  margin: MarginKind;
  layout: LayoutKind;
  focusTracker: FocusTracker;
  lastHighlightColor: HighlightColor;
  focusModeWpm: number;
}

interface BookRecord {
  id: string;
  title: string;
  author: string;
  identifier?: string;             // EPUB dc:identifier — stable across renames/moves
  filePath: string;                // original path on disk (for reference / re-locate)
  storedRelPath?: string;          // path inside AppData (self-owned copy)
  coverDataUrl: string | null;
  lastCfi: string | null;
  progress: number;
  addedAt: number;
  updatedAt: number;
  format?: BookFormat;
}

interface Bookmark {
  cfi: string;
  text: string;
  chapter: string;
  createdAt: number;
}

interface Highlight {
  cfi: string;
  color: HighlightColor;
  text: string;
  chapter: string;
  createdAt: number;
}

interface BookMarks {
  bookmarks: Bookmark[];
  highlights: Highlight[];
}

interface ReadingStats {
  streakDays: number;
  lastReadDate: string;
  todayMins: number;
  todayDate: string;
  pagesRead: number;
}

interface VocabWord {
  word: string;               // lowercased canonical form
  displayWord: string;        // as looked up (preserves case for display)
  definition: string;         // HTML-safe short definition body
  phonetic?: string;
  chapter: string;
  // Sentence the word was captured from — displayed on review cards so
  // recall benefits from the original passage instead of a stripped word.
  context?: string;
  createdAt: number;
  reviewCount: number;
  ease: number;               // SM-2 ease factor, starts at 2.5
  interval: number;           // days until next review, starts at 0
  dueAt: number;              // ms timestamp — when the card next comes due
  lastReviewedAt?: number;
}

interface VocabJournal {
  words: VocabWord[];
}

/* ============================================================
   Storage
   ============================================================ */
const KEY_SETTINGS = 'read.settings';
const KEY_LIBRARY = 'read.library';
const KEY_MARKS = (id: string) => `read.marks.${id}`;
const KEY_LOCATIONS = (id: string) => `read.locations.${id}`;
const KEY_VOCAB = (id: string) => `read.vocab.${id}`;
const KEY_VOCAB_STATS = 'read.vocab.stats';
const KEY_TTS = 'read.tts';

// Maximum new (unreviewed) cards introduced per day across all books.
// Above this, new cards wait until tomorrow so the review pile doesn't
// snowball after a heavy lookup session.
const NEW_CARDS_PER_DAY_CAP = 10;

interface VocabDailyStats {
  date: string;             // 'YYYY-MM-DD' — cap resets when this rolls over
  newCardsIntroduced: number;
}

const DEFAULT_SETTINGS: Settings = {
  theme: 'default',
  appearance: 'light',
  font: 'serif',
  sizePct: 100,
  line: 'normal',
  margin: 'medium',
  layout: 'paginated',
  focusTracker: 'off',
  lastHighlightColor: 'yellow',
  focusModeWpm: 300,
};

const load = <T>(k: string, fallback: T): T => {
  try { const raw = localStorage.getItem(k); return raw ? JSON.parse(raw) as T : fallback; }
  catch { return fallback; }
};
const save = (k: string, v: unknown) => localStorage.setItem(k, JSON.stringify(v));

let settings: Settings = { ...DEFAULT_SETTINGS, ...load<Partial<Settings>>(KEY_SETTINGS, {}) };

// Migrate legacy theme settings
if (['light', 'sepia', 'dark'].includes(settings.theme as any)) {
  settings.appearance = (settings.theme as string) === 'dark' ? 'dark' : 'light';
  settings.theme = 'default';
  save(KEY_SETTINGS, settings);
}

let library: BookRecord[] = load<BookRecord[]>(KEY_LIBRARY, []);

const persistSettings = () => save(KEY_SETTINGS, settings);
const persistLibrary = () => save(KEY_LIBRARY, library);

const KEY_STATS = 'read.stats';
let stats = load<ReadingStats>(KEY_STATS, {
  streakDays: 0, lastReadDate: '', todayMins: 0, todayDate: '', pagesRead: 0
});
const persistStats = () => save(KEY_STATS, stats);

/* ============================================================
   Reader runtime state
   ============================================================ */
let currentBook: Book | null = null;
let currentRendition: Rendition | null = null;
let currentPdfBlobUrl: string | null = null;
let currentTextElement: HTMLDivElement | null = null;
let activeFormat: BookFormat = 'epub';
let currentBookRecord: BookRecord | null = null;
let currentMarks: BookMarks = { bookmarks: [], highlights: [] };
let currentVocab: VocabJournal = { words: [] };
let flatToc: { href: string; label: string }[] = [];
let currentChapterLabel = '';
let currentLocationCfi: string | null = null;
let hideChromeTimer: number | undefined;

function getBookFormat(recordOrPath: BookRecord | string): BookFormat {
  const path = typeof recordOrPath === 'string' ? recordOrPath : (recordOrPath.filePath || recordOrPath.storedRelPath || '');
  const lower = path.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.txt')) return 'txt';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'md';
  return 'epub';
}

function generateTextCoverDataUrl(title: string, format: BookFormat): string {
  const canvas = document.createElement('canvas');
  canvas.width = 300;
  canvas.height = 440;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  const grad = ctx.createLinearGradient(0, 0, 300, 440);
  if (format === 'md') {
    grad.addColorStop(0, '#2b303b');
    grad.addColorStop(1, '#1e222a');
  } else {
    grad.addColorStop(0, '#3a3d40');
    grad.addColorStop(1, '#242729');
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 300, 440);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 12;
  ctx.strokeRect(6, 6, 288, 428);

  ctx.fillStyle = format === 'md' ? '#61afef' : '#98c379';
  ctx.font = 'bold 14px sans-serif';
  ctx.fillText(format.toUpperCase(), 30, 50);

  ctx.fillStyle = '#ffffff';
  ctx.font = '600 20px sans-serif';
  const words = title.split(' ');
  let line = '';
  let y = 140;
  for (const word of words) {
    const testLine = line + word + ' ';
    if (ctx.measureText(testLine).width > 240 && line !== '') {
      ctx.fillText(line, 30, y);
      line = word + ' ';
      y += 30;
      if (y > 360) break;
    } else {
      line = testLine;
    }
  }
  if (y <= 360) ctx.fillText(line, 30, y);

  return canvas.toDataURL('image/png');
}

/* ============================================================
   Element lookups
   ============================================================ */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  html: document.documentElement,
  libraryEmpty: $<HTMLDivElement>('library-empty'),
  libraryGrid: $<HTMLDivElement>('library-grid'),
  libraryCount: $<HTMLSpanElement>('library-count'),
  importBtn: $<HTMLButtonElement>('import-btn'),
  importBtnEmpty: $<HTMLButtonElement>('import-btn-empty'),
  libraryThemeBtn: $<HTMLButtonElement>('library-theme-btn'),
  libraryVocabReviewBtn: $<HTMLButtonElement>('library-vocab-review-btn'),
  libraryVocabCount: $<HTMLSpanElement>('library-vocab-count'),

  readerTopbar: $<HTMLElement>('reader-topbar'),
  readerBottombar: $<HTMLElement>('reader-bottombar'),
  bookTitle: $<HTMLSpanElement>('reader-book-title'),
  backBtn: $<HTMLButtonElement>('back-to-library-btn'),
  tocBtn: $<HTMLButtonElement>('toc-btn'),
  bookmarkBtn: $<HTMLButtonElement>('bookmark-btn'),
  typographyBtn: $<HTMLButtonElement>('typography-btn'),
  themeBtn: $<HTMLButtonElement>('theme-btn'),

  viewer: $<HTMLDivElement>('viewer'),
  prevBtn: $<HTMLButtonElement>('prev-btn'),
  nextBtn: $<HTMLButtonElement>('next-btn'),

  progressTrack: $<HTMLDivElement>('progress-track'),
  progressFill: $<HTMLDivElement>('progress-fill'),
  progressThumb: $<HTMLDivElement>('progress-thumb'),
  progressChapter: $<HTMLSpanElement>('progress-chapter'),
  progressPercent: $<HTMLSpanElement>('progress-percent'),
  progressRemaining: $<HTMLSpanElement>('progress-remaining'),

  tocDrawer: $<HTMLElement>('toc-drawer'),
  closeTocBtn: $<HTMLButtonElement>('close-toc-btn'),
  tocList: $<HTMLUListElement>('toc-list'),
  bookmarksList: $<HTMLUListElement>('bookmarks-list'),
  highlightsList: $<HTMLUListElement>('highlights-list'),

  typographyDrawer: $<HTMLElement>('typography-drawer'),
  closeTypographyBtn: $<HTMLButtonElement>('close-typography-btn'),
  sizeValue: $<HTMLSpanElement>('size-value'),

  selectionPopover: $<HTMLDivElement>('selection-popover'),
  popoverRemove: $<HTMLButtonElement>('popover-remove'),

  toast: $<HTMLDivElement>('toast'),

  statsStreak: $<HTMLSpanElement>('stats-streak'),
  statsMins: $<HTMLSpanElement>('stats-mins'),

  dictPopover: $<HTMLDivElement>('dict-popover'),
  dictWord: $<HTMLHeadingElement>('dict-word'),
  dictPhonetic: $<HTMLSpanElement>('dict-phonetic'),
  dictMeanings: $<HTMLDivElement>('dict-meanings'),
  dictAiBtn: $<HTMLButtonElement>('dict-ai-btn'),
  dictAiOutput: $<HTMLDivElement>('dict-ai-output'),

  footnotePopover: $<HTMLDivElement>('footnote-popover'),
  footnoteContent: $<HTMLDivElement>('footnote-content'),

  dictClose: $<HTMLButtonElement>('dict-close'),
  footnoteClose: $<HTMLButtonElement>('footnote-close'),

  focusModeBtn: $<HTMLButtonElement>('focus-mode-btn'),
  focusPanel: $<HTMLDivElement>('focus-panel'),
  focusToggleBtn: $<HTMLButtonElement>('focus-toggle'),
  focusPrevBtn: $<HTMLButtonElement>('focus-prev'),
  focusNextBtn: $<HTMLButtonElement>('focus-next'),
  focusCloseBtn: $<HTMLButtonElement>('focus-close'),
  focusIconPlay: document.getElementById('focus-icon-play') as unknown as SVGSVGElement,
  focusIconPause: document.getElementById('focus-icon-pause') as unknown as SVGSVGElement,
  focusSpeedSlider: $<HTMLInputElement>('focus-speed-slider'),
  focusWpmLabel: $<HTMLSpanElement>('focus-wpm'),

  openSettingsBtn: $<HTMLButtonElement>('open-settings-btn'),
  closeSettingsBtn: $<HTMLButtonElement>('close-settings-btn'),
  settingsModal: $<HTMLDivElement>('settings-modal'),
  appearanceSelect: $<HTMLSelectElement>('appearance-select'),

  // Vocabulary Journal
  vocabPanel: $<HTMLDivElement>('vocab-panel'),
  vocabList: $<HTMLUListElement>('vocab-list'),
  vocabCount: $<HTMLSpanElement>('vocab-count'),
  vocabDueCount: $<HTMLSpanElement>('vocab-due'),
  vocabReviewBtn: $<HTMLButtonElement>('vocab-review-btn'),
  vocabReviewModal: $<HTMLDivElement>('vocab-review-modal'),
  vocabReviewProgress: $<HTMLParagraphElement>('vocab-review-progress'),
  vocabReviewEmpty: $<HTMLDivElement>('vocab-review-empty'),
  vocabCard: $<HTMLDivElement>('vocab-review-card'),
  vocabCardWord: $<HTMLHeadingElement>('vocab-card-word'),
  vocabCardPhonetic: $<HTMLSpanElement>('vocab-card-phonetic'),
  vocabCardContext: $<HTMLQuoteElement>('vocab-card-context'),
  vocabCardChapter: $<HTMLSpanElement>('vocab-card-chapter'),
  vocabCardBack: $<HTMLDivElement>('vocab-card-back'),
  vocabCardDefinition: $<HTMLDivElement>('vocab-card-definition'),
  vocabRevealActions: $<HTMLDivElement>('vocab-review-actions-reveal'),
  vocabRateActions: $<HTMLDivElement>('vocab-review-actions-rate'),
  vocabRevealBtn: $<HTMLButtonElement>('vocab-reveal-btn'),
  vocabHintAgain: $<HTMLSpanElement>('vocab-hint-again'),
  vocabHintGood: $<HTMLSpanElement>('vocab-hint-good'),
  vocabHintEasy: $<HTMLSpanElement>('vocab-hint-easy'),
  closeVocabReviewBtn: $<HTMLButtonElement>('close-vocab-review-btn'),

  // Read-aloud (TTS)
  ttsBtn: $<HTMLButtonElement>('tts-btn'),
  ttsPanel: $<HTMLDivElement>('tts-panel'),
  ttsToggleBtn: $<HTMLButtonElement>('tts-toggle'),
  ttsPrevBtn: $<HTMLButtonElement>('tts-prev'),
  ttsNextBtn: $<HTMLButtonElement>('tts-next'),
  ttsCloseBtn: $<HTMLButtonElement>('tts-close'),
  ttsIconPlay: document.getElementById('tts-icon-play') as unknown as SVGSVGElement,
  ttsIconPause: document.getElementById('tts-icon-pause') as unknown as SVGSVGElement,
  ttsRateSlider: $<HTMLInputElement>('tts-rate-slider'),
  ttsRateLabel: $<HTMLSpanElement>('tts-rate-label'),
  ttsVoiceSelect: $<HTMLSelectElement>('tts-voice'),
  ttsEngineSelect: $<HTMLSelectElement>('tts-engine'),
  ttsSetupBtn: $<HTMLButtonElement>('tts-setup'),
  ttsNaturalRateLabel: $<HTMLLabelElement>('tts-natural-rate-label'),
  ttsNaturalRate: $<HTMLInputElement>('tts-natural-rate'),
  ttsCacheBtn: $<HTMLButtonElement>('tts-cache-btn'),

  piperSetupModal: $<HTMLDivElement>('piper-setup-modal'),
  closePiperSetupBtn: $<HTMLButtonElement>('close-piper-setup-btn'),
  piperBinaryStatus: $<HTMLDivElement>('piper-binary-status'),
  piperVoicesStatus: $<HTMLDivElement>('piper-voices-status'),
  piperPath: $<HTMLParagraphElement>('piper-path'),
  piperOpenFolderBtn: $<HTMLButtonElement>('piper-open-folder-btn'),
  piperRefreshBtn: $<HTMLButtonElement>('piper-refresh-btn'),
  piperInstallBinaryBtn: $<HTMLButtonElement>('piper-install-binary-btn'),
  piperCancelBinaryBtn: $<HTMLButtonElement>('piper-cancel-binary-btn'),
  piperBinaryProgress: $<HTMLDivElement>('piper-binary-progress'),
  piperVoiceCatalog: $<HTMLUListElement>('piper-voice-catalog'),
  piperErrorBanner: $<HTMLDivElement>('piper-error-banner'),
  piperErrorBody: $<HTMLPreElement>('piper-error-body'),
  piperErrorDismiss: $<HTMLButtonElement>('piper-error-dismiss'),
};

function hideAllPopovers() {
  hideSelectionPopover();
  hideDictPopover();
  hideFootnotePopover();
}

/* ============================================================
   Rendition reflow — module scope so it can be reset from openReader
   without racing the ResizeObserver's initial-fire path.

   Two things must happen for reflow to be correct:
     1. `rendition.resize()` — updates epub.js's cached viewport dims.
     2. `rendition.display(currentCfi)` — forces the paginated manager to
        re-lay out the current section against the new column geometry.
        Without this, columns keep the widths they were computed at during
        the initial display, so after minimize/restore the content
        overflows or scales incorrectly.

   We skip no-op reflows: `focus` / `visibilitychange` fire without the
   window actually being resized. But minimize→restore keeps the same outer
   dims, so we track `wasMinimized` explicitly to force a redisplay on
   that specific case.

   `resetReflowTracking` is called from `openReader` before goToScreen so
   that a new book starts fresh — otherwise the previous book's baseline
   makes the first-observation branch decide wrong for the new one.
   ============================================================ */
let resizeRaf: number | undefined;
let lastReflowW = 0;
let lastReflowH = 0;
let wasMinimized = false;

function resetReflowTracking(): void {
  lastReflowW = 0;
  lastReflowH = 0;
  wasMinimized = false;
  if (resizeRaf) { cancelAnimationFrame(resizeRaf); resizeRaf = undefined; }
}

function requestReflow(): void {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = undefined;
    if (!currentRendition) return;
    const stage = el.viewer.getBoundingClientRect();

    if (stage.width < 20 || stage.height < 20) {
      // Actually minimized / hidden — remember so we redisplay on restore.
      wasMinimized = true;
      return;
    }

    // Pass the CONTENT-box dimensions (stage minus padding) to
    // rendition.resize — not the padding-box from getBoundingClientRect.
    //
    // Initial `renderTo({ width: '100%', height: '100%' })` is a flex
    // percentage and correctly resolves to content-box. But
    // `rendition.resize(w, h)` switches epub.js to explicit pixel sizing,
    // and if we pass padding-box pixels the iframe grows to the full
    // viewer box — its top edge lands at y=0 (under the topbar), and text
    // bleeds through the chrome. Subtracting padding here makes the
    // resize-path behavior match the initial render.
    const style = getComputedStyle(el.viewer);
    const padL = parseFloat(style.paddingLeft) || 0;
    const padR = parseFloat(style.paddingRight) || 0;
    const padT = parseFloat(style.paddingTop) || 0;
    const padB = parseFloat(style.paddingBottom) || 0;
    const w = Math.round(stage.width - padL - padR);
    const h = Math.round(stage.height - padT - padB);
    // 8px change threshold — below that we're catching sub-pixel jitter
    // and browser-rounding artifacts that shouldn't force a full redisplay.
    // The floating panel toggle changes size by ~100px, real window resizes
    // by tens or hundreds, so we won't miss anything meaningful.
    const sizeChanged = Math.abs(w - lastReflowW) >= 8 || Math.abs(h - lastReflowH) >= 8;
    const restoring = wasMinimized;
    wasMinimized = false;

    if (!sizeChanged && !restoring) return;

    // First observation for this book — capture baseline. openReader()
    // already displayed at the current CFI against the (now-visible)
    // viewer, so we don't need to redisplay. Just record and bail.
    const isFirstObservation = lastReflowW === 0 && lastReflowH === 0;
    lastReflowW = w;
    lastReflowH = h;
    if (isFirstObservation) return;

    try {
      // Note: we do NOT stop focus mode / TTS here even though their word
      // coordinates go stale on resize. Turning either mode on toggles a
      // CSS class that changes `.viewer`'s padding, which fires the
      // ResizeObserver, which lands us here — if we stopped them we'd
      // form a feedback loop that kills the mode right after startup.
      // Both modes already refresh their word list when they detect an
      // iframe swap on the next tick (focusTick, cached rAF, piper rAF),
      // so the display() below fixing the layout is enough.
      currentRendition.resize(w, h);
      if (currentLocationCfi) {
        currentRendition.display(currentLocationCfi).catch(() => {});
      }
      hideAllPopovers();
      updateProgress();
    } catch (err) { console.error('Reflow failed:', err); }
  });
}

/* ============================================================
   Toast
   ============================================================ */
let toastTimer: number | undefined;
function toast(message: string) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el.toast.hidden = true; }, 1800);
}

/* ============================================================
   Screen routing
   ============================================================ */
function goToScreen(name: 'library' | 'reader') {
  el.html.dataset.screen = name;
  if (name === 'library') {
    el.html.dataset.chrome = 'visible';
    renderLibrary();
  }
}

/* ============================================================
   Theme / Settings
   ============================================================ */
const FONT_MAP: Record<FontKind, string> = {
  serif: "'Newsreader', 'Georgia', serif",
  sans:  "'Inter', -apple-system, sans-serif",
  mono:  "'JetBrains Mono', monospace",
};
const MIN_FONT_PCT = 70;
const MAX_FONT_PCT = 300;
const FONT_STEP = 10;
const LINE_MAP: Record<LineKind, number> = { compact: 1.4, normal: 1.65, relaxed: 1.95 };
const MARGIN_MAP: Record<MarginKind, string> = { narrow: '2rem', medium: '5rem', wide: '8rem' };

function applyGlobalTheme() {
  el.html.dataset.theme = settings.theme;
  el.html.dataset.appearance = settings.appearance;
  // Highlight overlays live in each iframe and cache their color from
  // --accent — invalidate + repaint so a theme flip is felt everywhere.
  refreshHighlightColors();
}

function applyReaderSettings() {
  el.html.style.setProperty('--reader-line', String(LINE_MAP[settings.line]));
  el.html.style.setProperty('--reader-margin', MARGIN_MAP[settings.margin]);
  el.html.style.setProperty('--reader-size', `${(1.0625 * settings.sizePct / 100).toFixed(3)}rem`);

  if (currentTextElement) {
    currentTextElement.style.fontFamily = FONT_MAP[settings.font];
  }
  // Native PDF iframe manages its own theme; no override needed.

  if (!currentRendition) return;

  const computed = getComputedStyle(el.html);
  const colors = {
    bg: computed.getPropertyValue('--bg').trim(),
    text: computed.getPropertyValue('--text').trim(),
    accent: computed.getPropertyValue('--accent').trim(),
    muted: computed.getPropertyValue('--text-muted').trim()
  };
  
  const fontStack = FONT_MAP[settings.font];
  const lineHeight = LINE_MAP[settings.line];

  currentRendition.themes.override('color', colors.text, true);
  currentRendition.themes.override('background', colors.bg, true);

  currentRendition.themes.register('reader', {
    'body': {
      'background': `${colors.bg} !important`,
      'color': `${colors.text} !important`,
      'font-family': `${fontStack} !important`,
      'line-height': `${lineHeight} !important`,
      'padding': '0 !important',
    },
    'p, li, blockquote, td': {
      'font-family': `${fontStack} !important`,
      'line-height': `${lineHeight} !important`,
      'color': `${colors.text} !important`,
    },
    'h1, h2, h3, h4, h5, h6': {
      'font-family': `${fontStack} !important`,
      'color': `${colors.text} !important`,
      'font-weight': '500',
      'letter-spacing': '-0.015em',
    },
    'a': { 'color': `${colors.accent} !important`, 'text-decoration': 'none' },
    'blockquote': {
      'border-left': `3px solid ${colors.accent}`,
      'padding-left': '1rem',
      'color': `${colors.muted} !important`,
      'font-style': 'italic',
    },
    'img': { 'max-width': '100% !important', 'height': 'auto !important' },
    'code, pre': { 'font-family': "'JetBrains Mono', monospace !important" },
    '::selection': { 'background': `${colors.accent}33` },
  });
  currentRendition.themes.select('reader');
  currentRendition.themes.fontSize(`${settings.sizePct}%`);

  refreshTypographyUI();
}

function refreshTypographyUI() {
  document.querySelectorAll<HTMLButtonElement>('[data-control] button').forEach(btn => {
    const group = btn.closest('[data-control]') as HTMLElement | null;
    if (!group) return;
    const control = group.dataset.control;
    let match = false;
    if (control === 'theme')  match = btn.dataset.value === settings.theme;
    if (control === 'font')   match = btn.dataset.value === settings.font;
    if (control === 'line')   match = btn.dataset.value === settings.line;
    if (control === 'margin') match = btn.dataset.value === settings.margin;
    if (control === 'layout') match = btn.dataset.value === settings.layout;
    if (control === 'focusTracker') match = btn.dataset.value === settings.focusTracker;
    btn.classList.toggle('active', match);
  });
  el.sizeValue.textContent = `${settings.sizePct}%`;
}

const MARGIN_ORDER: MarginKind[] = ['narrow', 'medium', 'wide'];
const LINE_ORDER: LineKind[] = ['compact', 'normal', 'relaxed'];

function bumpFontSize(delta: number) {
  const next = Math.max(MIN_FONT_PCT, Math.min(MAX_FONT_PCT, settings.sizePct + delta));
  if (next === settings.sizePct) return;
  settings.sizePct = next;
  persistSettings();
  applyReaderSettings();
  toast(`Text size ${settings.sizePct}%`);
}

function bumpMargin(step: 1 | -1) {
  const idx = MARGIN_ORDER.indexOf(settings.margin);
  const next = Math.max(0, Math.min(MARGIN_ORDER.length - 1, idx + step));
  if (next === idx) return;
  settings.margin = MARGIN_ORDER[next];
  persistSettings();
  applyReaderSettings();
  toast(`Margins: ${settings.margin}`);
}

function cycleLineHeight() {
  const idx = LINE_ORDER.indexOf(settings.line);
  settings.line = LINE_ORDER[(idx + 1) % LINE_ORDER.length];
  persistSettings();
  applyReaderSettings();
  const label = settings.line === 'compact' ? 'Packed' : settings.line === 'relaxed' ? 'Spaced' : 'Normal';
  toast(`Line spacing: ${label}`);
}

function cycleTheme() {
  settings.appearance = settings.appearance === 'light' ? 'dark' : 'light';
  applyGlobalTheme();
  applyReaderSettings();
  persistSettings();
  toast(`Appearance: ${settings.appearance[0].toUpperCase() + settings.appearance.slice(1)}`);
}

/* ============================================================
   Library rendering
   ============================================================ */
function renderLibrary() {
  const count = library.length;
  el.libraryCount.textContent = count === 0 ? '' : `${count} book${count === 1 ? '' : 's'}`;

  refreshLibraryVocabButton();

  if (count === 0) {
    el.libraryEmpty.hidden = false;
    el.libraryGrid.hidden = true;
    return;
  }

  el.libraryEmpty.hidden = true;
  el.libraryGrid.hidden = false;
  el.libraryGrid.innerHTML = '';

  const sorted = [...library].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const book of sorted) {
    el.libraryGrid.appendChild(renderBookCard(book));
  }
}

// Update the aggregated due count on the library-header review button. Hides
// the button when nothing is due so the header stays uncluttered when the
// user has no pending reviews.
function refreshLibraryVocabButton(): void {
  const dueTotal = loadAllDueVocab().length;
  const capped = applyDailyCap(loadAllDueVocab()).length;
  el.libraryVocabReviewBtn.hidden = dueTotal === 0;
  // Show the ACTUAL reviewable count (post-cap) so the reader knows exactly
  // how many they can do today; the button itself does no work with the
  // over-cap remainder.
  el.libraryVocabCount.textContent = `${capped}`;
  el.libraryVocabReviewBtn.title = dueTotal > capped
    ? `${capped} of ${dueTotal} due — the rest wait until tomorrow (${NEW_CARDS_PER_DAY_CAP}/day cap)`
    : `${capped} card${capped === 1 ? '' : 's'} due for review`;
}

function renderBookCard(book: BookRecord): HTMLElement {
  const card = document.createElement('div');
  card.className = 'book-card' + (book.progress > 0 ? ' has-progress' : '');

  const cover = document.createElement('div');
  cover.className = 'book-cover' + (book.coverDataUrl ? '' : ' placeholder');
  if (book.coverDataUrl) {
    const img = document.createElement('img');
    img.src = book.coverDataUrl;
    img.alt = book.title;
    cover.appendChild(img);
  } else {
    const t = document.createElement('div');
    t.className = 'placeholder-title';
    t.textContent = book.title;
    cover.appendChild(t);
  }

  const fmt = book.format || getBookFormat(book);
  const badge = document.createElement('span');
  badge.className = `book-format-badge format-${fmt}`;
  badge.textContent = fmt.toUpperCase();
  cover.appendChild(badge);

  if (book.progress > 0) {
    const ring = document.createElement('div');
    ring.className = 'book-progress-ring';
    ring.textContent = `${Math.round(book.progress * 100)}%`;
    cover.appendChild(ring);
  }

  const remove = document.createElement('button');
  remove.className = 'book-remove';
  remove.title = 'Remove from library';
  remove.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
  remove.addEventListener('click', (e) => {
    e.stopPropagation();
    removeBook(book.id);
  });
  cover.appendChild(remove);

  const meta = document.createElement('div');
  meta.className = 'book-meta';
  const title = document.createElement('div');
  title.className = 'book-title';
  title.textContent = book.title;
  const author = document.createElement('div');
  author.className = 'book-author';
  author.textContent = book.author || 'Unknown';
  meta.appendChild(title);
  meta.appendChild(author);

  if (book.progress > 0) {
    const bar = document.createElement('div');
    bar.className = 'book-progress-bar';
    const fill = document.createElement('span');
    fill.style.width = `${Math.round(book.progress * 100)}%`;
    bar.appendChild(fill);
    meta.appendChild(bar);
  }

  card.appendChild(cover);
  card.appendChild(meta);

  card.addEventListener('click', () => openFromLibrary(book));

  return card;
}

function removeBook(id: string) {
  const rec = library.find(b => b.id === id);
  library = library.filter(b => b.id !== id);
  localStorage.removeItem(KEY_MARKS(id));
  localStorage.removeItem(KEY_LOCATIONS(id));
  localStorage.removeItem(KEY_VOCAB(id));
  persistLibrary();
  renderLibrary();
  if (rec?.storedRelPath) {
    const path = rec.storedRelPath;
    remove(path, { baseDir: BaseDirectory.AppData })
      .catch(err => console.warn(`removeBook: could not delete ${path}:`, err));
  }
  // Best-effort cache cleanup so removed books don't leave ~50MB WAVs
  // scattered under AppData.
  invoke('piper_cache_delete_book', { bookId: id })
    .catch(err => console.warn(`removeBook: cache cleanup failed: ${err}`));
  toast('Removed from library');
}

/* ============================================================
   Importing a book — copy into AppData so we own the bytes for good.
   Tauri's fs scope grant from the file-picker dialog only survives the
   current session, so relying on the original absolute path breaks on
   the next launch. Owning our own copy sidesteps that entirely.
   ============================================================ */
const BOOKS_DIR = 'books';

async function ensureBooksDir() {
  try {
    if (!(await exists(BOOKS_DIR, { baseDir: BaseDirectory.AppData }))) {
      await mkdir(BOOKS_DIR, { baseDir: BaseDirectory.AppData, recursive: true });
    }
  } catch (err) {
    console.error('ensureBooksDir failed:', err);
  }
}

async function adoptIntoAppData(record: BookRecord, bytes: Uint8Array): Promise<void> {
  try {
    await ensureBooksDir();
    const fmt = record.format || getBookFormat(record);
    const rel = `${BOOKS_DIR}/${record.id}.${fmt}`;
    await writeFile(rel, bytes, { baseDir: BaseDirectory.AppData });
    record.storedRelPath = rel;
    record.updatedAt = Date.now();
    persistLibrary();
  } catch (err) {
    console.warn('Could not copy book into AppData:', err);
  }
}

async function readBookBytes(record: BookRecord): Promise<Uint8Array> {
  // 1) Preferred: our own copy in AppData (survives across launches).
  if (record.storedRelPath) {
    try {
      const bytes = await readFile(record.storedRelPath, { baseDir: BaseDirectory.AppData });
      if (bytes && bytes.byteLength > 0) return bytes;
      console.warn('AppData copy was empty; falling back to original path');
    } catch (err) {
      console.warn('AppData copy missing / unreadable, falling back to original:', err);
    }
  }
  // 2) Fallback: read from the original path (only works during the session
  //    the file was picked, unless a broader scope is granted).
  const bytes = await readFile(record.filePath);
  // 3) Try to adopt into AppData so this hopefully doesn't happen again.
  await adoptIntoAppData(record, bytes);
  return bytes;
}

// Prompt the user to re-locate a missing book. Reuses the record's id so
// bookmarks/highlights survive the re-pointing.
async function relocateBook(record: BookRecord): Promise<Uint8Array | null> {
  const picked = await open({
    multiple: false,
    title: `Locate "${record.title}"`,
    filters: [
      { name: 'Supported Books & Documents', extensions: ['epub', 'pdf', 'txt', 'md', 'markdown'] },
      { name: 'EPUB Books', extensions: ['epub'] },
      { name: 'PDF Documents', extensions: ['pdf'] },
      { name: 'Text & Markdown Files', extensions: ['txt', 'md', 'markdown'] }
    ],
  });
  if (!picked || typeof picked !== 'string') return null;
  const bytes = await readFile(picked);
  record.filePath = picked;
  await adoptIntoAppData(record, bytes);
  return bytes;
}

async function importBook() {
  try {
    const selected = await open({
      multiple: false,
      filters: [
        { name: 'Supported Books & Documents', extensions: ['epub', 'pdf', 'txt', 'md', 'markdown'] },
        { name: 'EPUB Books', extensions: ['epub'] },
        { name: 'PDF Documents', extensions: ['pdf'] },
        { name: 'Text & Markdown Files', extensions: ['txt', 'md', 'markdown'] }
      ]
    });
    if (!selected || typeof selected !== 'string') return;

    const filePath = selected;
    // Fast path: exact filePath match. Skip reading bytes if we already have this file.
    let existing = library.find(b => b.filePath === filePath);
    if (existing) {
      openFromLibrary(existing);
      return;
    }

    const fileData = await readFile(filePath);            // dialog scope-grant is valid here
    const format = getBookFormat(filePath);
    const id = safeUuid();

    let title = filePath.split(/[\\/]/).pop() || 'Untitled';
    let author = '';
    let identifier: string | undefined = undefined;
    let coverDataUrl: string | null = null;

    if (format === 'epub') {
      const tempBook = ePub(fileData.buffer as any);
      await tempBook.ready;
      const meta = await tempBook.loaded.metadata;
      identifier = (meta as any).identifier || undefined;

      if (identifier) {
        existing = library.find(b => b.identifier === identifier);
        if (existing) {
          if (existing.filePath !== filePath) {
            existing.filePath = filePath;
            persistLibrary();
          }
          tempBook.destroy();
          openFromLibrary(existing);
          return;
        }
      }
      title = meta.title || title;
      author = (meta.creator as unknown as string) || '';
      try {
        const coverUrl = await tempBook.coverUrl();
        if (coverUrl) coverDataUrl = await urlToDataUrl(coverUrl);
      } catch { /* no cover */ }
      tempBook.destroy();
    } else if (format === 'pdf') {
      try {
        const loadingTask = pdfjsLib.getDocument({ data: fileData });
        const pdfDoc = await loadingTask.promise;
        const pdfMeta = await pdfDoc.getMetadata().catch(() => null);
        const info = (pdfMeta?.info as any) || {};
        title = info.Title || title.replace(/\.pdf$/i, '');
        author = info.Author || '';

        const page1 = await pdfDoc.getPage(1);
        const viewport = page1.getViewport({ scale: 0.6 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          await page1.render({ canvasContext: ctx, viewport, canvas }).promise;
          coverDataUrl = canvas.toDataURL('image/jpeg', 0.85);
        }
      } catch (err) {
        console.warn('PDF metadata read error:', err);
      }
    } else if (format === 'txt' || format === 'md') {
      const textContent = new TextDecoder('utf-8').decode(fileData);
      const cleanFileName = title.replace(/\.(txt|md|markdown)$/i, '');
      if (format === 'md') {
        const h1Match = textContent.match(/^#\s+(.+)$/m);
        title = h1Match ? h1Match[1].trim() : cleanFileName;
        author = 'Markdown Document';
      } else {
        title = cleanFileName;
        author = 'Text Document';
      }
      coverDataUrl = generateTextCoverDataUrl(title, format);
    }

    await ensureBooksDir();
    const rel = `${BOOKS_DIR}/${id}.${format}`;
    await writeFile(rel, fileData, { baseDir: BaseDirectory.AppData });

    const record: BookRecord = {
      id,
      title,
      author,
      identifier,
      filePath,
      storedRelPath: rel,
      coverDataUrl,
      lastCfi: null,
      progress: 0,
      addedAt: Date.now(),
      updatedAt: Date.now(),
      format,
    };
    library.push(record);
    persistLibrary();

    openFromLibrary(record);
  } catch (err) {
    console.error(err);
    toast('Could not open that file');
  }
}

function safeUuid(): string {
  const c = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback for very old runtimes.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Detect library entries whose storedRelPath collides with another entry's
// (a symptom of the old hashPath collision bug). We can't know which record
// actually owns the bytes on disk, so drop storedRelPath from every entry
// but the most-recently-updated one. The stripped entries fall back to the
// original path and, failing that, the built-in re-locate flow.
function repairColliding(): void {
  const byPath = new Map<string, BookRecord[]>();
  for (const b of library) {
    if (!b.storedRelPath) continue;
    const arr = byPath.get(b.storedRelPath) ?? [];
    arr.push(b);
    byPath.set(b.storedRelPath, arr);
  }
  let changed = false;
  for (const group of byPath.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => b.updatedAt - a.updatedAt);   // newest first
    for (let i = 1; i < group.length; i++) {
      console.warn(`[library] "${group[i].title}" shared bytes with "${group[0].title}" — will prompt to re-locate`);
      group[i].storedRelPath = undefined;
      changed = true;
    }
  }
  if (changed) persistLibrary();
}
repairColliding();

async function urlToDataUrl(url: string): Promise<string> {
  const blob = await fetch(url).then(r => r.blob());
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/* ============================================================
   Opening a book into the reader
   ============================================================ */
async function openFromLibrary(record: BookRecord) {
  try {
    const fileData = await readBookBytes(record);
    await openReader(record, fileData.buffer as ArrayBuffer);
    return;
  } catch (err) {
    console.error('First open attempt failed:', err);
  }

  // Nothing worked. Offer to re-locate the file rather than making the user
  // dig back to the library and re-import.
  toast(`Locate "${record.title}"…`);
  try {
    const bytes = await relocateBook(record);
    if (!bytes) return;                // user cancelled the picker
    await openReader(record, bytes.buffer as ArrayBuffer);
  } catch (err) {
    console.error('Re-locate failed:', err);
    toast(`Still couldn't open "${record.title}". Remove and re-add it.`);
  }
}

function cleanupCurrentReader() {
  if (currentBook) {
    try { currentBook.destroy(); } catch {}
    currentBook = null;
    currentRendition = null;
  }
  if (currentPdfBlobUrl) {
    URL.revokeObjectURL(currentPdfBlobUrl);
    currentPdfBlobUrl = null;
  }
  currentTextElement = null;
  el.viewer.innerHTML = '';
  delete document.documentElement.dataset.format;
  // Clear the reading position so a ResizeObserver-driven requestReflow that
  // fires during the next book's load can't replay THIS book's CFI against the
  // new rendition. A cross-book CFI won't resolve, and the continuous manager
  // scrolls to an empty region — the "book opens then disappears" blank. The
  // new book's first `relocated` repopulates this; until then requestReflow's
  // `if (currentLocationCfi)` guard skips display() and only resizes.
  currentLocationCfi = null;
}

function renderTocNodes(tocItems: { href: string; label: string }[]) {
  el.tocList.innerHTML = '';
  for (const item of tocItems) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.className = 'toc-item';
    a.textContent = item.label;
    a.href = '#';
    a.dataset.href = item.href;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const targetEl = document.getElementById(item.href);
      if (targetEl) targetEl.scrollIntoView({ behavior: 'smooth' });
      closeDrawers();
    });
    li.appendChild(a);
    el.tocList.appendChild(li);
  }
}

async function openPdfReader(record: BookRecord, buffer: ArrayBuffer) {
  // Create a Blob URL so the WebView2 (Chromium) built-in PDF viewer handles rendering.
  // This is identical to Chrome/Edge's PDF viewer — instant, native zoom/search/selection.
  const blob = new Blob([buffer], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  currentPdfBlobUrl = url;

  const container = document.createElement('div');
  container.className = 'pdf-reader-container';
  container.id = 'pdf-container';
  el.viewer.appendChild(container);

  const iframe = document.createElement('iframe');
  iframe.className = 'pdf-native-iframe';
  iframe.src = url;
  iframe.title = record.title;
  container.appendChild(iframe);

  // Minimal TOC: just a single "Document" entry since the native viewer
  // handles its own page navigation internally.
  flatToc = [{ href: 'pdf-doc', label: record.title }];
  renderTocNodes(flatToc);
  el.progressChapter.textContent = record.title;
}



async function openTextReader(record: BookRecord, buffer: ArrayBuffer) {
  const container = document.createElement('div');
  container.className = 'text-reader-container';
  container.id = 'text-container';
  el.viewer.appendChild(container);
  currentTextElement = container;

  const rawText = new TextDecoder('utf-8').decode(buffer);
  const fmt = record.format || getBookFormat(record);

  let renderedHtml = '';
  if (fmt === 'md') {
    renderedHtml = marked.parse(rawText) as string;
  } else {
    const paragraphs = rawText.split(/\n\s*\n/);
    renderedHtml = paragraphs
      .map(p => `<p>${escapeHtml(p.trim())}</p>`)
      .join('');
  }

  container.innerHTML = renderedHtml;

  flatToc = [];
  const headings = container.querySelectorAll<HTMLHeadingElement>('h1, h2, h3, h4');
  headings.forEach((h, idx) => {
    const id = `heading-${idx}`;
    h.id = id;
    flatToc.push({ href: id, label: h.textContent || `Section ${idx + 1}` });
  });
  renderTocNodes(flatToc);

  if (record.progress > 0) {
    setTimeout(() => {
      const totalScroll = container.scrollHeight - container.clientHeight;
      container.scrollTop = record.progress * totalScroll;
    }, 100);
  }

  container.addEventListener('scroll', () => {
    const totalScroll = container.scrollHeight - container.clientHeight;
    if (totalScroll <= 0) return;
    const pct = Math.min(1, Math.max(0, container.scrollTop / totalScroll));
    record.progress = pct;
    record.lastCfi = `scroll-${pct.toFixed(4)}`;

    el.progressPercent.textContent = `${Math.round(pct * 100)}%`;
    el.progressFill.style.width = `${pct * 100}%`;
    persistLibrary();
  });
}

async function openEpubReader(record: BookRecord, buffer: ArrayBuffer) {
  currentBook = ePub(buffer as any);

  let flow = 'paginated';
  let spread = 'none';
  if (settings.layout === 'spread') { spread = 'auto'; }
  else if (settings.layout === 'scroll') { flow = 'scrolled'; }

  currentRendition = currentBook.renderTo('viewer', {
    width: '100%',
    height: '100%',
    spread: spread,
    manager: 'continuous',
    flow: flow,
    allowScriptedContent: false,
  });

  currentRendition.on('relocated', (loc: Location) => {
    currentLocationCfi = loc.start.cfi;
    updateChapterFromCfi(loc.start.href);
    updateProgress();
    refreshBookmarkButton();
    if (currentBookRecord) {
      currentBookRecord.lastCfi = loc.start.cfi;
      currentBookRecord.updatedAt = Date.now();
      const cb = currentBook;
      if (cb && cb.locations && (cb.locations as any).total) {
        currentBookRecord.progress = cb.locations.percentageFromCfi(loc.start.cfi);
      }
      persistLibrary();
    }
    const newKey = sectionKeyFromHref(loc.start.href);
    if (newKey !== currentSectionKey) {
      currentSectionKey = newKey;
      refreshCacheButtonForCurrentSection();
    }
  });

  currentRendition.on('selected', onSelected);
  currentRendition.on('click', () => hideSelectionPopover());
  currentRendition.on('relocated', () => hideSelectionPopover());
  currentRendition.hooks.content.register((contents: any) => {
    const doc: Document = contents.document;
    doc.addEventListener('selectionchange', () => {
      const sel = doc.getSelection();
      if (!sel || sel.isCollapsed || sel.toString().trim() === '') {
        hideSelectionPopover();
        hideDictPopover();
        hideFootnotePopover();
      }
    });
    doc.addEventListener('scroll', () => { hideSelectionPopover(); hideDictPopover(); hideFootnotePopover(); }, true);
    doc.addEventListener('mousedown', () => { hideSelectionPopover(); hideDictPopover(); hideFootnotePopover(); });
    doc.addEventListener('click', () => { hideSelectionPopover(); hideDictPopover(); hideFootnotePopover(); });
    doc.addEventListener('touchstart', () => { hideSelectionPopover(); hideDictPopover(); hideFootnotePopover(); }, { passive: true });
    doc.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        hideAllPopovers();
      }
    }, true);

    doc.addEventListener('click', (e: MouseEvent) => {
      const a = (e.target as Element).closest('a');
      if (a && a.getAttribute('href')) {
        const href = a.getAttribute('href');
        if (href && (href.startsWith('#') || a.getAttribute('epub:type') === 'noteref' || a.textContent?.match(/^[\d\*\[\]]+$/))) {
          e.preventDefault();
          e.stopPropagation();
          showFootnote(href, e.clientX, e.clientY);
        }
      }
    }, true);

    installFocusTracker(contents);

    // Underline any saved-vocab words on the freshly-loaded section. The
    // overlay is body-relative so paginated column turns within the
    // section keep the markers aligned automatically.
    renderVocabHighlightsForDoc(contents.document);
  });

  await currentRendition.display(record.lastCfi || undefined);

  currentBook.loaded.navigation.then((nav) => {
    flatToc = [];
    flatTocFromNav(nav.toc);
    renderToc(nav.toc);
  });

  currentBook.ready.then(async () => {
    const book = currentBook;
    if (!book) return;
    const cached = localStorage.getItem(KEY_LOCATIONS(record.id));
    if (cached) {
      try {
        (book.locations as any).load(cached);
        updateProgress();
        return;
      } catch (err) {
        console.warn('Cached locations failed to load, regenerating:', err);
      }
    }
    try {
      await book.locations.generate(1600);
      const serialized = (book.locations as any).save?.();
      if (typeof serialized === 'string') {
        localStorage.setItem(KEY_LOCATIONS(record.id), serialized);
      }
    } catch (err) {
      console.warn('locations.generate failed:', err);
    }
    updateProgress();
  });
}

async function openReader(record: BookRecord, buffer: ArrayBuffer) {
  cleanupCurrentReader();

  currentBookRecord = record;
  activeFormat = record.format || getBookFormat(record);
  currentMarks = load<BookMarks>(KEY_MARKS(record.id), { bookmarks: [], highlights: [] });
  currentVocab = loadVocab(record.id);

  // Drive CSS selectors (viewer overflow, padding, etc.) per format.
  document.documentElement.dataset.format = activeFormat;

  // Switch to the reader screen BEFORE the format-specific opener calls
  // `rendition.display()`. Otherwise .reader-screen is still `display:none`
  // (which we do to hide the library), .viewer has zero dimensions, and
  // epub.js paginates the first section against 0-width columns. The
  // subsequent ResizeObserver-triggered redisplay then re-lays out on the
  // real dims — which is exactly the flicker on every book open. Doing it
  // in this order means .viewer is measurable before display() runs.
  el.bookTitle.textContent = record.title;
  goToScreen('reader');
  resetReflowTracking();
  // One layout tick so .viewer's box picks up the display change before
  // renderTo() reads its dimensions.
  await new Promise<void>(r => requestAnimationFrame(() => r()));

  if (activeFormat === 'pdf') {
    await openPdfReader(record, buffer);
  } else if (activeFormat === 'txt' || activeFormat === 'md') {
    await openTextReader(record, buffer);
  } else {
    await openEpubReader(record, buffer);
  }

  applyReaderSettings();
  refreshBookmarkButton();

  reapplyHighlights();
  startChromeAutoHide();
  startReadingStats();
}

function flatTocFromNav(items: NavItem[]) {
  for (const it of items) {
    flatToc.push({ href: it.href, label: it.label.trim() });
    if (it.subitems && it.subitems.length) flatTocFromNav(it.subitems);
  }
}

function updateChapterFromCfi(href: string) {
  const clean = href.split('#')[0];
  const match = flatToc.find(t => t.href.split('#')[0] === clean) || flatToc[0];
  currentChapterLabel = match?.label || '';
  el.progressChapter.textContent = currentChapterLabel;

  document.querySelectorAll<HTMLAnchorElement>('#toc-list .toc-item').forEach(a => {
    a.classList.toggle('current', a.dataset.href?.split('#')[0] === clean);
  });
}

function updateProgress() {
  if (!currentRendition || !currentBook) return;
  const loc = currentRendition.currentLocation() as any;
  if (!loc || !loc.start) return;
  const pct = currentBook.locations.percentageFromCfi(loc.start.cfi);
  if (!Number.isFinite(pct)) return;
  el.progressFill.style.width = `${pct * 100}%`;
  el.progressThumb.style.left = `${pct * 100}%`;
  el.progressPercent.textContent = `${Math.round(pct * 100)}%`;

  const total = (currentBook.locations as any).length?.() ?? 0;
  const current = (currentBook.locations as any).locationFromCfi(loc.start.cfi) ?? 0;
  if (total > 0) {
    const remainingLocations = total - current;
    const remainingMin = Math.max(1, Math.round(remainingLocations * 0.35));
    el.progressRemaining.textContent = `${remainingMin} min left`;
  } else {
    el.progressRemaining.textContent = '';
  }
}

/* ============================================================
   TOC / Bookmarks / Highlights drawer
   ============================================================ */
function renderToc(items: NavItem[]) {
  el.tocList.innerHTML = '';
  const build = (nodes: NavItem[], parent: HTMLElement) => {
    for (const n of nodes) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.className = 'toc-item';
      a.textContent = n.label.trim();
      a.href = '#';
      a.dataset.href = n.href;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        currentRendition?.display(n.href);
        closeDrawers();
      });
      li.appendChild(a);
      if (n.subitems && n.subitems.length) {
        const ul = document.createElement('ul');
        build(n.subitems, ul);
        li.appendChild(ul);
      }
      parent.appendChild(li);
    }
  };
  build(items, el.tocList);
}

function renderBookmarksList() {
  el.bookmarksList.innerHTML = '';
  if (currentMarks.bookmarks.length === 0) {
    el.bookmarksList.innerHTML = '<div class="mark-empty">No bookmarks yet.<br>Tap the ribbon icon while reading.</div>';
    return;
  }
  for (const b of currentMarks.bookmarks) {
    const li = document.createElement('li');
    li.className = 'mark-item';
    li.innerHTML = `
      <div class="mark-preview">${escapeHtml(b.text || '(no preview)')}</div>
      <div class="mark-chapter">${escapeHtml(b.chapter)}</div>
    `;
    li.addEventListener('click', () => { currentRendition?.display(b.cfi); closeDrawers(); });
    el.bookmarksList.appendChild(li);
  }
}

function renderHighlightsList() {
  el.highlightsList.innerHTML = '';
  if (currentMarks.highlights.length === 0) {
    el.highlightsList.innerHTML = '<div class="mark-empty">No highlights yet.<br>Select text while reading.</div>';
    return;
  }
  const colorHex: Record<HighlightColor, string> = {
    yellow: '#fde68a', green: '#bbf7d0', blue: '#bfdbfe', pink: '#fbcfe8',
  };
  for (const h of currentMarks.highlights) {
    const li = document.createElement('li');
    li.className = 'mark-item';
    li.innerHTML = `
      <span class="mark-color" style="background:${colorHex[h.color]}"></span>
      <div class="mark-preview" style="padding-left:0.75rem">${escapeHtml(h.text)}</div>
      <div class="mark-chapter" style="padding-left:0.75rem">${escapeHtml(h.chapter)}</div>
    `;
    li.addEventListener('click', () => { currentRendition?.display(h.cfi); closeDrawers(); });
    el.highlightsList.appendChild(li);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
}

/* ============================================================
   Drawer open/close + tab switching
   ============================================================ */
function openDrawer(which: 'toc' | 'typography', tab?: DrawerTab) {
  closeDrawers();
  if (which === 'toc') {
    el.tocDrawer.hidden = false;
    requestAnimationFrame(() => el.tocDrawer.classList.add('open'));
    switchTab(tab || 'toc');
  } else {
    el.typographyDrawer.hidden = false;
    requestAnimationFrame(() => el.typographyDrawer.classList.add('open'));
    refreshTypographyUI();
  }
}

type DrawerTab = 'toc' | 'bookmarks' | 'highlights' | 'vocab';

function closeDrawers() {
  [el.tocDrawer, el.typographyDrawer].forEach(d => {
    if (!d.classList.contains('open')) return;
    d.classList.remove('open');
    setTimeout(() => { d.hidden = true; }, 260);
  });
}

function switchTab(tab: DrawerTab) {
  document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  el.tocList.hidden = tab !== 'toc';
  el.bookmarksList.hidden = tab !== 'bookmarks';
  el.highlightsList.hidden = tab !== 'highlights';
  el.vocabPanel.hidden = tab !== 'vocab';
  if (tab === 'bookmarks') renderBookmarksList();
  if (tab === 'highlights') renderHighlightsList();
  if (tab === 'vocab') renderVocabList();
}

/* ============================================================
   Bookmarks
   ============================================================ */
function toggleBookmark() {
  if (!currentRendition || !currentBookRecord || !currentLocationCfi) return;
  const cfi = currentLocationCfi;
  const idx = currentMarks.bookmarks.findIndex(b => b.cfi === cfi);
  if (idx >= 0) {
    currentMarks.bookmarks.splice(idx, 1);
    toast('Bookmark removed');
  } else {
    const preview = getVisiblePreviewText();
    currentMarks.bookmarks.push({
      cfi, text: preview, chapter: currentChapterLabel, createdAt: Date.now(),
    });
    toast('Bookmarked');
  }
  save(KEY_MARKS(currentBookRecord.id), currentMarks);
  refreshBookmarkButton();
}

function refreshBookmarkButton() {
  const active = currentLocationCfi != null && currentMarks.bookmarks.some(b => b.cfi === currentLocationCfi);
  el.bookmarkBtn.classList.toggle('active', active);
}

function getVisiblePreviewText(): string {
  try {
    const iframes = el.viewer.querySelectorAll('iframe');
    for (const f of iframes) {
      const doc = (f as HTMLIFrameElement).contentDocument;
      if (!doc) continue;
      const text = (doc.body?.innerText || '').trim().replace(/\s+/g, ' ');
      if (text) return text.slice(0, 160);
    }
  } catch { /* cross-origin edge */ }
  return '';
}

/* ============================================================
   Focus tracker — hover-highlight word / sentence under cursor,
   click to persist as a highlight in the last-used color.
   ============================================================ */
const WORD_CHAR = /[\p{L}\p{N}'’\-]/u;

function installFocusTracker(contents: any) {
  const doc: Document = contents.document;
  if (!doc.body) return;

  const overlay = doc.createElement('div');
  overlay.setAttribute('data-focus-overlay', '');
  const rgb = accentRgbTuple();
  overlay.style.cssText = [
    'position:absolute',
    'pointer-events:none',
    `background:rgba(${rgb}, 0.18)`,
    'border-radius:3px',
    'opacity:0',
    'z-index:2147483000',
    'transition:opacity 120ms ease',
    'will-change:transform,width,height',
    'left:0',
    'top:0',
    'mix-blend-mode:multiply',
  ].join(';');
  doc.body.appendChild(overlay);

  const hide = () => { overlay.style.opacity = '0'; };

  const getRangeAtPoint = (x: number, y: number, mode: FocusTracker): Range | null => {
    if (mode === 'off') return null;
    let range: Range | null = null;
    if ((doc as any).caretRangeFromPoint) {
      range = (doc as any).caretRangeFromPoint(x, y);
    } else if ((doc as any).caretPositionFromPoint) {
      const pos = (doc as any).caretPositionFromPoint(x, y);
      if (pos && pos.offsetNode) {
        range = doc.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.collapse(true);
      }
    }
    if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) return null;

    const text = range.startContainer.textContent || '';
    const at = range.startOffset;
    let start = at, end = at;

    if (mode === 'word') {
      while (start > 0 && WORD_CHAR.test(text[start - 1])) start--;
      while (end < text.length && WORD_CHAR.test(text[end])) end++;
    } else {
      // sentence: back to previous terminator, forward to next
      while (start > 0 && !/[.!?\n]/.test(text[start - 1])) start--;
      while (end < text.length && !/[.!?\n]/.test(text[end])) end++;
      if (end < text.length) end++;
      // trim leading whitespace
      while (start < end && /\s/.test(text[start])) start++;
    }

    if (end - start < 1) return null;
    const r = doc.createRange();
    r.setStart(range.startContainer, start);
    r.setEnd(range.startContainer, end);
    return r;
  };

  let rafId = 0;
  let lastEvent: MouseEvent | null = null;

  const paint = () => {
    rafId = 0;
    if (!lastEvent) return;
    if (settings.focusTracker === 'off') { hide(); return; }
    const range = getRangeAtPoint(lastEvent.clientX, lastEvent.clientY, settings.focusTracker);
    if (!range) { hide(); return; }
    const rect = range.getBoundingClientRect();
    if (!rect.width || !rect.height) { hide(); return; }
    const sx = doc.defaultView?.scrollX || 0;
    const sy = doc.defaultView?.scrollY || 0;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    overlay.style.transform = `translate(${rect.left + sx}px, ${rect.top + sy}px)`;
    overlay.style.opacity = '1';
    (overlay as any)._activeRange = range;
  };

  doc.addEventListener('mousemove', (e: MouseEvent) => {
    if (settings.focusTracker === 'off') { hide(); return; }
    lastEvent = e;
    if (!rafId) rafId = requestAnimationFrame(paint);
  });
  doc.addEventListener('mouseleave', hide);
  doc.body.addEventListener('mouseleave', hide);

  // Track drag distance so that a drag-to-select never gets misread as a
  // click-to-highlight-the-word-under-cursor. Any pointer travel of more
  // than a few pixels between mousedown and mouseup counts as a drag.
  let downX = 0, downY = 0, isDragging = false;
  doc.addEventListener('mousedown', (e: MouseEvent) => {
    downX = e.clientX; downY = e.clientY; isDragging = false;
  }, true);
  doc.addEventListener('mousemove', (e: MouseEvent) => {
    if (!isDragging && (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4)) {
      isDragging = true;
    }
  }, true);

  // Click behavior depends on state:
  //   - Link / footnote → let epub.js handle it (return early)
  //   - Drag-select in progress → let the selection popover handle it
  //   - TTS on → jump playback to the clicked word (highest priority — the
  //     user has an audible cursor and wants to move it)
  //   - Focus tracker on → save the tracked span as a highlight
  //   - Nothing → let the click through
  doc.addEventListener('click', (e: MouseEvent) => {
    if ((e.target as Element).closest('a')) return;
    if (isDragging) return;
    const sel = doc.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;

    // TTS click-to-jump wins over highlight-on-click. We need a word range
    // to jump to — prefer the currently-hovered focus range (if focus tracker
    // is on), fall back to computing one at the click point in 'word' mode.
    if (isTtsOn()) {
      const jumpRange = (overlay as any)._activeRange as Range | undefined
        ?? getRangeAtPoint(e.clientX, e.clientY, 'word');
      if (!jumpRange) return;

      // Ensure focusWords is populated for THIS iframe. Page turns can
      // leave focusIframeDoc stale between here and the last speakNextChunk.
      if (focusIframeDoc !== doc) collectFocusWords();

      const idx = findWordIdxAt(jumpRange.startContainer, jumpRange.startOffset);
      if (idx < 0) return;
      jumpTtsToWordIdx(idx);
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (settings.focusTracker === 'off') return;

    const range = (overlay as any)._activeRange as Range | undefined
      ?? getRangeAtPoint(e.clientX, e.clientY, settings.focusTracker);
    if (!range) return;
    const text = range.toString().trim();
    if (text.length < 2) return;
    let cfi: string | null = null;
    try { cfi = contents.cfiFromRange(range); } catch { /* ignore */ }
    if (!cfi) return;
    pendingSelectionCfi = cfi;
    pendingSelectionText = text;
    addHighlight(settings.lastHighlightColor);
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

/* ============================================================
   Highlights (selection popover)
   ============================================================ */
let pendingSelectionCfi: string | null = null;
let pendingSelectionText = '';

let dictionaryLookupId = 0;
let dictAbortController: AbortController | null = null;

// Extract the sentence containing a word range — walks the surrounding
// text node back to the previous sentence terminator and forward to the
// next. Used to capture "context" on vocab entries so review cards can
// show the actual passage the word was met in.
//
// Kept intentionally simple: doesn't cross text-node boundaries. If a
// sentence spans nodes (rich formatting), we return whatever fits in one
// node. Better a partial sentence than an incorrect one.
function extractSentenceContext(range: Range): string {
  const container = range.startContainer;
  if (container.nodeType !== Node.TEXT_NODE) return '';
  const text = container.textContent || '';
  const wordStart = Math.max(0, Math.min(range.startOffset, text.length));
  const wordEnd = Math.max(0, Math.min(range.endOffset, text.length));

  // Walk back to sentence start (previous terminator or node start).
  let sentStart = wordStart;
  while (sentStart > 0) {
    const c = text[sentStart - 1];
    if (/[.!?…]/.test(c)) break;
    sentStart--;
  }
  // Skip leading whitespace / quote marks left behind after the boundary.
  while (sentStart < text.length && /[\s"'`«»‹›]/.test(text[sentStart])) sentStart++;

  // Walk forward to sentence end (next terminator inclusive).
  let sentEnd = wordEnd;
  while (sentEnd < text.length) {
    const c = text[sentEnd];
    sentEnd++;
    if (/[.!?…]/.test(c)) break;
  }

  const sentence = text.slice(sentStart, sentEnd).trim().replace(/\s+/g, ' ');
  // Cap length — 300 is a generous couple of lines, longer than that the
  // review card gets crowded.
  return sentence.length > 300 ? sentence.slice(0, 300) + '…' : sentence;
}

// Cache of "the sentence for the last word lookup" — populated by
// onSelected, consumed by lookupWord → saveVocabEntry. Kept module-level
// because the lookup is async and we need the value that was current at
// selection time, not at network-response time.
let pendingSelectionContext = '';

function onSelected(cfiRange: string, contents: any) {
  pendingSelectionCfi = cfiRange;
  try {
    const sel = contents.window.getSelection();
    pendingSelectionText = (sel?.toString() || '').trim();
    if (!pendingSelectionText) {
      hideAllPopovers();
      return;
    }

    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const iframe = contents.window.frameElement as HTMLIFrameElement | null;
    if (!iframe) return;
    const iframeRect = iframe.getBoundingClientRect();
    const pageX = iframeRect.left + rect.left + rect.width / 2;
    const pageY = iframeRect.top + rect.top - 10;

    // Capture the sentence context up front so it's stable regardless of
    // when the dictionary API resolves.
    pendingSelectionContext = extractSentenceContext(range);

    // Clear any previous info popovers FIRST (bumps dictionaryLookupId),
    // then take a fresh id for this lookup.
    hideDictPopover();
    hideFootnotePopover();
    const currentId = ++dictionaryLookupId;

    if (!pendingSelectionText.includes(' ') && pendingSelectionText.length > 1) {
      lookupWord(pendingSelectionText, pageX, pageY, currentId);
    }

    showSelectionPopover(pageX, pageY);
  } catch (e) { console.error(e); }
}

async function lookupWord(word: string, x: number, y: number, lookupId: number) {
  const cleanWord = word.replace(/[^a-zA-Z]/g, '');
  if (!cleanWord) return;

  dictAbortController?.abort();
  const ctrl = new AbortController();
  dictAbortController = ctrl;
  const signal = ctrl.signal;

  const isStale = () => dictionaryLookupId !== lookupId || signal.aborted;

  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${cleanWord}`, { signal });
    if (isStale()) return;

    if (!res.ok) {
      const wikiRes = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${cleanWord}`, { signal });
      if (isStale()) return;
      if (!wikiRes.ok) throw new Error('Not found anywhere');

      const wikiData = await wikiRes.json();
      if (isStale()) return;

      if (wikiData.type === 'disambiguation' || !wikiData.extract) {
        throw new Error('No clear wikipedia extract');
      }

      el.dictWord.textContent = wikiData.title;
      el.dictPhonetic.textContent = 'Wikipedia';
      const wikiHtml = `<div>${escapeHtml(wikiData.extract)}</div>`;
      el.dictMeanings.innerHTML = wikiHtml;
      showDictPopover(x, y);
      prepareAiExplain(wikiData.title);
      saveVocabEntry({ display: wikiData.title, definitionHtml: wikiHtml, phonetic: 'Wikipedia' });
      return;
    }

    const data = await res.json();
    if (isStale()) return;
    const entry = data[0];

    const phonetic = entry.phonetic || entry.phonetics?.[0]?.text || '';
    el.dictWord.textContent = entry.word;
    el.dictPhonetic.textContent = phonetic;

    el.dictMeanings.innerHTML = '';
    const meanings = entry.meanings.slice(0, 2);
    for (const m of meanings) {
      const p = document.createElement('div');
      p.innerHTML = `<strong>${escapeHtml(m.partOfSpeech)}</strong><ul>` +
        m.definitions.slice(0, 2).map((d: any) => `<li>${escapeHtml(d.definition)}</li>`).join('') +
        `</ul>`;
      el.dictMeanings.appendChild(p);
    }

    showDictPopover(x, y);
    prepareAiExplain(entry.word);
    saveVocabEntry({ display: entry.word, definitionHtml: el.dictMeanings.innerHTML, phonetic });
  } catch (err) {
    if ((err as any)?.name === 'AbortError') return;
    if (isStale()) return;
    console.error('Dictionary/Wikipedia error:', err);
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    el.dictWord.textContent = cleanWord;
    el.dictPhonetic.textContent = offline ? 'Offline' : 'No result';
    el.dictMeanings.innerHTML = `<div style="color:var(--text-muted);font-style:italic;">${
      offline
        ? 'You appear to be offline. Definitions need an internet connection.'
        : 'No definition found in either dictionary or Wikipedia.'
    }</div>`;
    showDictPopover(x, y);
    // Even when the online sources whiff — including when we're fully offline —
    // the local model still runs and can explain the word from context.
    prepareAiExplain(cleanWord);
  }
}

function showDictPopover(pageX: number, pageY: number) {
  const p = el.dictPopover;
  p.hidden = false;
  const w = p.offsetWidth || 300;
  const h = p.offsetHeight || 200;
  p.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, pageX - w / 2))}px`;
  p.style.top  = `${Math.max(8, pageY - h - 50)}px`;
}

function hideDictPopover() {
  el.dictPopover.hidden = true;
  dictionaryLookupId++;              // any in-flight lookup becomes stale
  dictAbortController?.abort();      // cancel network work too
  dictAbortController = null;
  resetAiExplain();
}

/* ------------------------------------------------------------------
   Smart dictionary — "Explain in context" via the local LLM.

   When a definition is shown and a local model is installed, we offer a
   button that asks the model to explain the word *as used in this sentence*.
   This picks up idioms, disambiguates senses, and even helps for words the
   Free Dictionary API couldn't find. Entirely offline.
   ------------------------------------------------------------------ */
let aiExplainWord = '';
let aiExplainSentence = '';
let aiExplainInFlight = false;

// Called right after a lookup shows the popover. Decides whether to offer the
// AI button and stashes the word + its sentence for the click handler.
function prepareAiExplain(word: string) {
  aiExplainWord = word;
  aiExplainSentence = pendingSelectionContext;
  el.dictAiOutput.hidden = true;
  el.dictAiOutput.textContent = '';
  // Only offer the button when a model is actually installed and we have a
  // real word — otherwise the click would just error.
  const offer = isLlmReady() && !!word && word.trim().length > 0;
  el.dictAiBtn.hidden = !offer;
  el.dictAiBtn.disabled = false;
  el.dictAiBtn.classList.remove('is-busy');
}

function resetAiExplain() {
  aiExplainInFlight = false;
  el.dictAiBtn.hidden = true;
  el.dictAiBtn.disabled = false;
  el.dictAiBtn.classList.remove('is-busy');
  el.dictAiOutput.hidden = true;
  el.dictAiOutput.textContent = '';
}

async function runAiExplain() {
  if (aiExplainInFlight || !isLlmReady() || !aiExplainWord) return;
  const model = llmStatus!.models[0];

  aiExplainInFlight = true;
  el.dictAiBtn.disabled = true;
  el.dictAiBtn.classList.add('is-busy');
  el.dictAiOutput.hidden = false;
  el.dictAiOutput.textContent = 'Thinking…';

  const word = aiExplainWord;
  const sentence = aiExplainSentence;
  try {
    const answer = await invoke<string>('llm_explain', {
      word,
      sentence,
      modelPath: model.path,
    });
    // Guard against a stale response after the user moved on to another word.
    if (aiExplainWord !== word) return;
    el.dictAiOutput.textContent = answer;   // textContent = XSS-safe
  } catch (err) {
    if (aiExplainWord !== word) return;
    console.error('llm_explain failed:', err);
    el.dictAiOutput.textContent = `Couldn't run the local model: ${String(err)}`;
  } finally {
    if (aiExplainWord === word) {
      aiExplainInFlight = false;
      el.dictAiBtn.disabled = false;
      el.dictAiBtn.classList.remove('is-busy');
      // Once we've shown an explanation, drop the button — a second click
      // would just regenerate the same thing.
      el.dictAiBtn.hidden = true;
    }
  }
}

function showSelectionPopover(pageX: number, pageY: number) {
  const p = el.selectionPopover;
  p.hidden = false;
  const w = p.offsetWidth;
  const h = p.offsetHeight;
  p.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, pageX - w / 2))}px`;
  p.style.top  = `${Math.max(8, pageY - h)}px`;
}
function hideSelectionPopover() {
  el.selectionPopover.hidden = true;
  pendingSelectionCfi = null;
  pendingSelectionText = '';
}

function addHighlight(color: HighlightColor) {
  if (!currentRendition || !currentBookRecord || !pendingSelectionCfi) return;
  const cfi = pendingSelectionCfi;
  const text = pendingSelectionText;
  if (settings.lastHighlightColor !== color) {
    settings.lastHighlightColor = color;
    persistSettings();
  }

  const hex: Record<HighlightColor, string> = {
    yellow: 'rgba(253, 230, 138, 0.55)',
    green:  'rgba(187, 247, 208, 0.55)',
    blue:   'rgba(191, 219, 254, 0.55)',
    pink:   'rgba(251, 207, 232, 0.55)',
  };
  try {
    currentRendition.annotations.add('highlight', cfi, {}, undefined, `hl-${color}`, {
      'background-color': hex[color],
      'mix-blend-mode': 'multiply',
      'border-radius': '2px',
    });
  } catch (e) { console.error(e); }

  const existing = currentMarks.highlights.findIndex(h => h.cfi === cfi);
  if (existing >= 0) currentMarks.highlights[existing] = { ...currentMarks.highlights[existing], color };
  else currentMarks.highlights.push({
    cfi, color, text, chapter: currentChapterLabel, createdAt: Date.now(),
  });
  save(KEY_MARKS(currentBookRecord.id), currentMarks);
  hideSelectionPopover();
  toast('Highlighted');
}

function removePendingHighlight() {
  if (!currentRendition || !currentBookRecord || !pendingSelectionCfi) return;
  try { currentRendition.annotations.remove(pendingSelectionCfi, 'highlight'); } catch {}
  currentMarks.highlights = currentMarks.highlights.filter(h => h.cfi !== pendingSelectionCfi);
  save(KEY_MARKS(currentBookRecord.id), currentMarks);
  hideSelectionPopover();
  toast('Highlight removed');
}

function reapplyHighlights() {
  if (!currentRendition) return;
  const hex: Record<HighlightColor, string> = {
    yellow: 'rgba(253, 230, 138, 0.55)',
    green:  'rgba(187, 247, 208, 0.55)',
    blue:   'rgba(191, 219, 254, 0.55)',
    pink:   'rgba(251, 207, 232, 0.55)',
  };
  for (const h of currentMarks.highlights) {
    try {
      currentRendition.annotations.add('highlight', h.cfi, {}, undefined, `hl-${h.color}`, {
        'background-color': hex[h.color],
        'mix-blend-mode': 'multiply',
        'border-radius': '2px',
      });
    } catch { /* stale cfi */ }
  }
}

/* ============================================================
   Chrome auto-hide (mouse near top/bottom edges)
   ============================================================ */
function startChromeAutoHide() {
  el.html.dataset.chrome = 'hidden';
  // Remove first in case a previous openReader() left one behind — otherwise
  // each book-open would stack another mousemove handler on document.
  document.removeEventListener('mousemove', onReaderMouseMove);
  document.addEventListener('mousemove', onReaderMouseMove);
}

function onReaderMouseMove(e: MouseEvent) {
  if (el.html.dataset.screen !== 'reader') return;
  const nearTop = e.clientY < 80;
  const nearBottom = e.clientY > window.innerHeight - 80;
  if (nearTop || nearBottom) {
    el.html.dataset.chrome = 'visible';
    clearTimeout(hideChromeTimer);
    hideChromeTimer = window.setTimeout(() => {
      if (el.tocDrawer.hidden && el.typographyDrawer.hidden) {
        el.html.dataset.chrome = 'hidden';
      }
    }, 2500);
  }
}

/* ============================================================
   Footnote Popovers
   ============================================================ */
async function showFootnote(href: string, clientX: number, clientY: number) {
  if (!currentBook) return;
  try {
    const [path, id] = href.split('#');
    const doc = await currentBook.load(path) as Document;
    const target = id ? doc.getElementById(id) : doc.body;
    if (target) {
      el.footnoteContent.innerHTML = target.innerHTML;
      const p = el.footnotePopover;
      p.hidden = false;
      const w = 320;
      const h = p.offsetHeight || 200;
      p.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, clientX - w / 2))}px`;
      p.style.top  = `${Math.max(8, clientY - h - 20)}px`;
    }
  } catch (err) {
    console.error('Failed to load footnote:', err);
  }
}

function hideFootnotePopover() {
  el.footnotePopover.hidden = true;
}

/* ============================================================
   Reading Stats

   Old model: a setInterval that fired every 60000 ms and, if the user had
   moved a mouse since the previous tick, credited "1 minute" of reading.
   Two problems: (1) the interval is throttled to seconds when the tab is
   backgrounded, so a real minute of reading often didn't get counted; and
   (2) it assumed setInterval fires exactly on schedule, which it doesn't.

   New model: on activity we stamp `lastActiveAt`. A 5-second tick uses real
   Date.now() deltas — only crediting time when there was recent activity,
   and capping per-tick credit so a long background pause doesn't over-count
   when the tab wakes up.
   ============================================================ */
let activeReadingTimer: number | undefined;
let lastActiveAt = 0;
let lastAccountedAt = 0;
let readingAccumulatorMs = 0;
let statsListenersInstalled = false;

const markReadingActive = () => { lastActiveAt = Date.now(); };

function startReadingStats() {
  updateStatsUI();

  if (!statsListenersInstalled) {
    window.addEventListener('mousemove', markReadingActive);
    window.addEventListener('keydown', markReadingActive);
    window.addEventListener('scroll', markReadingActive, true);
    window.addEventListener('touchstart', markReadingActive, { passive: true });
    statsListenersInstalled = true;
  }

  const now = Date.now();
  lastActiveAt = now;
  lastAccountedAt = now;

  clearInterval(activeReadingTimer);
  activeReadingTimer = window.setInterval(tickReadingStats, 5000);
}

function tickReadingStats() {
  const now = Date.now();
  const elapsed = now - lastAccountedAt;
  lastAccountedAt = now;

  if (el.html.dataset.screen !== 'reader') return;
  // Only count time if the user showed signs of life within the last 15s.
  if (now - lastActiveAt >= 15000) return;

  // Cap per-tick credit: if the tab was backgrounded / the machine slept,
  // `elapsed` can be arbitrarily large. Credit at most one tick's worth
  // (a bit above the 5s interval to absorb jitter).
  readingAccumulatorMs += Math.min(elapsed, 10000);

  // Day rollover — only fires on the first tick after midnight, once the user
  // is actively reading again.
  const today = new Date().toISOString().split('T')[0];
  if (stats.todayDate !== today) {
    if (stats.todayDate) {
      const diffDays = Math.round(
        (new Date(today).getTime() - new Date(stats.todayDate).getTime()) / 86400000
      );
      stats.streakDays = diffDays === 1 ? stats.streakDays + 1 : 1;
    } else {
      stats.streakDays = 1;
    }
    stats.todayDate = today;
    stats.todayMins = 0;
  }

  if (readingAccumulatorMs >= 60000) {
    const mins = Math.floor(readingAccumulatorMs / 60000);
    stats.todayMins += mins;
    readingAccumulatorMs -= mins * 60000;
    persistStats();
    updateStatsUI();
  }
}

function updateStatsUI() {
  el.statsMins.textContent = `${stats.todayMins}m`;
  el.statsStreak.textContent = `${stats.streakDays}d`;
}

/* ============================================================
   Vocabulary Journal + SRS

   Dictionary lookups drop straight into a per-book journal.
   The user can review them with a lightweight SM-2 style
   spaced-repetition scheduler.

   SM-2 rating scale (adapted from the classic SuperMemo 2):
     1 = Again  → reset interval, penalize ease
     3 = Good   → keep ease, promote interval
     5 = Easy   → boost ease, longer interval
   ============================================================ */
const SRS_MIN_EASE = 1.3;

function loadVocab(bookId: string): VocabJournal {
  return load<VocabJournal>(KEY_VOCAB(bookId), { words: [] });
}

function persistVocab() {
  if (!currentBookRecord) return;
  save(KEY_VOCAB(currentBookRecord.id), currentVocab);
}

function saveVocabEntry(entry: { display: string; definitionHtml: string; phonetic?: string }) {
  if (!currentBookRecord) return;
  const canonical = entry.display.trim().toLowerCase();
  if (!canonical) return;

  // The sentence containing the word — grabbed by onSelected before the
  // async dictionary lookup fired. May be empty if the user triggered the
  // save through some other path (long-press without selection etc.).
  const context = pendingSelectionContext;

  const existing = currentVocab.words.find(w => w.word === canonical);
  if (existing) {
    // Refresh the definition — the API result may have improved between
    // lookups, and the chapter/context of the newer sighting is more
    // relevant to a reader who just re-encountered the word.
    existing.definition = entry.definitionHtml;
    if (entry.phonetic) existing.phonetic = entry.phonetic;
    existing.chapter = currentChapterLabel || existing.chapter;
    if (context) existing.context = context;
    persistVocab();
    refreshVocabPanelIfOpen();
    return;
  }

  const now = Date.now();
  currentVocab.words.push({
    word: canonical,
    displayWord: entry.display,
    definition: entry.definitionHtml,
    phonetic: entry.phonetic,
    chapter: currentChapterLabel || '',
    context: context || undefined,
    createdAt: now,
    reviewCount: 0,
    ease: 2.5,
    interval: 0,
    dueAt: now,                 // brand-new cards are due immediately
  });
  persistVocab();
  refreshVocabPanelIfOpen();
  scheduleVocabHighlightRefresh();
  toast(`Saved "${entry.display}" to vocabulary`);
}

function removeVocabEntry(canonical: string) {
  currentVocab.words = currentVocab.words.filter(w => w.word !== canonical);
  persistVocab();
  refreshVocabPanelIfOpen();
  scheduleVocabHighlightRefresh();
}

// SM-2 update. `rating` is 1 (Again), 3 (Good), or 5 (Easy).
// Returns the mutated word for chaining.
function sm2Update(w: VocabWord, rating: 1 | 3 | 5): VocabWord {
  const now = Date.now();

  if (rating < 3) {
    // Lapse — restart the interval, moderate penalty on ease.
    w.interval = 0;
    w.reviewCount = 0;
    w.ease = Math.max(SRS_MIN_EASE, w.ease - 0.2);
    // Show again in ~1 minute so it stays in the current session queue.
    w.dueAt = now + 60_000;
  } else {
    // Successful recall — promote interval.
    if (w.reviewCount === 0)      w.interval = 1;
    else if (w.reviewCount === 1) w.interval = rating === 5 ? 4 : 3;
    else                          w.interval = Math.round(w.interval * w.ease);

    // Standard SM-2 ease adjustment.
    const q = rating;             // 3 or 5 in our reduced scale
    w.ease = Math.max(SRS_MIN_EASE, w.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
    w.reviewCount++;
    w.dueAt = now + w.interval * 86_400_000;
  }
  w.lastReviewedAt = now;
  return w;
}

// Human-readable preview of "when will this card next be due" for the rating buttons.
function sm2Preview(w: VocabWord, rating: 1 | 3 | 5): string {
  if (rating < 3) return '< 1m';
  if (w.reviewCount === 0)      return '1d';
  if (w.reviewCount === 1)      return rating === 5 ? '4d' : '3d';
  const nextInterval = Math.round(w.interval * w.ease);
  if (nextInterval < 30) return `${nextInterval}d`;
  return `${Math.round(nextInterval / 30)}mo`;
}

function dueVocab(): VocabWord[] {
  const now = Date.now();
  return currentVocab.words.filter(w => w.dueAt <= now);
}

/* --- Daily new-card cap ---------------------------------------------- */

function todayDateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadVocabStats(): VocabDailyStats {
  const raw = load<VocabDailyStats>(KEY_VOCAB_STATS, { date: '', newCardsIntroduced: 0 });
  const today = todayDateStr();
  if (raw.date !== today) {
    // Day rolled over — reset the counter.
    return { date: today, newCardsIntroduced: 0 };
  }
  return raw;
}

function saveVocabStats(stats: VocabDailyStats): void {
  save(KEY_VOCAB_STATS, stats);
}

function remainingNewCardsToday(): number {
  const stats = loadVocabStats();
  return Math.max(0, NEW_CARDS_PER_DAY_CAP - stats.newCardsIntroduced);
}

function bumpNewCardsIntroduced(): void {
  const stats = loadVocabStats();
  stats.newCardsIntroduced++;
  saveVocabStats(stats);
}

/* --- Cross-book aggregation ------------------------------------------ */

// A review card enriched with its origin so the modal can show the source
// book and the rate handler can save updates back to the right journal.
type CrossBookVocabWord = VocabWord & { bookId: string; bookTitle: string };

// Load every book's journal, filter to due cards, and tag with book origin.
// This is the source for the "Review vocabulary" flow launched from the
// library screen (and from within a book — the source book's cards
// naturally appear).
function loadAllDueVocab(): CrossBookVocabWord[] {
  const now = Date.now();
  const all: CrossBookVocabWord[] = [];
  for (const book of library) {
    const journal = loadVocab(book.id);
    for (const w of journal.words) {
      if (w.dueAt <= now) {
        all.push({ ...w, bookId: book.id, bookTitle: book.title });
      }
    }
  }
  return all;
}

// Apply the daily new-card cap. Splits `due` into (already-reviewed) and
// (new = reviewCount 0), then takes only `remainingNewCardsToday()` new
// cards. Reviewed cards are never capped — they're already learned and
// should be maintained.
function applyDailyCap(due: CrossBookVocabWord[]): CrossBookVocabWord[] {
  const remaining = remainingNewCardsToday();
  const reviews: CrossBookVocabWord[] = [];
  const news: CrossBookVocabWord[] = [];
  for (const w of due) {
    if (w.reviewCount === 0) news.push(w);
    else reviews.push(w);
  }
  return reviews.concat(news.slice(0, remaining));
}

// Persist a mutation on a card back to its source book's journal. Handles
// the case where the mutated card belongs to the currently-open book (in
// which case currentVocab is the live copy).
function persistCrossBookUpdate(card: CrossBookVocabWord): void {
  if (currentBookRecord && card.bookId === currentBookRecord.id) {
    // Same book as currently loaded — mutate in place; the review card's
    // reference is already a copy that we now write back.
    const live = currentVocab.words.find(w => w.word === card.word);
    if (live) {
      live.ease = card.ease;
      live.interval = card.interval;
      live.reviewCount = card.reviewCount;
      live.dueAt = card.dueAt;
      live.lastReviewedAt = card.lastReviewedAt;
    }
    persistVocab();
    return;
  }
  // Different book — load, mutate, save.
  const journal = loadVocab(card.bookId);
  const live = journal.words.find(w => w.word === card.word);
  if (live) {
    live.ease = card.ease;
    live.interval = card.interval;
    live.reviewCount = card.reviewCount;
    live.dueAt = card.dueAt;
    live.lastReviewedAt = card.lastReviewedAt;
    save(KEY_VOCAB(card.bookId), journal);
  }
}

function refreshVocabPanelIfOpen() {
  // Only rebuild if the drawer is showing the vocab panel — avoids DOM
  // churn every time a word is looked up during quiet reading.
  if (!el.vocabPanel.hidden) renderVocabList();
}

function renderVocabList() {
  const total = currentVocab.words.length;
  const due = dueVocab().length;
  el.vocabCount.textContent = total === 0 ? '0 words' : `${total} word${total === 1 ? '' : 's'}`;
  el.vocabDueCount.textContent = `${due} due`;
  el.vocabReviewBtn.disabled = due === 0;

  el.vocabList.innerHTML = '';
  if (total === 0) {
    el.vocabList.innerHTML = '<div class="mark-empty">No vocabulary yet.<br>Tap a word while reading to add it.</div>';
    return;
  }

  // Due cards float to the top; within each bucket, most recently added first.
  const now = Date.now();
  const sorted = [...currentVocab.words].sort((a, b) => {
    const aDue = a.dueAt <= now ? 0 : 1;
    const bDue = b.dueAt <= now ? 0 : 1;
    if (aDue !== bDue) return aDue - bDue;
    return b.createdAt - a.createdAt;
  });

  for (const w of sorted) {
    const li = document.createElement('li');
    li.className = 'vocab-item';
    const isDue = w.dueAt <= now;
    const dueLabel = isDue ? 'due' : formatDueIn(w.dueAt - now);

    li.innerHTML = `
      <div class="vocab-word-row">
        <span class="vocab-word">${escapeHtml(w.displayWord)}</span>
        ${w.phonetic ? `<span class="vocab-phonetic">${escapeHtml(w.phonetic)}</span>` : ''}
        <span class="vocab-due-badge ${isDue ? 'due' : ''}">${dueLabel}</span>
      </div>
      <div class="vocab-def">${stripHtml(w.definition)}</div>
      <button class="vocab-remove" title="Remove from vocabulary" data-word="${escapeHtml(w.word)}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    `;
    el.vocabList.appendChild(li);
  }

  // Delegate remove-clicks — one listener per row is a lot of listeners.
  el.vocabList.querySelectorAll<HTMLButtonElement>('.vocab-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const w = btn.dataset.word;
      if (w) removeVocabEntry(w);
    });
  });
}

function formatDueIn(ms: number): string {
  const days = Math.round(ms / 86_400_000);
  if (days < 1) return '< 1d';
  if (days < 30) return `${days}d`;
  return `${Math.round(days / 30)}mo`;
}

function stripHtml(html: string): string {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return tmp.textContent || '';
}

/* --- Review session -------------------------------------------------- */
// The queue holds CrossBookVocabWord regardless of whether the session
// started from a single book (drawer button) or the library (Review all
// button). Single-book reviews are just the trivial one-book case of the
// aggregated flow.
let reviewQueue: CrossBookVocabWord[] = [];
let reviewIdx = 0;
let reviewSessionDone = 0;

// Open a review session. `scope` controls whether we pull from every book
// (library-level "Review vocabulary") or just the currently open one
// (in-book Review button in the drawer).
function openVocabReview(scope: 'current' | 'all' = 'current') {
  let candidates: CrossBookVocabWord[];
  if (scope === 'all') {
    candidates = loadAllDueVocab();
  } else if (currentBookRecord) {
    // Tag single-book cards with the same shape so downstream code has one
    // path — the aggregation is a no-op for a single book.
    candidates = dueVocab().map(w => ({
      ...w,
      bookId: currentBookRecord!.id,
      bookTitle: currentBookRecord!.title,
    }));
  } else {
    candidates = [];
  }

  // Apply the daily new-card cap before shuffling — new cards over the
  // limit stay held back until tomorrow.
  reviewQueue = applyDailyCap(candidates);

  if (reviewQueue.length === 0) {
    el.vocabReviewModal.hidden = false;
    showReviewEmpty();
    return;
  }
  // Randomize so consecutive sessions don't always start with the same word.
  reviewQueue.sort(() => Math.random() - 0.5);
  reviewIdx = 0;
  reviewSessionDone = 0;
  el.vocabReviewModal.hidden = false;
  showReviewCard();
}

function closeVocabReview() {
  el.vocabReviewModal.hidden = true;
  reviewQueue = [];
  refreshVocabPanelIfOpen();
  // The library button's count may have changed if we rated any cards.
  refreshLibraryVocabButton();
}

function showReviewEmpty() {
  el.vocabReviewEmpty.hidden = false;
  el.vocabCard.hidden = true;
  el.vocabRevealActions.hidden = true;
  el.vocabRateActions.hidden = true;
  el.vocabReviewProgress.textContent = 'Nothing due right now';
}

function showReviewCard() {
  const w = reviewQueue[reviewIdx];
  if (!w) { showReviewEmpty(); return; }

  el.vocabReviewEmpty.hidden = true;
  el.vocabCard.hidden = false;
  el.vocabCardWord.textContent = w.displayWord;
  el.vocabCardPhonetic.textContent = w.phonetic || '';

  // Context sentence with the word marked. The word may appear in any
  // case/form in the context (e.g. saved "run" but sentence uses "running"),
  // so we do a lowercase substring match and preserve the original casing.
  if (w.context) {
    el.vocabCardContext.hidden = false;
    el.vocabCardContext.innerHTML = markWordInContext(w.context, w.displayWord);
  } else {
    el.vocabCardContext.hidden = true;
    el.vocabCardContext.textContent = '';
  }

  // For cross-book reviews, prepend the book title to the chapter line so
  // the reader knows which book the card came from.
  const chapterLine = (w as any).bookTitle
    ? `${(w as any).bookTitle} · ${w.chapter}`
    : (w.chapter || '');
  el.vocabCardChapter.textContent = chapterLine;
  el.vocabCardBack.hidden = true;
  el.vocabCardDefinition.innerHTML = w.definition;

  el.vocabRevealActions.hidden = false;
  el.vocabRateActions.hidden = true;

  const remaining = reviewQueue.length - reviewIdx;
  el.vocabReviewProgress.textContent = `${reviewSessionDone} done · ${remaining} to go`;
}

// Wrap the first case-insensitive occurrence of `word` in <em> tags so
// CSS can style it as the emphasized token in the context sentence. Uses
// a word-boundary-flexible match so "run" highlights inside "running" too.
function markWordInContext(context: string, word: string): string {
  const safeContext = escapeHtml(context);
  const stem = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!stem) return safeContext;
  const re = new RegExp(`(${stem}\\w*)`, 'i');
  return safeContext.replace(re, '<em>$1</em>');
}

function revealReviewCard() {
  const w = reviewQueue[reviewIdx];
  if (!w) return;
  el.vocabCardBack.hidden = false;
  el.vocabRevealActions.hidden = true;
  el.vocabRateActions.hidden = false;

  el.vocabHintAgain.textContent = sm2Preview(w, 1);
  el.vocabHintGood.textContent  = sm2Preview(w, 3);
  el.vocabHintEasy.textContent  = sm2Preview(w, 5);
}

function rateReviewCard(rating: 1 | 3 | 5) {
  const w = reviewQueue[reviewIdx];
  if (!w) return;

  // If this is the FIRST time the user is rating this new card (reviewCount
  // is still 0 pre-update), count it toward the daily new-card cap. Failed
  // reviews (rating<3) that reset reviewCount don't re-charge the counter.
  const wasNew = w.reviewCount === 0;

  sm2Update(w, rating);

  // Save back to the card's source book journal — same book gets the
  // in-memory sync-through, other books get a load/mutate/save round-trip.
  persistCrossBookUpdate(w);

  if (wasNew && rating >= 3) bumpNewCardsIntroduced();

  reviewSessionDone++;

  if (rating < 3) {
    // Move the card near the end of the queue so it comes back this session.
    reviewQueue.splice(reviewIdx, 1);
    const insertAt = Math.min(reviewIdx + 3, reviewQueue.length);
    reviewQueue.splice(insertAt, 0, w);
  } else {
    reviewIdx++;
  }

  if (reviewIdx >= reviewQueue.length) {
    showReviewEmpty();
    el.vocabReviewProgress.textContent = `Session done — ${reviewSessionDone} card${reviewSessionDone === 1 ? '' : 's'}`;
    return;
  }
  showReviewCard();
}

// Ensure Layout toggles work
document.querySelectorAll<HTMLButtonElement>('[data-control="layout"] button').forEach(btn => {
  btn.addEventListener('click', () => {
    const v = btn.dataset.value as LayoutKind;
    if (settings.layout === v) return;
    settings.layout = v;
    persistSettings();
    refreshTypographyUI();
    if (currentBookRecord) {
      // epub.js can't retarget flow/spread on an existing rendition — we have
      // to renderTo() fresh. Re-read the bytes via the normal library path;
      // the previous version passed `archive.url` (a string) into openReader,
      // which expects an ArrayBuffer, and threw as soon as anyone flipped
      // layout after opening a book.
      openFromLibrary(currentBookRecord);
    }
  });
});

/* ============================================================
   Progress bar seek
   ============================================================ */
function seekFromClick(e: MouseEvent) {
  if (!currentBook || !currentRendition) return;
  const rect = el.progressTrack.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const cfi = currentBook.locations.cfiFromPercentage(pct);
  if (cfi) currentRendition.display(cfi);
}

/* ============================================================
   Wire up events
   ============================================================ */
/* ============================================================
   Focus reading mode — auto-play word-by-word highlighter.
   Speed configurable in WPM. Advances page when running out of
   visible words. Space toggles pause. Esc exits.
   ============================================================ */
interface FocusWord { node: Text; start: number; end: number; }

let focusModeOn = false;
let focusPaused = false;
let focusWords: FocusWord[] = [];
let focusIndex = 0;
let focusTimer: number | undefined;
let focusOverlay: HTMLDivElement | null = null;
let focusIframeDoc: Document | null = null;

// Two-tier highlight state. The sentence overlay is a container that holds
// one <div> per line-rect of the current sentence (a single Range can span
// multiple lines; getClientRects returns one rect per line). We rebuild it
// only when the sentence changes (not on every word) so it's cheap.
let sentenceOverlay: HTMLDivElement | null = null;
let currentSentenceKey = '';   // "startWordIdx:endWordIdx" — cheap change detector

// Last rect painted on the word overlay. We use it to detect same-line vs
// line-break moves so we can transition-slide across a line but hard-cut
// across a line break (a diagonal swipe looks wrong).
let lastPaintedRect: DOMRect | null = null;

// Cached theme-accent color parsed from CSS custom properties. Re-read on
// theme change so overlays feel native to whichever theme is active.
let cachedAccentHex: string | null = null;

// Parse "#rgb" / "#rrggbb" / "rgb(...)" into "r,g,b" tuple string usable
// inside an rgba() with a chosen alpha. Falls back to a warm orange if the
// theme doesn't define --accent for some reason.
function accentRgbTuple(): string {
  if (cachedAccentHex) return cachedAccentHex;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  let r = 180, g = 83, b = 9;
  const hex3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(raw);
  const hex6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(raw);
  const rgb  = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(raw);
  if (hex6) { r = parseInt(hex6[1], 16); g = parseInt(hex6[2], 16); b = parseInt(hex6[3], 16); }
  else if (hex3) { r = parseInt(hex3[1] + hex3[1], 16); g = parseInt(hex3[2] + hex3[2], 16); b = parseInt(hex3[3] + hex3[3], 16); }
  else if (rgb) { r = +rgb[1]; g = +rgb[2]; b = +rgb[3]; }
  cachedAccentHex = `${r}, ${g}, ${b}`;
  return cachedAccentHex;
}

// Hide both the sharp word cursor and the dim sentence context. Called
// from every stop path (focus mode off, TTS off, cached stop) so we
// don't leave a stale sentence tint on the page after audio stops.
function hideAllHighlights(): void {
  if (focusOverlay && focusOverlay.isConnected) focusOverlay.style.opacity = '0';
  if (sentenceOverlay && sentenceOverlay.isConnected) {
    sentenceOverlay.style.opacity = '0';
    currentSentenceKey = '';
  }
  lastPaintedRect = null;
}

// Invalidate the accent cache and refresh currently-painted overlays.
// Called from applyReaderSettings when the theme changes.
function refreshHighlightColors(): void {
  cachedAccentHex = null;
  const rgb = accentRgbTuple();
  const wordBg = `rgba(${rgb}, 0.35)`;
  const wordBorder = `rgba(${rgb}, 0.55)`;
  const sentenceBg = `rgba(${rgb}, 0.10)`;
  if (focusOverlay) {
    focusOverlay.style.background = wordBg;
    focusOverlay.style.boxShadow = `0 0 0 1px ${wordBorder}`;
  }
  if (sentenceOverlay) {
    sentenceOverlay.querySelectorAll('div').forEach((n) => {
      (n as HTMLDivElement).style.background = sentenceBg;
    });
  }
  // Hover tracker overlay lives inside each iframe; find and repaint.
  const iframes = el.viewer?.querySelectorAll('iframe');
  iframes?.forEach((raw) => {
    const doc = (raw as HTMLIFrameElement).contentDocument;
    const trackerOverlay = doc?.querySelector('[data-focus-overlay]') as HTMLDivElement | null;
    if (trackerOverlay) trackerOverlay.style.background = `rgba(${rgb}, 0.18)`;
  });
}

function isFocusModeOn(): boolean { return focusModeOn; }

// The continuous manager may render multiple iframes (pre-loading adjacent
// sections). Pick the one with the largest intersection with the viewer —
// that's the section the reader is currently looking at.
function getVisibleIframe(): HTMLIFrameElement | null {
  const iframes = el.viewer.querySelectorAll('iframe');
  if (iframes.length === 0) return null;
  const viewerRect = el.viewer.getBoundingClientRect();
  let best: HTMLIFrameElement | null = null;
  let bestArea = -1;
  iframes.forEach((raw) => {
    const f = raw as HTMLIFrameElement;
    const r = f.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, viewerRect.right)  - Math.max(r.left, viewerRect.left));
    const h = Math.max(0, Math.min(r.bottom, viewerRect.bottom) - Math.max(r.top, viewerRect.top));
    const area = w * h;
    if (area > bestArea) { bestArea = area; best = f; }
  });
  return best;
}

/* ============================================================
   Page navigation — serialized prev/next that reliably crosses chapters.

   epub.js's continuous manager (v0.3.93) turns pages by *scrolling* the
   container: next() does scrollBy(+delta) then asynchronously check()s
   whether the adjacent section needs to be appended; prev() is the mirror.
   Two failure modes fall out of that:

     1. Boundary not crossed. At the last page of a chapter there is nothing
        to scroll into yet — the scroll clamps — and the section append is
        async, so a single press moves nothing. For some epubs repeated
        presses never cross either (the scroll stays clamped against the
        not-yet-laid-out boundary).
     2. Blank gap. A turn scrolls onto an offset between sections before the
        adjacent one has laid out, showing an empty page.

   Selecting a page from the progress bar works around both because it calls
   display(cfi) — a clean re-layout at an explicit target — instead of a
   relative scroll.

   navGo() serializes turns (drops overlapping presses) and, after the turn
   settles, compares the resolved CFI:
     - CFI unchanged  → the turn didn't move (case 1). Jump straight to the
       adjacent spine section via display(href) — the reliable path the
       progress bar uses — so one press always crosses the boundary.
     - CFI changed but the viewport is blank (case 2) → re-display the now-
       current CFI to force the clean re-layout.
     - CFI changed and content is visible → the normal case; do nothing, so
       ordinary paging never flickers or jumps.
   ============================================================ */
let navBusy = false;

function viewportIsBlank(): boolean {
  const iframe = getVisibleIframe();
  if (!iframe) return true;
  const viewerRect = el.viewer.getBoundingClientRect();
  const viewerArea = viewerRect.width * viewerRect.height;
  if (viewerArea <= 0) return false;
  const r = iframe.getBoundingClientRect();
  const w = Math.max(0, Math.min(r.right, viewerRect.right) - Math.max(r.left, viewerRect.left));
  const h = Math.max(0, Math.min(r.bottom, viewerRect.bottom) - Math.max(r.top, viewerRect.top));
  // The turned-to iframe covers almost none of the viewer → we've scrolled
  // into a gap between sections rather than onto real content.
  return (w * h) / viewerArea < 0.25;
}

async function navGo(dir: 'prev' | 'next'): Promise<void> {
  const r = currentRendition;
  const book = currentBook;
  if (!r || navBusy) return;
  navBusy = true;
  try {
    const before = r.currentLocation() as any;
    const beforeCfi = before?.start?.cfi;
    const beforeIdx = before?.start?.index;

    await (dir === 'prev' ? r.prev() : r.next());
    // Two frames: one for the scroll to apply, one for any freshly appended
    // section to lay out before we measure where we landed.
    await new Promise<void>(res => requestAnimationFrame(() => res()));
    await new Promise<void>(res => requestAnimationFrame(() => res()));

    const after = r.currentLocation() as any;
    const afterCfi = after?.start?.cfi;
    const moved = !!afterCfi && afterCfi !== beforeCfi;

    if (!moved) {
      // Case 1 — the scroll-based turn clamped at a section boundary and
      // didn't move. Cross it explicitly by displaying the adjacent spine
      // section. Guard against running past the book's ends.
      const atLimit = dir === 'next' ? after?.atEnd : after?.atStart;
      if (book && !atLimit && beforeIdx != null) {
        const sec = book.spine.get(beforeIdx) as any;
        const adj = dir === 'next' ? sec?.next?.() : sec?.prev?.();
        if (adj?.href) await r.display(adj.href).catch(() => {});
      }
    } else if (viewportIsBlank()) {
      // Case 2 — moved to a new page that rendered into a between-sections
      // gap. Re-display the now-current CFI for a clean re-layout (the same
      // thing the progress-bar seek does).
      if (afterCfi) await r.display(afterCfi).catch(() => {});
    }
  } catch (err) {
    console.warn(`nav ${dir} failed:`, err);
  } finally {
    navBusy = false;
  }
}

function collectFocusWords(): void {
  focusWords = [];
  focusOverlay = null;
  focusIframeDoc = null;

  const iframe = getVisibleIframe();
  if (!iframe || !iframe.contentDocument?.body) return;
  const doc = iframe.contentDocument;
  focusIframeDoc = doc;

  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent || !node.textContent.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript') return NodeFilter.FILTER_REJECT;
      const style = doc.defaultView?.getComputedStyle(parent);
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const wordRe = /\S+/g;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent || '';
    let m: RegExpExecArray | null;
    while ((m = wordRe.exec(text))) {
      focusWords.push({ node: node as Text, start: m.index, end: m.index + m[0].length });
    }
  }
}

function ensureFocusOverlay(doc: Document): HTMLDivElement {
  if (focusOverlay && focusOverlay.isConnected) return focusOverlay;
  const rgb = accentRgbTuple();
  const div = doc.createElement('div');
  div.setAttribute('data-focus-word', '');
  div.style.cssText = [
    'position:absolute',
    'pointer-events:none',
    'z-index:2147483001',
    'border-radius:3px',
    `background:rgba(${rgb}, 0.35)`,
    `box-shadow:0 0 0 1px rgba(${rgb}, 0.55)`,
    'transition:transform 90ms linear, width 90ms linear, height 90ms linear, opacity 120ms',
    'will-change:transform,width,height',
    'left:0',
    'top:0',
    'opacity:0',
    'mix-blend-mode:multiply',
  ].join(';');
  doc.body.appendChild(div);
  focusOverlay = div;
  return div;
}

// The sentence overlay is a container div that holds one child rect per
// line the sentence occupies (Range.getClientRects returns one per line).
// We keep the container attached and rebuild its children when the sentence
// changes; the container itself is z-below the word overlay so the word
// cursor stays visually on top.
function ensureSentenceOverlay(doc: Document): HTMLDivElement {
  if (sentenceOverlay && sentenceOverlay.isConnected && sentenceOverlay.ownerDocument === doc) {
    return sentenceOverlay;
  }
  const div = doc.createElement('div');
  div.setAttribute('data-focus-sentence', '');
  div.style.cssText = [
    'position:absolute',
    'pointer-events:none',
    'z-index:2147483000',   // one below the word cursor
    'left:0',
    'top:0',
    'width:0',
    'height:0',
    'opacity:0',
    'transition:opacity 180ms ease',
  ].join(';');
  doc.body.appendChild(div);
  sentenceOverlay = div;
  currentSentenceKey = '';
  return div;
}

/* --- Saved-vocab highlighting in the reader ---------------------------
   Underlines every word in the visible iframe that's already in the
   current book's vocab journal. Closes the feedback loop between "I saved
   this word" and "here's where you see it while reading."

   Implementation notes:
   - Overlays live inside the iframe body, positioned absolutely at each
     matched word's rect (accounting for iframe scroll so paginated column
     turns don't break alignment).
   - Matching is stem-based: we compare the lowercased letter-only form of
     each on-page word against the vocab canonical form. So "run" matches
     "running" too — better recall reminder that way.
   - Rendered once per iframe on content load; refreshed on save/delete via
     `scheduleVocabHighlightRefresh` which throttles rapid saves.
   ------------------------------------------------------------------------ */
let vocabHighlightRefreshRaf = 0;

function scheduleVocabHighlightRefresh(): void {
  if (vocabHighlightRefreshRaf) return;
  vocabHighlightRefreshRaf = requestAnimationFrame(() => {
    vocabHighlightRefreshRaf = 0;
    if (!currentRendition) return;
    // Re-render for every iframe currently attached, since paginated /
    // continuous can have adjacent sections in the DOM.
    const iframes = el.viewer.querySelectorAll('iframe');
    iframes.forEach((f) => {
      const doc = (f as HTMLIFrameElement).contentDocument;
      if (doc?.body) renderVocabHighlightsForDoc(doc);
    });
  });
}

// The set of canonical vocab words to underline. Rebuilt cheaply — the
// journal rarely exceeds a few hundred entries.
function buildVocabSet(): Set<string> {
  const set = new Set<string>();
  for (const w of currentVocab.words) set.add(w.word);
  return set;
}

function renderVocabHighlightsForDoc(doc: Document): void {
  if (!doc || !doc.body) return;
  const vocabSet = buildVocabSet();

  // Clear any prior container so a stale set doesn't linger after removal.
  let container = doc.querySelector('[data-vocab-highlights]') as HTMLDivElement | null;
  if (container) container.remove();
  if (vocabSet.size === 0) return;

  container = doc.createElement('div');
  container.setAttribute('data-vocab-highlights', '');
  container.style.cssText = [
    'position:absolute',
    'inset:0',
    'pointer-events:none',
    'z-index:0',
  ].join(';');
  doc.body.appendChild(container);

  const rgb = accentRgbTuple();
  const win = doc.defaultView;
  const sx = win?.scrollX || 0;
  const sy = win?.scrollY || 0;

  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent || !node.textContent.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript') return NodeFilter.FILTER_REJECT;
      // Skip our own overlay tree.
      if (parent.closest('[data-vocab-highlights]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const wordRe = /\S+/g;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent || '';
    let m: RegExpExecArray | null;
    while ((m = wordRe.exec(text))) {
      const raw = m[0];
      const stem = raw.toLowerCase().replace(/[^a-z']/g, '');
      if (!stem) continue;
      // Match if the whole word (stem) IS in the vocab OR if a vocab word
      // is a prefix of the stem (so "run" underlines "running"). We keep
      // this quick — set lookup + at most a handful of substring checks.
      let matched = vocabSet.has(stem);
      if (!matched) {
        for (const v of vocabSet) {
          if (v.length >= 3 && stem.startsWith(v)) { matched = true; break; }
        }
      }
      if (!matched) continue;

      const range = doc.createRange();
      try {
        range.setStart(node, m.index);
        range.setEnd(node, m.index + raw.length);
      } catch { continue; }

      const rects = range.getClientRects();
      for (let i = 0; i < rects.length; i++) {
        const rect = rects[i];
        if (rect.width < 2 || rect.height < 2) continue;
        const marker = doc.createElement('div');
        marker.style.cssText = [
          'position:absolute',
          `left:${rect.left + sx}px`,
          `top:${rect.top + sy + rect.height - 2}px`,
          `width:${rect.width}px`,
          'height:2px',
          `background:rgba(${rgb}, 0.55)`,
          'border-radius:1px',
        ].join(';');
        container.appendChild(marker);
      }
    }
  }
}

// Classify a word's on-screen position relative to the visible viewport.
//  'visible' — paint it now
//  'before'  — earlier page/column; skip forward without turning
//  'after'   — later page/column; turn the page and try again
//  'gone'    — DOM detached / zero-size; skip
type WordPos = 'visible' | 'before' | 'after' | 'gone';

function classifyWord(fw: FocusWord): { pos: WordPos; range: Range | null; rect: DOMRect | null } {
  if (!focusIframeDoc || !fw.node.parentNode) return { pos: 'gone', range: null, rect: null };
  const range = focusIframeDoc.createRange();
  try {
    const len = fw.node.textContent?.length ?? 0;
    range.setStart(fw.node, Math.min(fw.start, len));
    range.setEnd(fw.node, Math.min(fw.end, len));
  } catch { return { pos: 'gone', range: null, rect: null }; }
  const rect = range.getBoundingClientRect();
  if (!rect.width || !rect.height) return { pos: 'gone', range, rect };

  const iframe = getVisibleIframe();
  if (!iframe) return { pos: 'gone', range, rect };

  // We compare the word's position against the on-screen viewer bounds in
  // top-window coordinates. Using iframe.clientWidth as "one page width"
  // was wrong: in continuous paginated mode epub.js can size an iframe to
  // hold the whole column strip (e.g. 8000px for 10 pages) and pagination
  // is done by the outer viewer scrolling. In that model a word on the
  // next page has rect.left ~ 5000, which is < iframe.clientWidth 8000
  // so the old check misclassified it as 'visible' — the cursor tried to
  // paint off-screen and the page never advanced.
  const iframeRect = iframe.getBoundingClientRect();
  const viewerRect = el.viewer.getBoundingClientRect();
  const winLeft   = iframeRect.left + rect.left;
  const winRight  = iframeRect.left + rect.right;
  const winTop    = iframeRect.top  + rect.top;
  const winBottom = iframeRect.top  + rect.bottom;

  // Fully to the left of / above the visible viewer = a previous page.
  if (winRight <= viewerRect.left + 4 || winBottom <= viewerRect.top + 4) {
    return { pos: 'before', range, rect };
  }
  // Fully to the right of / below the visible viewer = a later page.
  if (winLeft >= viewerRect.right - 4 || winTop >= viewerRect.bottom - 4) {
    return { pos: 'after', range, rect };
  }

  return { pos: 'visible', range, rect };
}

// Find the sentence that contains `wordIdx` — walking backward from wordIdx
// until we cross a sentence-ending word (or hit the start of focusWords),
// then forward until the next sentence-ending word (or end). Returns the
// [firstWordIdx, lastWordIdx] range inclusive.
function sentenceRangeAround(wordIdx: number): [number, number] {
  if (wordIdx < 0 || wordIdx >= focusWords.length) return [-1, -1];

  const wordText = (fw: FocusWord) =>
    (fw.node.textContent || '').slice(fw.start, fw.end).trim();

  let start = wordIdx;
  while (start > 0) {
    if (endsSentence(wordText(focusWords[start - 1]))) break;
    start--;
  }
  let end = wordIdx;
  while (end < focusWords.length - 1) {
    if (endsSentence(wordText(focusWords[end]))) break;
    end++;
  }
  return [start, end];
}

// Paint (or clear) the dim sentence-context overlay. `startWordIdx` and
// `endWordIdx` describe the sentence range in focusWords. Passing -1 for
// either clears the overlay. Idempotent — skipped when the sentence hasn't
// changed since the last paint, so it's cheap to call every word.
function paintSentenceRange(startWordIdx: number, endWordIdx: number): void {
  if (!focusIframeDoc) return;
  const key = `${startWordIdx}:${endWordIdx}`;
  if (key === currentSentenceKey) return;

  const overlay = ensureSentenceOverlay(focusIframeDoc);
  currentSentenceKey = key;

  if (startWordIdx < 0 || endWordIdx < 0 || endWordIdx < startWordIdx
      || startWordIdx >= focusWords.length || endWordIdx >= focusWords.length) {
    overlay.replaceChildren();
    overlay.style.opacity = '0';
    return;
  }

  const first = focusWords[startWordIdx];
  const last = focusWords[endWordIdx];
  if (!first?.node?.parentNode || !last?.node?.parentNode) {
    overlay.replaceChildren();
    overlay.style.opacity = '0';
    return;
  }

  // Range spanning the whole sentence. getClientRects returns one rect per
  // line the range wraps to, which is exactly what we want to paint.
  const sr = focusIframeDoc.createRange();
  try {
    const firstLen = first.node.textContent?.length ?? 0;
    const lastLen = last.node.textContent?.length ?? 0;
    sr.setStart(first.node, Math.min(first.start, firstLen));
    sr.setEnd(last.node, Math.min(last.end, lastLen));
  } catch {
    overlay.replaceChildren();
    overlay.style.opacity = '0';
    return;
  }

  const rects = sr.getClientRects();
  const sx = focusIframeDoc.defaultView?.scrollX || 0;
  const sy = focusIframeDoc.defaultView?.scrollY || 0;
  const rgb = accentRgbTuple();

  // Rebuild children — one <div> per line rect. Reusing existing children
  // where possible avoids DOM churn during scroll-heavy transitions.
  const desiredCount = rects.length;
  while (overlay.childElementCount > desiredCount) overlay.lastElementChild?.remove();
  while (overlay.childElementCount < desiredCount) {
    const line = focusIframeDoc.createElement('div');
    line.style.cssText = [
      'position:absolute',
      'pointer-events:none',
      'border-radius:2px',
      `background:rgba(${rgb}, 0.10)`,
      'mix-blend-mode:multiply',
      'transition:transform 120ms linear, width 120ms linear, height 120ms linear',
      'will-change:transform,width,height',
      'left:0',
      'top:0',
    ].join(';');
    overlay.appendChild(line);
  }

  for (let i = 0; i < desiredCount; i++) {
    const r = rects[i];
    const child = overlay.children[i] as HTMLDivElement;
    child.style.transform = `translate(${r.left + sx}px, ${r.top + sy}px)`;
    child.style.width = `${r.width}px`;
    child.style.height = `${r.height}px`;
  }
  overlay.style.opacity = '1';
}

function paintRange(range: Range, rect: DOMRect, wordIdx: number = -1): void {
  if (!focusIframeDoc) return;

  // Paint the dim sentence context first (so the sharp word cursor sits
  // on top of it visually). Only when we know the word idx — the RSVP /
  // TTS callers pass it, but callers that only have a range don't.
  if (wordIdx >= 0) {
    const [sStart, sEnd] = sentenceRangeAround(wordIdx);
    paintSentenceRange(sStart, sEnd);
  }

  const overlay = ensureFocusOverlay(focusIframeDoc);
  const sx = focusIframeDoc.defaultView?.scrollX || 0;
  const sy = focusIframeDoc.defaultView?.scrollY || 0;

  // Detect line break vs. same-line motion. A diagonal transition across
  // two lines looks wrong (the highlight swipes through the paragraph
  // instead of hopping) — so we suppress the transition for the frame of
  // the jump, then restore it. Threshold: half the word's own height,
  // which comfortably covers any font-size while still catching real
  // line changes.
  let brokeLine = false;
  if (lastPaintedRect) {
    const dy = Math.abs(rect.top - lastPaintedRect.top);
    brokeLine = dy > rect.height * 0.5;
  } else {
    brokeLine = true;   // first paint — no transition to look wrong
  }
  if (brokeLine) overlay.style.transition = 'opacity 120ms';

  overlay.style.transform = `translate(${rect.left + sx}px, ${rect.top + sy}px)`;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
  overlay.style.opacity = '1';
  lastPaintedRect = rect;

  if (brokeLine) {
    // Restore the transition next frame so subsequent same-line moves
    // interpolate smoothly again.
    requestAnimationFrame(() => {
      if (focusOverlay) {
        focusOverlay.style.transition = 'transform 90ms linear, width 90ms linear, height 90ms linear, opacity 120ms';
      }
    });
  }

  void range;
}

function scheduleFocusTick(): void {
  clearTimeout(focusTimer);
  if (!focusModeOn || focusPaused) return;
  const wpm = Math.max(60, Math.min(1000, settings.focusModeWpm));
  const delay = 60000 / wpm;
  focusTimer = window.setTimeout(focusTick, delay);
}

// Turn a page and call cb() once the new page has actually painted, so
// classifyWord() reads fresh coordinates instead of stale ones from the
// old layout.
//
// The old version fired `rendition.next()` without awaiting its Promise
// and started polling at a 16ms threshold — well before the browser had
// painted the transition. classifyWord then saw the same "after"-page
// coordinates as before and either painted on the wrong page or thought
// the cursor still needed to advance, leaving the highlight stuck.
let advancingPage = false;

const raf = () => new Promise<void>(r => requestAnimationFrame(() => r()));
const wait = (ms: number) => new Promise<void>(r => window.setTimeout(r, ms));

async function turnPageAndContinue(cb: () => void): Promise<void> {
  if (!currentRendition) { cb(); return; }
  if (advancingPage) return;
  advancingPage = true;

  const prevDoc = focusIframeDoc;

  try {
    // Rendition.next() resolves after the transition has been queued to the
    // DOM. Awaiting is the only way to know the layout has been updated.
    await currentRendition.next();
  } catch (err) {
    console.warn('focus: page turn failed:', err);
  }

  // One paint frame so getBoundingClientRect() reflects the new positions.
  await raf();

  // Cross-section turns replace the visible iframe entirely. Give the new
  // iframe a short window to become "the largest-intersection one" and to
  // finish laying out its body before we re-index its words.
  const deadline = performance.now() + 800;
  while (performance.now() < deadline) {
    if (!focusModeOn) { advancingPage = false; return; }
    const vis = getVisibleIframe();
    const doc = vis?.contentDocument ?? null;

    if (doc && doc !== prevDoc && doc.body && doc.body.childNodes.length > 0) {
      // Section changed — one more frame for the new body to lay out, then
      // rebuild the word list from the new iframe.
      await raf();
      collectFocusWords();
      focusIndex = 0;
      break;
    }
    // Same iframe → in-section page turn. Layout already settled above.
    if (doc && doc === prevDoc) break;
    // No iframe yet (transient state during section swap) — wait and retry.
    await wait(40);
  }

  advancingPage = false;
  if (focusModeOn) cb();
}

function focusTick(): void {
  if (!focusModeOn) return;
  if (advancingPage) return;   // page turn in progress; poll() will re-tick

  // Refresh word list if the DOM has been swapped out from under us
  // (section change moves us to a new iframe entirely).
  const visIframe = getVisibleIframe();
  if (visIframe && visIframe.contentDocument !== focusIframeDoc) {
    collectFocusWords();
    focusIndex = 0;
  }

  if (focusWords.length === 0) {
    toast('Focus mode: no more words');
    stopFocusMode();
    return;
  }

  // Walk forward through the word list skipping `before`-page words. Stop on
  // the first visible word (paint it), or the first `after`-page word (turn).
  let steps = 0;
  while (focusIndex < focusWords.length && steps++ < 5000) {
    const { pos, range, rect } = classifyWord(focusWords[focusIndex]);
    if (pos === 'visible' && range && rect) {
      paintRange(range, rect, focusIndex);
      focusIndex++;
      scheduleFocusTick();
      return;
    }
    if (pos === 'before' || pos === 'gone') { focusIndex++; continue; }
    // pos === 'after' → we've reached the end of the current page's content;
    // turn to the next page and resume with the first visible word there.
    turnPageAndContinue(() => focusTick());
    return;
  }

  // Ran out of words in this section entirely — force a hard advance.
  turnPageAndContinue(() => {
    if (focusWords.length === 0) {
      toast('End of book');
      stopFocusMode();
      return;
    }
    focusTick();
  });
}

// Locate the first word currently visible in the viewer. When focus mode
// is started mid-chapter we want the cursor to land on the current page,
// not walk from the section's first word.
function findFirstVisibleWordIndex(): number {
  for (let i = 0; i < focusWords.length; i++) {
    if (classifyWord(focusWords[i]).pos === 'visible') return i;
  }
  return -1;
}

function startFocusMode(): void {
  if (!currentRendition) { toast('Open a book first'); return; }
  focusModeOn = true;
  focusPaused = false;
  el.html.dataset.focusMode = 'on';
  el.focusPanel.hidden = false;
  el.focusModeBtn.classList.add('active');
  updateFocusPlayIcon();

  collectFocusWords();
  // Seek to the first word visible on the current page, so pressing F on
  // page 5 doesn't rewind to page 1 of the chapter.
  const startIdx = findFirstVisibleWordIndex();
  focusIndex = startIdx >= 0 ? startIdx : 0;

  const iframeCount = el.viewer.querySelectorAll('iframe').length;
  console.log(`[focus] iframes=${iframeCount} visibleDoc=${!!focusIframeDoc} words=${focusWords.length} startIdx=${focusIndex}`);

  if (focusWords.length === 0) {
    // Retry once after a beat — the visible iframe may still be settling
    // after a fresh open / theme change.
    window.setTimeout(() => {
      collectFocusWords();
      console.log(`[focus] retry words=${focusWords.length}`);
      if (focusWords.length === 0) {
        toast('Focus mode: no readable text found. Turn a page and try again.');
        stopFocusMode();
        return;
      }
      const retryIdx = findFirstVisibleWordIndex();
      focusIndex = retryIdx >= 0 ? retryIdx : 0;
      focusTick();
    }, 300);
    return;
  }

  focusTick();
  toast(`Focus mode · ${settings.focusModeWpm} wpm`);
}

function stopFocusMode(): void {
  focusModeOn = false;
  focusPaused = false;
  clearTimeout(focusTimer);
  el.html.dataset.focusMode = 'off';
  el.focusPanel.hidden = true;
  el.focusModeBtn.classList.remove('active');
  hideAllHighlights();
}

function toggleFocusPause(): void {
  if (!focusModeOn) return;
  focusPaused = !focusPaused;
  updateFocusPlayIcon();
  if (!focusPaused) scheduleFocusTick();
  else clearTimeout(focusTimer);
}

function updateFocusPlayIcon(): void {
  // When paused, show the play triangle (resume). When playing, show pause bars.
  (el.focusIconPlay as any).hidden = !focusPaused;
  (el.focusIconPause as any).hidden = focusPaused;
}

function stepFocus(delta: number): void {
  if (!focusModeOn) return;
  // focusTick auto-advances to focusIndex, so step by `delta` full words.
  focusIndex = Math.max(0, Math.min(focusWords.length - 1, focusIndex + (delta > 0 ? delta - 1 : delta)));
  focusTick();
}

function setFocusWpm(wpm: number): void {
  settings.focusModeWpm = wpm;
  persistSettings();
  el.focusWpmLabel.textContent = `${wpm} wpm`;
  if (focusModeOn && !focusPaused) scheduleFocusTick();
}

/* ============================================================
   Read-aloud (Text-to-Speech)

   Shares focusWords / classifyWord / paintRange / turnPageAndContinue
   with focus mode, so page-turn logic and word painting are one code
   path. TTS and focus mode are mutually exclusive — starting one
   stops the other.

   Word syncing uses SpeechSynthesisUtterance's `boundary` event
   (Chromium fires this reliably for 'word' events on desktop). We
   build the utterance text from a contiguous run of visible words,
   record each word's char-offset range, and paint the word whose
   range brackets the current boundary charIndex.
   ============================================================ */
type TtsEngine = 'system' | 'piper';

interface TtsSettings {
  engine: TtsEngine;
  rate: number;             // 0.5 – 2.0
  voiceUri: string;         // system engine: SpeechSynthesisVoice.voiceURI; '' = system default
  piperVoicePath: string;   // piper engine: absolute path to .onnx model
  // Piper-only: when true, rate is achieved by piper's `--length-scale` at
  // synth time (natural pitch, requires re-synth on rate change) instead of
  // HTMLAudioElement.playbackRate (instant, but pitch-shifted — chipmunk
  // when fast, unnaturally deep when slow).
  piperNaturalRate: boolean;
}

const DEFAULT_TTS: TtsSettings = {
  engine: 'system',
  rate: 1.0,
  voiceUri: '',
  piperVoicePath: '',
  piperNaturalRate: false,
};
let ttsSettings: TtsSettings = { ...DEFAULT_TTS, ...load<Partial<TtsSettings>>(KEY_TTS, {}) };
const persistTts = () => save(KEY_TTS, ttsSettings);

/* --- Piper engine state ------------------------------------------------ */
interface PiperVoice { path: string; name: string; lang: string; sample_rate: number; }
interface PiperStatus {
  binary_exists: boolean;
  binary_path: string;
  voices_dir: string;
  voices: PiperVoice[];
}

let piperStatus: PiperStatus | null = null;

// --- Local LLM (smart dictionary) -------------------------------------
interface LlmModel { path: string; name: string; size_bytes: number; }
interface LlmStatus {
  binary_exists: boolean;
  binary_path: string;
  models_dir: string;
  models: LlmModel[];
}
let llmStatus: LlmStatus | null = null;

function isLlmReady(): boolean {
  return !!llmStatus && llmStatus.binary_exists && llmStatus.models.length > 0;
}

async function refreshLlmStatus(): Promise<LlmStatus | null> {
  try {
    llmStatus = await invoke<LlmStatus>('llm_status');
  } catch (err) {
    console.warn('llm_status failed:', err);
    llmStatus = null;
  }
  return llmStatus;
}

let piperAudio: HTMLAudioElement | null = null;
let piperAudioUrl: string | null = null;
// rAF handle for the highlight paint loop. See startPiperPaintLoop —
// `timeupdate` fires only ~4×/sec on Chromium, which is ~one word of lag
// at 150 wpm. rAF gives us ~60Hz polling of audio.currentTime instead.
let piperPaintRafId = 0;
// Char-offset → word-index map for the currently playing utterance, plus
// pre-computed per-word start times (seconds) once audio duration is known.
let piperChunkWords: Array<{ wordIdx: number; text: string }> = [];
let piperWordStarts: number[] = [];
let piperLastPaintedWordIdx = -1;
// Advance token used to invalidate in-flight synths when the user hits stop/next.
let piperGenToken = 0;

let ttsOn = false;
let ttsPaused = false;
let ttsVoiceList: SpeechSynthesisVoice[] = [];
let ttsResumeInterval: number | undefined;

// Chunking sizes. We prefer to cut on a sentence boundary (period, question
// mark, exclamation, ellipsis) so the synth engine's own end-of-sentence
// pause lands at the chunk seam. The size range makes sure we never emit a
// super-short chunk (which would waste synth latency on every "Yes." fragment)
// nor a super-long one (which would push first-chunk playback latency).
const TTS_MIN_CHUNK_WORDS = 3;
const TTS_MAX_CHUNK_WORDS = 30;

// Word tokens include trailing punctuation (regex is `\S+`), so we can just
// check the last character of the word after stripping closing quotes /
// brackets. Matches things like `"yes."`, `world!)`, `truly?›`.
const SENTENCE_END_RE = /[.!?…]$/;
const TRAILING_CLOSING_RE = /["'\)\]\}»›"]+$/;
function endsSentence(text: string): boolean {
  return SENTENCE_END_RE.test(text.replace(TRAILING_CLOSING_RE, ''));
}

function isTtsOn(): boolean { return ttsOn; }
function isTtsSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

function isPiperReady(): boolean {
  return !!piperStatus && piperStatus.binary_exists && piperStatus.voices.length > 0;
}

async function refreshPiperStatus(): Promise<PiperStatus | null> {
  try {
    piperStatus = await invoke<PiperStatus>('piper_status');
    return piperStatus;
  } catch (err) {
    console.warn('piper_status failed:', err);
    piperStatus = null;
    return null;
  }
}

function loadVoices() {
  if (!isTtsSupported()) return;
  ttsVoiceList = speechSynthesis.getVoices();
  renderVoiceList();
}

function renderVoiceList() {
  if (!el.ttsVoiceSelect) return;
  el.ttsVoiceSelect.innerHTML = '';

  if (ttsSettings.engine === 'piper') {
    if (!piperStatus || !piperStatus.binary_exists) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = piperStatus ? 'No piper binary — click ⓘ' : 'Loading…';
      opt.disabled = true;
      el.ttsVoiceSelect.appendChild(opt);
      return;
    }
    if (piperStatus.voices.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No voices — click ⓘ';
      opt.disabled = true;
      el.ttsVoiceSelect.appendChild(opt);
      return;
    }
    for (const v of piperStatus.voices) {
      const opt = document.createElement('option');
      opt.value = v.path;
      opt.textContent = v.lang ? `${v.name} (${v.lang})` : v.name;
      if (v.path === ttsSettings.piperVoicePath) opt.selected = true;
      el.ttsVoiceSelect.appendChild(opt);
    }
    // If saved voice no longer exists, fall back to first available.
    if (!piperStatus.voices.some(v => v.path === ttsSettings.piperVoicePath)) {
      ttsSettings.piperVoicePath = piperStatus.voices[0].path;
      persistTts();
      el.ttsVoiceSelect.value = ttsSettings.piperVoicePath;
    }
    return;
  }

  // System engine
  const def = document.createElement('option');
  def.value = '';
  def.textContent = 'System default';
  el.ttsVoiceSelect.appendChild(def);

  // Prefer English voices first — they're overwhelmingly what a Latin-script
  // EPUB will need, and Chromium ships dozens of remote voices that clutter
  // the list.
  const sorted = [...ttsVoiceList].sort((a, b) => {
    const aEn = a.lang.startsWith('en') ? 0 : 1;
    const bEn = b.lang.startsWith('en') ? 0 : 1;
    if (aEn !== bEn) return aEn - bEn;
    return a.name.localeCompare(b.name);
  });

  for (const v of sorted) {
    const opt = document.createElement('option');
    opt.value = v.voiceURI;
    opt.textContent = `${v.name} (${v.lang})`;
    if (v.voiceURI === ttsSettings.voiceUri) opt.selected = true;
    el.ttsVoiceSelect.appendChild(opt);
  }
}

function updateEngineUi() {
  el.ttsEngineSelect.value = ttsSettings.engine;
  // Setup button and natural-rate toggle only make sense for Piper.
  el.ttsSetupBtn.hidden = ttsSettings.engine !== 'piper';
  el.ttsNaturalRateLabel.hidden = ttsSettings.engine !== 'piper';
  el.ttsNaturalRate.checked = ttsSettings.piperNaturalRate;
  renderVoiceList();
  // Cache button visibility depends on both engine and piper readiness —
  // fire-and-forget the async check.
  void refreshCacheButtonForCurrentSection();
}

function getSelectedVoice(): SpeechSynthesisVoice | null {
  if (!ttsSettings.voiceUri) return null;
  return ttsVoiceList.find(v => v.voiceURI === ttsSettings.voiceUri) || null;
}

function startTts(): void {
  if (!currentRendition) { toast('Open a book first'); return; }
  if (ttsSettings.engine === 'system' && !isTtsSupported()) {
    toast('Text-to-speech not supported'); return;
  }
  if (ttsSettings.engine === 'piper' && !isPiperReady()) {
    openPiperSetup();
    toast('Piper needs setup — see the panel');
    return;
  }
  if (isFocusModeOn()) stopFocusMode();     // mutually exclusive

  ttsOn = true;
  ttsPaused = false;
  el.html.dataset.ttsMode = 'on';
  el.ttsPanel.hidden = false;
  el.ttsBtn.classList.add('active');
  updateTtsPlayIcon();

  collectFocusWords();
  const startIdx = findFirstVisibleWordIndex();
  focusIndex = startIdx >= 0 ? startIdx : 0;

  if (focusWords.length === 0) {
    window.setTimeout(() => {
      collectFocusWords();
      if (focusWords.length === 0) {
        toast('Read aloud: no readable text found. Turn a page and try again.');
        stopTts();
        return;
      }
      const retryIdx = findFirstVisibleWordIndex();
      focusIndex = retryIdx >= 0 ? retryIdx : 0;
      speakNextChunk();
    }, 300);
    return;
  }

  speakNextChunk();
  const engineLabel = ttsSettings.engine === 'piper' ? 'Piper' : 'System';
  toast(`Read aloud · ${engineLabel} · ${ttsSettings.rate.toFixed(1)}×`);
}

function stopTts(): void {
  ttsOn = false;
  ttsPaused = false;
  clearTtsResumeKeepAlive();
  if (isTtsSupported()) {
    try { speechSynthesis.cancel(); } catch {}
  }
  stopPiperPlayback();
  stopCachedPlayback();
  el.html.dataset.ttsMode = 'off';
  el.ttsPanel.hidden = true;
  el.ttsBtn.classList.remove('active');
  hideAllHighlights();
}

function pauseTts(): void {
  if (!ttsOn || ttsPaused) return;
  ttsPaused = true;
  if (cachedPlayback) {
    cachedPlayback.audio.pause();
  } else if (ttsSettings.engine === 'piper') {
    piperAudio?.pause();
    // The paint loop self-terminates on the next tick because audio.paused
    // is now true, but calling explicitly saves one wasted animation frame.
    stopPiperPaintLoop();
  } else {
    try { speechSynthesis.pause(); } catch {}
    clearTtsResumeKeepAlive();
  }
  updateTtsPlayIcon();
}

function resumeTts(): void {
  if (!ttsOn || !ttsPaused) return;
  ttsPaused = false;
  if (cachedPlayback) {
    cachedPlayback.audio.play()
      .then(() => startCachedPaintLoop())
      .catch(err => console.warn('resume cached:', err));
  } else if (ttsSettings.engine === 'piper') {
    piperAudio?.play()
      .then(() => startPiperPaintLoop())
      .catch(err => console.warn('resume piper:', err));
  } else {
    try { speechSynthesis.resume(); } catch {}
    installTtsResumeKeepAlive();
  }
  updateTtsPlayIcon();
}

function toggleTtsPause(): void {
  if (!ttsOn) return;
  if (ttsPaused) resumeTts(); else pauseTts();
}

function updateTtsPlayIcon(): void {
  (el.ttsIconPlay as any).hidden = !ttsPaused;
  (el.ttsIconPause as any).hidden = ttsPaused;
}

// Chromium's speech synthesis has a well-documented ~15s bug where the
// utterance silently pauses if it runs long. Poking pause/resume on an
// interval keeps it awake through long paragraphs.
function installTtsResumeKeepAlive(): void {
  clearTtsResumeKeepAlive();
  ttsResumeInterval = window.setInterval(() => {
    if (!ttsOn || ttsPaused) return;
    if (!speechSynthesis.speaking) return;
    try { speechSynthesis.pause(); speechSynthesis.resume(); } catch {}
  }, 12_000);
}

function clearTtsResumeKeepAlive(): void {
  if (ttsResumeInterval !== undefined) {
    clearInterval(ttsResumeInterval);
    ttsResumeInterval = undefined;
  }
}

function stepTts(delta: number): void {
  if (!ttsOn) return;
  focusIndex = Math.max(0, Math.min(focusWords.length - 1, focusIndex + delta));
  cancelCurrentUtterance();
  ttsPaused = false;
  updateTtsPlayIcon();
  speakNextChunk();
}

// Find the focusWords index for a click landing at (container, offset) inside
// the visible iframe. Returns -1 if the click didn't land on a text node we
// track (e.g., between paragraphs, on an image, in an ad-hoc rebuild).
//
// The click may land inside a word's char range (return that word), or in
// whitespace between words (advance to the next word in the same text node),
// or on a different text node entirely (find the next tracked word globally).
function findWordIdxAt(container: Node, offset: number): number {
  // Fast path: click landed inside a tracked word.
  for (let i = 0; i < focusWords.length; i++) {
    const w = focusWords[i];
    if (w.node === container && offset >= w.start && offset <= w.end) return i;
  }
  // Whitespace between words in the same text node — take the next word.
  for (let i = 0; i < focusWords.length; i++) {
    const w = focusWords[i];
    if (w.node === container && w.start >= offset) return i;
  }
  // Different text node — walk forward from the click's DOM position.
  // Cheap heuristic: pick the first tracked word whose node compares
  // after `container` in document order.
  for (let i = 0; i < focusWords.length; i++) {
    const w = focusWords[i];
    const cmp = container.compareDocumentPosition(w.node);
    if (cmp & Node.DOCUMENT_POSITION_FOLLOWING) return i;
  }
  return -1;
}

// Restart TTS playback from a specific focusWords index. Used by click-to-jump
// (and any other feature that wants to seek within the current page). Also
// clears ttsPaused so a click on someone who paused resumes playback from
// the clicked word — matches the expectation of "tap here to hear this."
function jumpTtsToWordIdx(idx: number): void {
  if (!ttsOn) return;
  if (idx < 0 || idx >= focusWords.length) return;
  focusIndex = idx;
  cancelCurrentUtterance();
  ttsPaused = false;
  updateTtsPlayIcon();
  speakNextChunk();
}

function cancelCurrentUtterance(): void {
  try { speechSynthesis.cancel(); } catch {}
  stopPiperPlayback();
  stopCachedPlayback();
}

function setTtsRate(rate: number): void {
  ttsSettings.rate = Math.max(0.5, Math.min(2, rate));
  persistTts();
  el.ttsRateLabel.textContent = `${ttsSettings.rate.toFixed(1)}×`;
  if (!ttsOn) return;

  if (ttsSettings.engine === 'piper') {
    if (ttsSettings.piperNaturalRate) {
      // Natural-rate mode: rate is baked into the audio at synth time
      // (length_scale). Old audio has the wrong duration — re-synth from
      // the current position. There will be a small stutter here; that's
      // the deal the user accepts by enabling natural rate.
      cancelCurrentUtterance();
      speakNextChunk();
    } else {
      // Fast-toggle mode: just adjust playbackRate on the current + prefetched
      // audio. No gap, no re-synth. Pitch shifts.
      if (piperAudio) piperAudio.playbackRate = ttsSettings.rate;
      if (piperPrefetched) piperPrefetched.audio.playbackRate = ttsSettings.rate;
    }
  } else {
    // System engine: rate is baked into the utterance at speak() time, so
    // an in-flight utterance won't pick up a new rate. Cancel + resume.
    cancelCurrentUtterance();
    speakNextChunk();
  }
}

// Called when the natural-rate checkbox toggles. If TTS is playing on
// piper, re-synth so audio picks up the new mode.
function setTtsPiperNaturalRate(on: boolean): void {
  ttsSettings.piperNaturalRate = on;
  persistTts();
  if (ttsOn && ttsSettings.engine === 'piper') {
    cancelCurrentUtterance();
    speakNextChunk();
  }
}

function setTtsVoice(value: string): void {
  if (ttsSettings.engine === 'piper') {
    ttsSettings.piperVoicePath = value;
  } else {
    ttsSettings.voiceUri = value;
  }
  persistTts();
  if (ttsOn) {
    cancelCurrentUtterance();
    speakNextChunk();
  }
}

async function openPiperSetup(): Promise<void> {
  el.piperSetupModal.hidden = false;
  hidePiperError();
  el.piperBinaryStatus.textContent = 'Checking…';
  el.piperBinaryStatus.className = 'piper-status';
  el.piperVoicesStatus.textContent = 'Checking…';
  el.piperVoicesStatus.className = 'piper-status';
  el.piperPath.textContent = '—';
  await refreshPiperStatus();
  renderPiperSetupModal();
  updateEngineUi();
}

function closePiperSetup(): void { el.piperSetupModal.hidden = true; }

function renderPiperSetupModal(): void {
  const s = piperStatus;
  if (!s) {
    el.piperBinaryStatus.textContent = 'Could not read piper folder';
    el.piperBinaryStatus.className = 'piper-status err';
    el.piperVoicesStatus.textContent = '—';
    el.piperVoicesStatus.className = 'piper-status';
    el.piperVoiceCatalog.innerHTML = '';
    return;
  }

  el.piperPath.textContent = s.voices_dir.replace(/\\voices$/i, '').replace(/\/voices$/, '');

  if (s.binary_exists) {
    el.piperBinaryStatus.textContent = 'Binary installed';
    el.piperBinaryStatus.className = 'piper-status ok';
    el.piperInstallBinaryBtn.textContent = 'Re-install';
  } else {
    el.piperBinaryStatus.textContent = 'Not installed (~30 MB download)';
    el.piperBinaryStatus.className = 'piper-status warn';
    el.piperInstallBinaryBtn.textContent = 'Install';
  }

  if (s.voices.length === 0) {
    el.piperVoicesStatus.textContent = 'No voices installed — pick one below';
    el.piperVoicesStatus.className = 'piper-status warn';
  } else {
    el.piperVoicesStatus.textContent = `${s.voices.length} voice${s.voices.length === 1 ? '' : 's'} installed`;
    el.piperVoicesStatus.className = 'piper-status ok';
  }

  renderVoiceCatalog();
}

/* --- Piper: automated install ------------------------------------------
   The user shouldn't have to hand-download three files from two sites,
   figure out which zip is theirs, and drop DLLs into the right folder.
   We host that flow inside the setup modal:
     - a single "Install" button downloads the correct release zip for
       the current OS/arch and extracts it into the piper root.
     - a curated voice catalog shows popular voices with per-row download
       buttons that stream both files into voices/.
   ---------------------------------------------------------------------- */
interface CatalogVoice {
  id: string;           // full piper voice id, e.g. "en_US-lessac-medium"
  label: string;        // human display name
  desc: string;         // one-line character
  lang: string;         // country subfolder in the HF repo
  langGroup: string;    // language subfolder in the HF repo
  speaker: string;      // speaker subfolder
  quality: 'low' | 'medium' | 'high';
  sizeMb: number;       // rough .onnx size for progress messaging
}

// Small, opinionated set. Full catalog is at
// https://huggingface.co/rhasspy/piper-voices/tree/main
const PIPER_CATALOG: CatalogVoice[] = [
  { id: 'en_US-lessac-medium',   label: 'Lessac (US, female)',       desc: 'Clear, neutral',           lang: 'en_US', langGroup: 'en', speaker: 'lessac',   quality: 'medium', sizeMb: 63 },
  { id: 'en_US-libritts_r-medium', label: 'LibriTTS-R (US, female)', desc: 'Warm, expressive',        lang: 'en_US', langGroup: 'en', speaker: 'libritts_r', quality: 'medium', sizeMb: 63 },
  { id: 'en_US-ryan-medium',     label: 'Ryan (US, male)',            desc: 'Conversational',           lang: 'en_US', langGroup: 'en', speaker: 'ryan',     quality: 'medium', sizeMb: 63 },
  { id: 'en_US-amy-medium',      label: 'Amy (US, female)',           desc: 'Friendly, animated',       lang: 'en_US', langGroup: 'en', speaker: 'amy',      quality: 'medium', sizeMb: 63 },
  { id: 'en_GB-alan-medium',     label: 'Alan (UK, male)',            desc: 'British, calm',            lang: 'en_GB', langGroup: 'en', speaker: 'alan',     quality: 'medium', sizeMb: 63 },
  { id: 'en_GB-northern_english_male-medium', label: 'Northern English male', desc: 'UK regional',      lang: 'en_GB', langGroup: 'en', speaker: 'northern_english_male', quality: 'medium', sizeMb: 63 },
  { id: 'en_US-hfc_female-medium', label: 'HFC (US, female)',         desc: 'Natural, HuggingFace',     lang: 'en_US', langGroup: 'en', speaker: 'hfc_female', quality: 'medium', sizeMb: 63 },
  { id: 'en_US-lessac-high',     label: 'Lessac (US, female, high)',  desc: 'Higher quality, larger',   lang: 'en_US', langGroup: 'en', speaker: 'lessac',   quality: 'high',   sizeMb: 114 },
];

function voiceOnnxUrl(v: CatalogVoice): string {
  return `https://huggingface.co/rhasspy/piper-voices/resolve/main/${v.langGroup}/${v.lang}/${v.speaker}/${v.quality}/${v.id}.onnx`;
}
function voiceJsonUrl(v: CatalogVoice): string {
  return `${voiceOnnxUrl(v)}.json`;
}

// GitHub redirects `/releases/latest/download/<name>` to the current release
// asset. The archive names have been stable across piper releases.
function piperBinaryUrl(): { url: string; archiveName: string } | null {
  const ua = navigator.userAgent;
  const platform = (navigator as any).userAgentData?.platform || '';
  const isWindows = /Windows/i.test(ua);
  const isMac = /Mac/i.test(ua) || platform === 'macOS';
  const isLinux = /Linux/i.test(ua) && !/Android/i.test(ua);

  if (isWindows) {
    return {
      url: 'https://github.com/rhasspy/piper/releases/latest/download/piper_windows_amd64.zip',
      archiveName: '_piper_download.zip',
    };
  }
  if (isMac) {
    // Chromium/WebView2 doesn't reliably surface arm64 in UA; default to
    // universal-if-available, else x64. If wrong, user can hand-download.
    const isArm = /arm64|aarch64/i.test(ua) || /Mac.*ARM/i.test(platform);
    const asset = isArm ? 'piper_macos_aarch64.tar.gz' : 'piper_macos_x64.tar.gz';
    return {
      url: `https://github.com/rhasspy/piper/releases/latest/download/${asset}`,
      archiveName: `_piper_download.${asset.endsWith('.zip') ? 'zip' : 'tar.gz'}`,
    };
  }
  if (isLinux) {
    return {
      url: 'https://github.com/rhasspy/piper/releases/latest/download/piper_linux_x86_64.tar.gz',
      archiveName: '_piper_download.tar.gz',
    };
  }
  return null;
}

// Track in-flight downloads so we don't launch duplicates when a button is
// clicked twice. Values are truthy sentinels; the Rust side owns the actual
// curl process and there's no cancel path currently (curl runs to completion
// or errors out on its own timeout).
const activeDownloads = new Map<string, boolean>();

// Download `url` into `<piper_root>/<relPath>` via the Rust curl command,
// while polling the destination file's size every 500ms to render live
// progress. We don't know the total size up front — the UI shows bytes
// downloaded, and (if `estimateMb` is provided) an approximate percentage.
async function downloadFileWithProgress(
  url: string,
  relPath: string,
  onProgress: (received: number, estimateBytes: number) => void,
  estimateMb = 0,
): Promise<void> {
  const estimateBytes = estimateMb > 0 ? estimateMb * 1024 * 1024 : 0;
  let cancelled = false;

  const poll = window.setInterval(async () => {
    if (cancelled) return;
    try {
      const size = await invoke<number>('piper_file_size', { relPath });
      onProgress(size, estimateBytes);
    } catch { /* file not yet written */ }
  }, 500);

  try {
    const finalSize = await invoke<number>('piper_download_file', { url, relPath });
    onProgress(finalSize, finalSize);
  } finally {
    cancelled = true;
    clearInterval(poll);
  }
}

function showPiperError(message: string): void {
  el.piperErrorBody.textContent = message;
  el.piperErrorBanner.hidden = false;
}
function hidePiperError(): void { el.piperErrorBanner.hidden = true; }

// Format bytes as "12.3 MB" for the progress label.
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// UI helper: update a progress bar + label element.
function paintProgress(container: HTMLElement, received: number, total: number, phase: string) {
  const bar = container.querySelector<HTMLSpanElement>('.piper-progress-bar span');
  const label = container.querySelector<HTMLDivElement>('.piper-progress-label');
  if (bar) {
    const pct = total > 0 ? Math.min(100, (received / total) * 100) : 0;
    bar.style.width = `${pct}%`;
  }
  if (label) {
    if (total > 0) {
      label.textContent = `${phase} · ${fmtBytes(received)} / ${fmtBytes(total)}`;
    } else {
      label.textContent = `${phase} · ${fmtBytes(received)}`;
    }
  }
}

// Ensure the piper root exists before we start writing into it — the fs
// plugin's write won't auto-create parent directories.
async function ensurePiperDirs(): Promise<void> {
  const roots = ['piper', 'piper/voices'];
  for (const p of roots) {
    if (!(await exists(p, { baseDir: BaseDirectory.AppData }))) {
      await mkdir(p, { baseDir: BaseDirectory.AppData, recursive: true });
    }
  }
}

async function installPiperBinary(): Promise<void> {
  const spec = piperBinaryUrl();
  if (!spec) {
    showPiperError('Could not detect your OS. Download piper manually and drop it in the folder below.');
    return;
  }
  if (activeDownloads.has('binary')) return;
  activeDownloads.set('binary', true);

  hidePiperError();
  el.piperInstallBinaryBtn.disabled = true;
  el.piperBinaryProgress.hidden = false;
  paintProgress(el.piperBinaryProgress, 0, 30 * 1024 * 1024, 'Starting…');

  try {
    await ensurePiperDirs();

    // relPath is piper-root-relative (Rust joins onto piper_root()) — so no
    // leading "piper/" here, otherwise we'd write into piper/piper/ and the
    // extract step wouldn't find the archive.
    const relPath = spec.archiveName;
    // ~30MB is the typical piper release size — the poll will resolve to
    // the exact size once curl finishes, so the estimate only affects the
    // in-flight progress bar.
    await downloadFileWithProgress(
      spec.url,
      relPath,
      (r, est) => paintProgress(el.piperBinaryProgress, r, est, 'Downloading'),
      30,
    );

    paintProgress(el.piperBinaryProgress, 1, 1, 'Extracting');
    await invoke('piper_extract_downloaded_archive', { archiveName: spec.archiveName });

    paintProgress(el.piperBinaryProgress, 1, 1, 'Done');
    toast('Piper installed');
  } catch (err: any) {
    const msg = typeof err === 'string' ? err : (err?.message || String(err));
    console.error('piper install failed:', err);
    showPiperError(msg);
  } finally {
    activeDownloads.delete('binary');
    el.piperInstallBinaryBtn.disabled = false;
    setTimeout(() => { el.piperBinaryProgress.hidden = true; }, 1200);
    await refreshPiperStatus();
    renderPiperSetupModal();
    updateEngineUi();
  }
}

// Cancellation currently isn't wired to the Rust side (curl runs to
// completion or its own timeout), so this button is a no-op placeholder.
// Left in the DOM in case we add real cancellation later.
function cancelPiperBinaryInstall(): void {
  toast('Install runs to completion; wait or restart the app');
}

async function installPiperVoice(voice: CatalogVoice, row: HTMLElement): Promise<void> {
  const key = `voice:${voice.id}`;
  if (activeDownloads.has(key)) return;
  activeDownloads.set(key, true);

  hidePiperError();
  const btn = row.querySelector<HTMLButtonElement>('.piper-mini-btn');
  const progress = row.querySelector<HTMLElement>('.piper-progress');
  if (btn) { btn.disabled = true; btn.textContent = 'Downloading…'; }
  if (progress) {
    progress.hidden = false;
    paintProgress(progress, 0, voice.sizeMb * 1024 * 1024, 'Model');
  }

  try {
    await ensurePiperDirs();

    // Paths are piper-root-relative (Rust joins onto piper_root()), so no
    // leading "piper/" prefix here.
    // .onnx is the big one — track progress against the catalog size estimate.
    await downloadFileWithProgress(
      voiceOnnxUrl(voice),
      `voices/${voice.id}.onnx`,
      (r, est) => progress && paintProgress(progress, r, est, 'Model'),
      voice.sizeMb,
    );

    // .onnx.json is a few KB — skip the polling overhead.
    if (progress) paintProgress(progress, 1, 1, 'Config');
    await invoke<number>('piper_download_file', {
      url: voiceJsonUrl(voice),
      relPath: `voices/${voice.id}.onnx.json`,
    });

    if (progress) paintProgress(progress, 1, 1, 'Done');
    toast(`Installed ${voice.label}`);
  } catch (err: any) {
    const msg = typeof err === 'string' ? err : (err?.message || String(err));
    console.error('voice install failed:', err);
    showPiperError(`${voice.label}: ${msg}`);
    if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
  } finally {
    activeDownloads.delete(key);
    await refreshPiperStatus();
    renderPiperSetupModal();
    updateEngineUi();
  }
}

// Render the curated voice catalog. Installed voices get an "Installed" tag
// and disabled button; downloadable ones show a size hint + install button.
function renderVoiceCatalog(): void {
  const installedIds = new Set(
    (piperStatus?.voices || []).map(v => v.name),
  );
  el.piperVoiceCatalog.innerHTML = '';
  for (const voice of PIPER_CATALOG) {
    const li = document.createElement('li');
    li.className = 'piper-voice-row' + (installedIds.has(voice.id) ? ' installed' : '');
    li.innerHTML = `
      <div class="piper-voice-meta">
        <span class="piper-voice-name">${escapeHtml(voice.label)}</span>
        <span class="piper-voice-desc">${escapeHtml(voice.desc)} · ${voice.sizeMb} MB</span>
      </div>
      <div class="piper-voice-action">
        <div class="piper-progress" hidden>
          <div class="piper-progress-bar"><span></span></div>
          <div class="piper-progress-label">—</div>
        </div>
        ${installedIds.has(voice.id)
          ? '<span class="installed-tag">Installed</span>'
          : '<button class="piper-mini-btn" type="button">Install</button>'}
      </div>
    `;
    const btn = li.querySelector<HTMLButtonElement>('.piper-mini-btn');
    if (btn) btn.addEventListener('click', () => installPiperVoice(voice, li));
    el.piperVoiceCatalog.appendChild(li);
  }
}

async function setTtsEngine(engine: TtsEngine): Promise<void> {
  ttsSettings.engine = engine;
  persistTts();
  if (engine === 'piper' && !piperStatus) await refreshPiperStatus();
  updateEngineUi();
  if (ttsOn) {
    cancelCurrentUtterance();
    speakNextChunk();
  }
}

type ChunkWord = { wordIdx: number; text: string };

// Collect a chunk of visible words starting at `startIdx` in focusWords.
// Prefers to cut on a sentence boundary — periods/question marks/exclamations
// give the synth engine (Piper or Web Speech) a natural pause to render, and
// chunk seams that land on those pauses sound natural instead of clipped.
//
// Rules:
//   - Stop at first sentence terminator after we have >= MIN words.
//   - Hard cap at MAX words if no terminator shows up (very long sentence,
//     bullet list without periods, etc.).
//   - Stop early if we hit an off-page word ('after' → page turn needed).
//
// Doesn't mutate focusIndex — callers advance it when the chunk is committed.
function collectVisibleChunkFrom(startIdx: number): { words: ChunkWord[]; hitAfter: boolean } {
  const words: ChunkWord[] = [];
  let idx = startIdx;
  let hitAfter = false;
  while (idx < focusWords.length && words.length < TTS_MAX_CHUNK_WORDS) {
    const fw = focusWords[idx];
    const { pos } = classifyWord(fw);
    if (pos === 'visible') {
      const text = (fw.node.textContent || '').slice(fw.start, fw.end);
      const trimmed = text.trim();
      if (trimmed) {
        words.push({ wordIdx: idx, text });
        idx++;
        // Ending the chunk here means the utterance passed to the synth
        // engine finishes with `.` / `?` / `!`, and the engine's own
        // trailing-silence at sentence end lands at the chunk boundary.
        // This is what makes back-to-back chunks sound like natural speech.
        if (words.length >= TTS_MIN_CHUNK_WORDS && endsSentence(trimmed)) {
          return { words, hitAfter };
        }
      } else {
        idx++;
      }
    } else if (pos === 'before' || pos === 'gone') {
      idx++;
    } else {
      hitAfter = true;
      break;
    }
  }
  return { words, hitAfter };
}

// Speak the next chunk starting at (or after) focusIndex. Handles page
// turns transparently when there's nothing visible left to read. Dispatches
// to the currently-selected engine.
function speakNextChunk(): void {
  if (!ttsOn) return;

  // Refresh word list if the visible iframe has swapped (page turn).
  const visIframe = getVisibleIframe();
  if (visIframe && visIframe.contentDocument !== focusIframeDoc) {
    collectFocusWords();
    focusIndex = 0;
  }

  // If we have a cached WAV for the current section+voice, prefer it —
  // audio playback is instant, no synth latency. Fires async but we
  // don't wait; if it succeeds it takes over playback, if it fails
  // (miss, IO error, etc.) it returns false and we fall through to the
  // pipelined synth path.
  if (!cachedPlayback && ttsSettings.engine === 'piper') {
    tryStartCachedPlayback().then(started => {
      if (started) return;
      speakNextChunkPipelined();
    });
    return;
  }
  if (cachedPlayback) return;   // playback is already going via cached audio
  speakNextChunkPipelined();
}

// The classic pipelined path — extracted so speakNextChunk can decide
// between cached and pipelined without duplicating this.
function speakNextChunkPipelined(): void {
  if (!ttsOn) return;

  // Skip forward past 'before' and 'gone' words. First 'after' means we
  // need to turn a page.
  let startIdx = -1;
  while (focusIndex < focusWords.length) {
    const { pos } = classifyWord(focusWords[focusIndex]);
    if (pos === 'visible') { startIdx = focusIndex; break; }
    if (pos === 'before' || pos === 'gone') { focusIndex++; continue; }
    if (pos === 'after') break;
  }

  if (startIdx === -1) {
    turnPageAndContinue(() => speakNextChunk());
    return;
  }

  const { words } = collectVisibleChunkFrom(startIdx);
  if (words.length === 0) {
    turnPageAndContinue(() => speakNextChunk());
    return;
  }

  if (ttsSettings.engine === 'piper') {
    speakPiperChunk(words);
  } else {
    speakSystemChunk(words);
  }
}

/* --- System engine ----------------------------------------------------- */
// Pipelining strategy for system TTS: build utterance N, then have its
// onstart handler build+queue utterance N+1 into speechSynthesis's own
// queue. Chromium plays queued utterances back-to-back with no gap —
// this eliminates the 200-300ms hiccup at chunk boundaries that used to
// come from waiting for onend before building the next utterance.
//
// Cancellation: `speechSynthesis.cancel()` drops all queued utterances,
// so a stop/step still works cleanly. We also tag each utterance with a
// token so a cancelled utterance's late-arriving onend can't advance
// focusIndex behind the user's back.

function buildSystemUtterance(chunkWords: ChunkWord[], token: number): SpeechSynthesisUtterance {
  let text = '';
  const map: Array<{ wordIdx: number; charStart: number; charEnd: number }> = [];
  for (let i = 0; i < chunkWords.length; i++) {
    if (i > 0) text += ' ';
    const start = text.length;
    text += chunkWords[i].text;
    map.push({ wordIdx: chunkWords[i].wordIdx, charStart: start, charEnd: text.length });
  }

  const u = new SpeechSynthesisUtterance(text);
  u.rate = ttsSettings.rate;
  const voice = getSelectedVoice();
  if (voice) { u.voice = voice; u.lang = voice.lang; }

  u.onstart = () => {
    if (token !== piperGenToken || !ttsOn) return;
    // Queue the next chunk RIGHT NOW so Chromium plays them back-to-back.
    // Only if there are more visible words on this page — page turns must
    // happen after playback ends, in onend/speakNextChunk.
    if (systemQueuedAhead) return;   // already have one queued
    const lastWordIdx = chunkWords[chunkWords.length - 1].wordIdx;
    const next = collectVisibleChunkFrom(lastWordIdx + 1);
    if (next.words.length === 0) return;
    const nextU = buildSystemUtterance(next.words, token);
    systemQueuedAhead = true;
    speechSynthesis.speak(nextU);
  };

  u.onboundary = (e: SpeechSynthesisEvent) => {
    if (e.name && e.name !== 'word') return;
    if (token !== piperGenToken) return;
    const charIdx = e.charIndex ?? 0;
    for (const w of map) {
      if (charIdx >= w.charStart && charIdx < w.charEnd) {
        const fw = focusWords[w.wordIdx];
        if (!fw) return;
        const { pos, range, rect } = classifyWord(fw);
        if (pos === 'visible' && range && rect) paintRange(range, rect, w.wordIdx);
        focusIndex = w.wordIdx;
        return;
      }
    }
  };

  u.onend = () => {
    if (!ttsOn || token !== piperGenToken) return;
    focusIndex = chunkWords[chunkWords.length - 1].wordIdx + 1;
    // If a queued utterance is already playing, its onstart will handle the
    // rest — don't kick off another speakNextChunk or we'd double-speak.
    systemQueuedAhead = false;
    if (speechSynthesis.speaking || speechSynthesis.pending) return;
    speakNextChunk();
  };

  u.onerror = (e: SpeechSynthesisErrorEvent) => {
    // 'interrupted' / 'canceled' happen every time we cancel to step/change
    // voice — not a real error.
    if (e.error === 'interrupted' || e.error === 'canceled') return;
    console.warn('TTS error:', e.error);
    toast(`Read aloud error: ${e.error}`);
    stopTts();
  };

  return u;
}

// True while the follow-up utterance for the current chunk is already
// sitting in speechSynthesis.speak's internal queue.
let systemQueuedAhead = false;

function speakSystemChunk(chunkWords: ChunkWord[]): void {
  const token = ++piperGenToken;
  systemQueuedAhead = false;
  const u = buildSystemUtterance(chunkWords, token);
  try { speechSynthesis.cancel(); } catch {}
  speechSynthesis.speak(u);
  installTtsResumeKeepAlive();
}

/* --- Piper engine ------------------------------------------------------ */
// Estimate a syllable count for a word — used as the weight when distributing
// word start times across the audio duration. Rough heuristic, applied to
// millions of words, so worth getting right beyond just "count vowel groups."
//
// Two common overcounts fixed here:
//   1. Silent trailing 'e': "gate", "wine", "hope" — regex counts 2 vowel
//      groups (a + e) but the 'e' is silent, so 1 syllable.
//      Exception: "-le" after a consonant IS its own syllable — "table" is
//      2 syllables and needs the 'e'.
//   2. Silent trailing 'ed': "loved", "walked" — regex counts 2 groups (o+e)
//      but the 'ed' is a single unvoiced coda, so 1 syllable.
//      Exception: after 't' or 'd', '-ed' IS voiced — "waited", "landed".
function syllableWeight(word: string): number {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length === 0) return 1;

  // Silent '-ed' ending. Check BEFORE the silent-e pass so "loved" strips
  // "ed" (giving "lov" → 1 group) instead of stripping just "e" (giving
  // "lovd" → still 1 group, same result but semantically cleaner).
  if (w.length > 3 && w.endsWith('ed') && !/[td]/.test(w[w.length - 3])) {
    w = w.slice(0, -2);
  }

  // Silent trailing 'e', unless it's the voiced 'e' in "-le" after a consonant.
  if (w.length > 3 && w.endsWith('e')) {
    const isVoicedLE = w.endsWith('le') && !/[aeiouy]/.test(w[w.length - 3]);
    if (!isVoicedLE) w = w.slice(0, -1);
  }

  const groups = w.match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 0);
}

// A ready-to-play chunk — audio + word bookkeeping. Used both for the
// currently-playing chunk and the prefetched next-up chunk.
interface PreparedPiperChunk {
  token: number;
  words: ChunkWord[];
  audio: HTMLAudioElement;
  url: string;
}

// Prefetched next chunk (may be null if there's nothing to prefetch, e.g.
// current chunk was the last on the page and the next chunk requires a
// page turn — those are handled in the ended path by speakNextChunk).
let piperPrefetched: PreparedPiperChunk | null = null;

/* --- Cached chapter playback ("audiobook mode") ----------------------
   When the user hits the cache button we synthesize the whole chapter to
   a single WAV on disk. On the next TTS start we skip the pipelined synth
   path entirely and play the cached file, seeking to the currently visible
   sentence. Playback is instant, has no chunk seams, and survives sessions.
   Highlighting is coarser than pipelined mode — sentence-level only —
   because we don't have per-word alignment for the whole chapter.
   ----------------------------------------------------------------------- */
interface CachedChapter {
  rel_path: string;
  sentence_starts: number[];
  total_duration: number;
  sample_rate: number;
}

interface CachedPlayback {
  chapter: CachedChapter;
  audio: HTMLAudioElement;
  url: string;
  sectionKey: string;
  // Words in the section joined by index, split into sentences, so we can
  // paint a sentence's word-range in focusWords when its start time
  // becomes current.
  sentenceRanges: Array<{ startWordIdx: number; endWordIdx: number }>;
  lastPaintedSentence: number;
}

let cachedPlayback: CachedPlayback | null = null;
let cachedRafId = 0;
// Section key of the currently displayed section, updated on relocated.
// Used to look up cache and to know when the user has moved to a section
// we don't have cached (in which case we fall back to pipelined).
let currentSectionKey: string | null = null;

function stopPiperPlayback(): void {
  piperGenToken++;
  stopPiperPaintLoop();
  if (piperAudio) {
    piperAudio.onended = null;
    piperAudio.onerror = null;
    piperAudio.ontimeupdate = null;
    piperAudio.onplaying = null;
    piperAudio.onloadedmetadata = null;
    piperAudio.pause();
    piperAudio.src = '';
    piperAudio = null;
  }
  if (piperAudioUrl) {
    URL.revokeObjectURL(piperAudioUrl);
    piperAudioUrl = null;
  }
  if (piperPrefetched) {
    piperPrefetched.audio.pause();
    piperPrefetched.audio.src = '';
    URL.revokeObjectURL(piperPrefetched.url);
    piperPrefetched = null;
  }
  piperChunkWords = [];
  piperWordStarts = [];
  piperLastPaintedWordIdx = -1;
}

// rAF-driven highlight painter. Runs while Piper audio is playing, reads
// audio.currentTime each animation frame, and paints the word whose
// estimated start time is at or before the current audio position. This
// replaces the old ontimeupdate-based painter, which was pinned at
// Chromium's 4Hz update rate and caused the highlight to lag by up to a
// full word behind the spoken audio.
function stopPiperPaintLoop(): void {
  if (piperPaintRafId) {
    cancelAnimationFrame(piperPaintRafId);
    piperPaintRafId = 0;
  }
}

function startPiperPaintLoop(): void {
  stopPiperPaintLoop();
  const tick = () => {
    piperPaintRafId = 0;
    if (!ttsOn || !piperAudio || piperWordStarts.length === 0) return;
    if (piperAudio.paused || piperAudio.ended) return;

    const t = piperAudio.currentTime;
    let idx = piperLastPaintedWordIdx < 0 ? 0 : piperLastPaintedWordIdx;
    while (idx + 1 < piperWordStarts.length && piperWordStarts[idx + 1] <= t) idx++;
    if (idx !== piperLastPaintedWordIdx) {
      piperLastPaintedWordIdx = idx;
      const wordIdx = piperChunkWords[idx].wordIdx;
      const fw = focusWords[wordIdx];
      if (fw) {
        const { pos, range, rect } = classifyWord(fw);
        if (pos === 'visible' && range && rect) paintRange(range, rect, wordIdx);
        focusIndex = wordIdx;
      }
    }

    piperPaintRafId = requestAnimationFrame(tick);
  };
  piperPaintRafId = requestAnimationFrame(tick);
}

// Synthesize a chunk into a ready-to-play (but not yet playing) audio
// element. Returns null on failure or if the caller's token got invalidated
// (user stopped / stepped / changed voice while we were waiting).
// In "natural rate" mode, we ask piper to render slower/faster audio directly
// via --length-scale (larger = slower). Playback then runs at 1× — pitch is
// preserved because the model actually synthesizes the longer duration.
// Otherwise, length_scale stays at 1.0 and we speed/slow via HTMLAudioElement
// playbackRate — instant, but pitch-shifted.
function currentPiperLengthScale(): number {
  return ttsSettings.piperNaturalRate ? (1 / ttsSettings.rate) : 1.0;
}
function currentPiperPlaybackRate(): number {
  return ttsSettings.piperNaturalRate ? 1.0 : ttsSettings.rate;
}

async function synthesizePiperChunk(
  chunkWords: ChunkWord[],
  token: number,
): Promise<PreparedPiperChunk | null> {
  const voice = ttsSettings.piperVoicePath;
  if (!voice) return null;
  const text = chunkWords.map(w => w.text).join(' ');
  let wavBytes: Uint8Array;
  try {
    const result = await invoke<number[] | Uint8Array>('piper_synthesize', {
      text,
      voicePath: voice,
      lengthScale: currentPiperLengthScale(),
    });
    wavBytes = result instanceof Uint8Array ? result : new Uint8Array(result);
  } catch (err) {
    console.error('piper_synthesize failed:', err);
    return null;
  }
  if (!ttsOn || token !== piperGenToken) return null;

  const blob = new Blob([wavBytes.buffer as ArrayBuffer], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.playbackRate = currentPiperPlaybackRate();
  audio.preload = 'auto';   // start loading metadata immediately
  return { token, words: chunkWords, audio, url };
}

// Wire event handlers on a prepared chunk and start playback. This is the
// single place that promotes a PreparedPiperChunk to being the "current"
// chunk — used both for the initial chunk in speakPiperChunk and for the
// prefetched follow-up in the previous chunk's onended.
function playPreparedPiperChunk(prepared: PreparedPiperChunk): void {
  if (!ttsOn || prepared.token !== piperGenToken) {
    URL.revokeObjectURL(prepared.url);
    return;
  }

  // Retire the previous audio element (if any) before adopting the new one.
  // Detach handlers FIRST — `src = ''` synthesizes an `error` event on the
  // <audio> element in Chromium, and if the stale onerror handler is still
  // attached it fires stopTts() and kills the whole session. That was the
  // "plays a few words then silence" bug after enabling pipelining.
  if (piperAudio && piperAudio !== prepared.audio) {
    piperAudio.onended = null;
    piperAudio.onerror = null;
    piperAudio.ontimeupdate = null;
    piperAudio.onplaying = null;
    piperAudio.onloadedmetadata = null;
    piperAudio.pause();
    piperAudio.src = '';
  }
  if (piperAudioUrl && piperAudioUrl !== prepared.url) {
    URL.revokeObjectURL(piperAudioUrl);
  }

  piperAudio = prepared.audio;
  piperAudioUrl = prepared.url;
  piperChunkWords = prepared.words;
  piperWordStarts = [];
  piperLastPaintedWordIdx = -1;

  const computeWordStarts = () => {
    const dur = piperAudio?.duration || 0;
    if (!isFinite(dur) || dur <= 0) return;
    const weights = prepared.words.map(w => syllableWeight(w.text));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    piperWordStarts = [];
    for (const w of weights) {
      piperWordStarts.push((acc / total) * dur);
      acc += w;
    }
  };

  // A prefetched audio may already have metadata loaded (readyState >=1).
  if ((piperAudio.readyState || 0) >= 1) computeWordStarts();
  else piperAudio.onloadedmetadata = computeWordStarts;

  // Highlight painting runs off the rAF loop below (started in onplaying).
  // No more ontimeupdate — it fired too rarely to keep the cursor tight
  // against the spoken audio.

  // As soon as the current chunk starts playing, kick off synthesis of
  // the next chunk in parallel AND start the rAF loop that tracks the
  // audio cursor. rAF gives ~60Hz polling of currentTime — vs the ~4Hz
  // of timeupdate — so the highlight lands within one frame of the
  // spoken word instead of trailing by up to ~250ms.
  piperAudio.onplaying = () => {
    startPiperPaintLoop();
    if (piperPrefetched) return;
    const lastWordIdx = prepared.words[prepared.words.length - 1].wordIdx;
    // Fire-and-forget — errors just mean we fall back to synth-on-demand.
    void prefetchNextPiperChunk(lastWordIdx, prepared.token);
  };

  piperAudio.onended = () => {
    if (!ttsOn || prepared.token !== piperGenToken) return;
    focusIndex = prepared.words[prepared.words.length - 1].wordIdx + 1;

    // If we have a prefetched next chunk ready, play it directly with no
    // gap. Otherwise fall back to the standard flow (which handles page
    // turns and re-collecting words on the new page).
    const next = piperPrefetched;
    piperPrefetched = null;
    if (next && next.token === piperGenToken) {
      // Don't revoke the current URL yet — playPreparedPiperChunk swaps
      // pointers and handles cleanup of the old audio/url atomically.
      playPreparedPiperChunk(next);
      return;
    }

    // No prefetch — free current blob and take the slow path.
    if (piperAudioUrl) { URL.revokeObjectURL(piperAudioUrl); piperAudioUrl = null; }
    piperAudio = null;
    speakNextChunk();
  };

  piperAudio.onerror = () => {
    console.warn('piper audio error');
    if (ttsOn) stopTts();
  };

  piperAudio.play().catch(err => {
    console.warn('piper play failed:', err);
    if (ttsOn) stopTts();
  });
}

async function prefetchNextPiperChunk(afterWordIdx: number, token: number): Promise<void> {
  if (piperPrefetched || !ttsOn || token !== piperGenToken) return;

  // Peek at the next chunk without advancing focusIndex — the current
  // audio is still using the current chunk's coordinates. If there's
  // nothing visible left on this page, don't prefetch; the onended path
  // will trigger a page turn.
  const next = collectVisibleChunkFrom(afterWordIdx + 1);
  if (next.words.length === 0) return;

  const prepared = await synthesizePiperChunk(next.words, token);
  if (!prepared) return;
  if (!ttsOn || token !== piperGenToken) {
    URL.revokeObjectURL(prepared.url);
    return;
  }
  piperPrefetched = prepared;
}

async function speakPiperChunk(chunkWords: ChunkWord[]): Promise<void> {
  const voice = ttsSettings.piperVoicePath;
  if (!voice) { toast('Pick a Piper voice first'); stopTts(); return; }

  const token = ++piperGenToken;
  // Any pre-existing prefetch is from a stale generation — drop it.
  if (piperPrefetched) {
    URL.revokeObjectURL(piperPrefetched.url);
    piperPrefetched = null;
  }

  const prepared = await synthesizePiperChunk(chunkWords, token);
  if (!prepared) {
    if (ttsOn) { toast('Piper synth failed'); stopTts(); }
    return;
  }
  playPreparedPiperChunk(prepared);
}

/* --- Cached (audiobook-mode) playback --------------------------------- */

// Turn a section href into a filesystem-friendly key. Doesn't need to be
// cryptographic, just stable and safe: our href is something like
// "OEBPS/chapter5.xhtml" and we want "OEBPS_chapter5_xhtml".
function sectionKeyFromHref(href: string): string {
  return href.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 100);
}

// The voice id used in cache paths — matches the .onnx file's stem.
function currentVoiceId(): string | null {
  if (!ttsSettings.piperVoicePath) return null;
  const parts = ttsSettings.piperVoicePath.split(/[\\/]/);
  const file = parts[parts.length - 1] || '';
  return file.replace(/\.onnx$/, '');
}

// Get the current section's href from epub.js's current location.
function currentSectionHref(): string | null {
  if (!currentRendition) return null;
  const loc = currentRendition.currentLocation() as any;
  const href = loc?.start?.href;
  return typeof href === 'string' ? href : null;
}

// Walk focusWords and group them into sentences, matching the same
// endsSentence rule we use for chunking. Each sentence gets its text
// (as spoken) plus its wordIdx range so we can highlight later.
function collectSectionSentences(): { texts: string[]; ranges: Array<{ startWordIdx: number; endWordIdx: number }> } {
  const texts: string[] = [];
  const ranges: Array<{ startWordIdx: number; endWordIdx: number }> = [];
  let curText: string[] = [];
  let curStart = -1;
  for (let i = 0; i < focusWords.length; i++) {
    const fw = focusWords[i];
    const text = (fw.node.textContent || '').slice(fw.start, fw.end).trim();
    if (!text) continue;
    if (curStart === -1) curStart = i;
    curText.push(text);
    if (curText.length >= TTS_MIN_CHUNK_WORDS && endsSentence(text)) {
      texts.push(curText.join(' '));
      ranges.push({ startWordIdx: curStart, endWordIdx: i });
      curText = [];
      curStart = -1;
    }
  }
  // Flush trailing partial sentence (paragraph with no terminator, etc.).
  if (curText.length > 0 && curStart >= 0) {
    texts.push(curText.join(' '));
    ranges.push({ startWordIdx: curStart, endWordIdx: focusWords.length - 1 });
  }
  return { texts, ranges };
}

function stopCachedPlayback(): void {
  cachedRafId && cancelAnimationFrame(cachedRafId);
  cachedRafId = 0;
  if (cachedPlayback) {
    cachedPlayback.audio.onended = null;
    cachedPlayback.audio.onerror = null;
    cachedPlayback.audio.pause();
    cachedPlayback.audio.src = '';
    URL.revokeObjectURL(cachedPlayback.url);
    cachedPlayback = null;
  }
}

// rAF-driven sentence-highlight loop for cached playback. Coarser than
// pipelined mode (whole sentence highlights at a time) but keeps a visual
// anchor for readers following along.
function startCachedPaintLoop(): void {
  if (cachedRafId) cancelAnimationFrame(cachedRafId);
  const tick = () => {
    cachedRafId = 0;
    if (!ttsOn || !cachedPlayback) return;
    const { audio, chapter, sentenceRanges } = cachedPlayback;
    if (audio.paused || audio.ended) return;
    const t = audio.currentTime;
    // Binary search for the last sentence with start <= t.
    const starts = chapter.sentence_starts;
    let lo = 0, hi = starts.length - 1, idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= t) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (idx !== cachedPlayback.lastPaintedSentence) {
      cachedPlayback.lastPaintedSentence = idx;
      const range = sentenceRanges[idx];
      if (range) {
        // We know the sentence range explicitly for cached playback, so
        // paint it directly instead of letting paintRange re-derive it.
        paintSentenceRange(range.startWordIdx, range.endWordIdx);
        const fw = focusWords[range.startWordIdx];
        if (fw) {
          const cls = classifyWord(fw);
          if (cls.pos === 'visible' && cls.range && cls.rect) {
            paintRange(cls.range, cls.rect, range.startWordIdx);
          } else if (cls.pos === 'after') {
            // Word is on a later page — auto-turn so the reader keeps up.
            currentRendition?.next().catch(() => {});
          }
          focusIndex = range.startWordIdx;
        }
      }
    }
    cachedRafId = requestAnimationFrame(tick);
  };
  cachedRafId = requestAnimationFrame(tick);
}

// Called when the user hits Play and the current chapter is already cached.
// Returns true if cached playback started, false if we should fall through
// to pipelined synthesis.
async function tryStartCachedPlayback(): Promise<boolean> {
  if (ttsSettings.engine !== 'piper') return false;
  if (!currentBookRecord) return false;
  const voice = currentVoiceId();
  const href = currentSectionHref();
  if (!voice || !href) return false;
  const key = sectionKeyFromHref(href);
  currentSectionKey = key;

  let cache: CachedChapter | null;
  try {
    cache = await invoke<CachedChapter | null>('piper_cache_lookup', {
      bookId: currentBookRecord.id,
      sectionKey: key,
      voiceId: voice,
    });
  } catch (err) {
    console.warn('cache_lookup failed:', err);
    return false;
  }
  if (!cache) return false;

  // Read the cached WAV via the fs plugin. rel_path is already
  // piper/cache/... relative to AppData once we prepend the "piper/cache/".
  let wavBytes: Uint8Array;
  try {
    wavBytes = await readFile(`piper/cache/${cache.rel_path}`, { baseDir: BaseDirectory.AppData });
  } catch (err) {
    console.warn('read cached wav failed:', err);
    return false;
  }

  // Ensure focusWords is populated so we can highlight sentences.
  const iframe = getVisibleIframe();
  if (iframe && iframe.contentDocument !== focusIframeDoc) collectFocusWords();
  const { ranges } = collectSectionSentences();

  // Sanity check: the cached WAV was made from N sentences; if we now see
  // a different count (page moved / different iframe), the ranges won't
  // line up. Fall back to pipelined.
  if (ranges.length !== cache.sentence_starts.length) {
    console.warn(`cache sentence-count mismatch: cached=${cache.sentence_starts.length} live=${ranges.length}`);
    // Play anyway but without sentence highlighting.
    for (let i = ranges.length; i < cache.sentence_starts.length; i++) {
      ranges.push({ startWordIdx: 0, endWordIdx: 0 });
    }
  }

  const blob = new Blob([wavBytes.buffer as ArrayBuffer], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.playbackRate = currentPiperPlaybackRate();
  audio.preload = 'auto';

  cachedPlayback = {
    chapter: cache,
    audio,
    url,
    sectionKey: key,
    sentenceRanges: ranges,
    lastPaintedSentence: -1,
  };

  // Seek to whatever sentence is nearest the current visible word — so
  // starting cached playback from mid-page picks up where the reader is
  // looking, not from the top of the chapter.
  const startWordIdx = focusIndex;
  let seekTime = 0;
  for (let i = 0; i < ranges.length; i++) {
    if (ranges[i].startWordIdx <= startWordIdx) seekTime = cache.sentence_starts[i];
    else break;
  }
  audio.currentTime = seekTime;

  audio.onplaying = () => startCachedPaintLoop();
  audio.onended = () => {
    if (!ttsOn) return;
    stopCachedPlayback();
    // Advance to next section; if IT'S cached we'll pick it up in the
    // next speakNextChunk. Otherwise pipelined takes over.
    currentRendition?.next().then(() => {
      if (ttsOn) speakNextChunk();
    }).catch(() => stopTts());
  };
  audio.onerror = () => { if (ttsOn) stopTts(); };

  try {
    await audio.play();
  } catch (err) {
    console.warn('cached play failed:', err);
    stopCachedPlayback();
    return false;
  }
  toast('Playing cached audio');
  return true;
}

/* --- Cache-building UI trigger --------------------------------------- */

let cachingInFlight = false;

function updateCacheButtonState(cached: boolean): void {
  el.ttsCacheBtn.classList.toggle('cached', cached);
  el.ttsCacheBtn.classList.toggle('caching', cachingInFlight);
  el.ttsCacheBtn.title = cachingInFlight
    ? 'Caching chapter…'
    : cached
      ? 'Chapter cached — playback is instant'
      : 'Cache this chapter for instant audiobook-style playback';
}

async function refreshCacheButtonForCurrentSection(): Promise<void> {
  if (ttsSettings.engine !== 'piper' || !isPiperReady() || !currentBookRecord) {
    el.ttsCacheBtn.hidden = true;
    return;
  }
  el.ttsCacheBtn.hidden = false;
  const voice = currentVoiceId();
  const href = currentSectionHref();
  if (!voice || !href) {
    updateCacheButtonState(false);
    return;
  }
  const key = sectionKeyFromHref(href);
  try {
    const cache = await invoke<CachedChapter | null>('piper_cache_lookup', {
      bookId: currentBookRecord!.id,
      sectionKey: key,
      voiceId: voice,
    });
    updateCacheButtonState(!!cache);
  } catch {
    updateCacheButtonState(false);
  }
}

async function cacheCurrentChapter(): Promise<void> {
  if (cachingInFlight) return;
  if (!currentBookRecord || !currentRendition) { toast('Open a book first'); return; }
  if (ttsSettings.engine !== 'piper' || !isPiperReady()) {
    toast('Piper engine required to cache'); return;
  }
  const voice = currentVoiceId();
  const href = currentSectionHref();
  if (!voice || !href) { toast('No section to cache'); return; }
  const key = sectionKeyFromHref(href);

  // Ensure focusWords is populated for the current section, then extract
  // its sentences.
  collectFocusWords();
  const { texts } = collectSectionSentences();
  if (texts.length === 0) {
    toast('Nothing to cache in this section');
    return;
  }

  cachingInFlight = true;
  updateCacheButtonState(false);
  toast(`Caching ${texts.length} sentences… ~${Math.max(10, Math.round(texts.length * 0.6))}s`);

  try {
    await invoke('piper_batch_synthesize', {
      bookId: currentBookRecord.id,
      sectionKey: key,
      voicePath: ttsSettings.piperVoicePath,
      sentences: texts,
      lengthScale: currentPiperLengthScale(),
    });
    toast('Chapter cached — hit play for instant audio');
  } catch (err: any) {
    console.error('cache failed:', err);
    toast(`Cache failed: ${err?.message || err}`);
  } finally {
    cachingInFlight = false;
    await refreshCacheButtonForCurrentSection();
  }
}

function wire() {
  el.importBtn.addEventListener('click', importBook);
  el.importBtnEmpty.addEventListener('click', importBook);
  el.libraryThemeBtn.addEventListener('click', cycleTheme);
  el.libraryVocabReviewBtn.addEventListener('click', () => openVocabReview('all'));

  el.backBtn.addEventListener('click', () => {
    closeDrawers();
    if (currentBook) { currentBook.destroy(); currentBook = null; currentRendition = null; }
    currentBookRecord = null;
    document.removeEventListener('mousemove', onReaderMouseMove);
    if (isFocusModeOn()) stopFocusMode();
    if (isTtsOn()) stopTts();
    goToScreen('library');
  });

  el.tocBtn.addEventListener('click', () => openDrawer('toc', 'toc'));
  el.closeTocBtn.addEventListener('click', closeDrawers);
  el.typographyBtn.addEventListener('click', () => openDrawer('typography'));
  el.closeTypographyBtn.addEventListener('click', closeDrawers);
  el.themeBtn.addEventListener('click', cycleTheme);
  el.bookmarkBtn.addEventListener('click', toggleBookmark);

  // Focus reading mode
  el.focusModeBtn.addEventListener('click', () => {
    if (isFocusModeOn()) stopFocusMode();
    else {
      if (isTtsOn()) stopTts();
      startFocusMode();
    }
  });
  el.focusToggleBtn.addEventListener('click', toggleFocusPause);
  el.focusPrevBtn.addEventListener('click', () => stepFocus(-1));
  el.focusNextBtn.addEventListener('click', () => stepFocus(+1));
  el.focusCloseBtn.addEventListener('click', stopFocusMode);
  el.focusSpeedSlider.value = String(settings.focusModeWpm);
  el.focusWpmLabel.textContent = `${settings.focusModeWpm} wpm`;
  el.focusSpeedSlider.addEventListener('input', () => {
    setFocusWpm(parseInt(el.focusSpeedSlider.value, 10));
  });

  // Read-aloud (TTS). System engine is a hard requirement for the button to
  // exist at all; Piper is optional and gets checked lazily when the user
  // switches engines.
  if (isTtsSupported()) {
    loadVoices();
    speechSynthesis.addEventListener('voiceschanged', loadVoices);
  } else {
    // If the WebView somehow lacks Web Speech, force Piper as the engine —
    // the button still works if Piper is set up.
    if (ttsSettings.engine === 'system') ttsSettings.engine = 'piper';
  }

  el.ttsBtn.addEventListener('click', () => {
    if (isTtsOn()) stopTts(); else startTts();
  });
  el.ttsToggleBtn.addEventListener('click', toggleTtsPause);
  el.ttsPrevBtn.addEventListener('click', () => stepTts(-1));
  el.ttsNextBtn.addEventListener('click', () => stepTts(+1));
  el.ttsCloseBtn.addEventListener('click', stopTts);
  el.ttsRateSlider.value = String(ttsSettings.rate);
  el.ttsRateLabel.textContent = `${ttsSettings.rate.toFixed(1)}×`;
  el.ttsRateSlider.addEventListener('input', () => {
    setTtsRate(parseFloat(el.ttsRateSlider.value));
  });
  el.ttsVoiceSelect.addEventListener('change', () => {
    setTtsVoice(el.ttsVoiceSelect.value);
  });
  el.ttsEngineSelect.addEventListener('change', () => {
    setTtsEngine(el.ttsEngineSelect.value as TtsEngine);
  });
  el.ttsSetupBtn.addEventListener('click', openPiperSetup);
  el.ttsNaturalRate.checked = ttsSettings.piperNaturalRate;
  el.ttsNaturalRate.addEventListener('change', () => {
    setTtsPiperNaturalRate(el.ttsNaturalRate.checked);
  });
  el.ttsCacheBtn.addEventListener('click', cacheCurrentChapter);

  // Piper setup modal
  el.closePiperSetupBtn.addEventListener('click', closePiperSetup);
  el.piperSetupModal.addEventListener('click', (e) => {
    if (e.target === el.piperSetupModal) closePiperSetup();
  });
  el.piperOpenFolderBtn.addEventListener('click', async () => {
    if (!piperStatus) return;
    const folder = piperStatus.voices_dir.replace(/[\\/]voices$/i, '');
    try {
      await openPath(folder);
    } catch (err) {
      console.warn('openPath failed:', err);
      // Best-effort clipboard fallback so the user isn't stuck.
      try {
        await navigator.clipboard.writeText(folder);
        toast('Path copied to clipboard');
      } catch { toast(`Path: ${folder}`); }
    }
  });
  el.piperRefreshBtn.addEventListener('click', async () => {
    el.piperBinaryStatus.textContent = 'Checking…';
    el.piperVoicesStatus.textContent = 'Checking…';
    await refreshPiperStatus();
    renderPiperSetupModal();
    updateEngineUi();
  });
  el.piperInstallBinaryBtn.addEventListener('click', installPiperBinary);
  el.piperCancelBinaryBtn.addEventListener('click', cancelPiperBinaryInstall);
  el.piperErrorDismiss.addEventListener('click', hidePiperError);

  // Initial engine UI + eager Piper status probe when the user has Piper
  // set as their preferred engine (so the voice dropdown is populated
  // by the time they open the panel).
  updateEngineUi();
  if (ttsSettings.engine === 'piper') refreshPiperStatus().then(updateEngineUi);

  document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach(b => {
    b.addEventListener('click', () => switchTab(b.dataset.tab as DrawerTab));
  });

  // Vocabulary Journal
  el.vocabReviewBtn.addEventListener('click', () => openVocabReview('current'));
  el.closeVocabReviewBtn.addEventListener('click', closeVocabReview);
  el.vocabReviewModal.addEventListener('click', (e) => {
    if (e.target === el.vocabReviewModal) closeVocabReview();
  });
  el.vocabRevealBtn.addEventListener('click', revealReviewCard);
  el.vocabRateActions.querySelectorAll<HTMLButtonElement>('.vocab-rate-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const rating = parseInt(btn.dataset.rating || '3', 10) as 1 | 3 | 5;
      rateReviewCard(rating);
    });
  });

  // Typography controls
  document.querySelectorAll<HTMLElement>('[data-control]').forEach(group => {
    const control = group.dataset.control;
    group.querySelectorAll<HTMLButtonElement>('button').forEach(btn => {
      btn.addEventListener('click', () => {
        const v = btn.dataset.value;
        if (control === 'font' && v)    settings.font = v as FontKind;
        if (control === 'line' && v)    settings.line = v as LineKind;
        if (control === 'margin' && v)  settings.margin = v as MarginKind;
        if (control === 'focusTracker' && v) settings.focusTracker = v as FocusTracker;
        if (control === 'size') {
          const action = btn.dataset.action;
          if (action === 'inc') settings.sizePct = Math.min(MAX_FONT_PCT, settings.sizePct + FONT_STEP);
          if (action === 'dec') settings.sizePct = Math.max(MIN_FONT_PCT, settings.sizePct - FONT_STEP);
        }
        persistSettings();
        applyGlobalTheme();
        applyReaderSettings();
        refreshTypographyUI();
      });
    });
  });

  el.prevBtn.addEventListener('click', () => navGo('prev'));
  el.nextBtn.addEventListener('click', () => navGo('next'));

  // Progress bar seek
  el.progressTrack.addEventListener('click', seekFromClick);
  el.progressTrack.addEventListener('mousemove', (e) => {
    const rect = el.progressTrack.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    el.progressThumb.style.left = `${pct * 100}%`;
  });
  el.progressTrack.addEventListener('mouseleave', () => {
    if (currentRendition && currentBook) {
      const loc = currentRendition.currentLocation() as any;
      if (loc?.start) {
        const pct = currentBook.locations.percentageFromCfi(loc.start.cfi);
        el.progressThumb.style.left = `${pct * 100}%`;
      }
    }
  });

  // Selection popover buttons
  el.selectionPopover.querySelectorAll<HTMLButtonElement>('.hl-swatch').forEach(sw => {
    sw.addEventListener('click', () => addHighlight(sw.dataset.color as HighlightColor));
  });
  el.popoverRemove.addEventListener('click', removePendingHighlight);

  // Explicit close buttons on info popovers
  el.dictClose.addEventListener('click', (e) => {
    e.stopPropagation();
    hideDictPopover();
  });
  el.dictAiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    runAiExplain();
  });
  el.footnoteClose.addEventListener('click', (e) => {
    e.stopPropagation();
    hideFootnotePopover();
  });

  // Any pointerdown outside a popover closes it. pointerdown fires before mouse/click
  // and unifies mouse/touch/pen, so this catches every "click outside" intent.
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as Node;
    if (!el.selectionPopover.hidden && !el.selectionPopover.contains(t)) hideSelectionPopover();
    if (!el.dictPopover.hidden && !el.dictPopover.contains(t)) hideDictPopover();
    if (!el.footnotePopover.hidden && !el.footnotePopover.contains(t)) hideFootnotePopover();
  });

  // Global Escape — use keydown at capture so it works from any focus context,
  // including when focus is inside a popover child.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!el.selectionPopover.hidden || !el.dictPopover.hidden || !el.footnotePopover.hidden) {
      e.preventDefault();
      e.stopPropagation();
      hideAllPopovers();
    }
  }, true);

  window.addEventListener('resize', requestReflow);
  window.addEventListener('orientationchange', requestReflow);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // Mark now so the follow-up visible/resize event knows to redisplay
      // even when the restored dimensions match the pre-minimize dimensions.
      wasMinimized = true;
    } else {
      requestReflow();
    }
  });
  window.addEventListener('focus', requestReflow);

  // The floating focus/TTS panel changes .viewer's effective bottom padding
  // via CSS (--reader-bottom-pad). That shrinks the client area epub.js
  // renders into, but epub.js caches its layout dimensions — so we need to
  // trigger a resize whenever .viewer's box changes for any reason. A
  // ResizeObserver catches CSS-driven size changes (panel show/hide, theme
  // font-size, margin toggle) that window 'resize' never sees.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => requestReflow()).observe(el.viewer);
  }

  // Keyboard nav
  document.addEventListener('keyup', (e) => {
    if (el.html.dataset.screen !== 'reader') return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    // Skip when a modifier is held so we don't collide with browser/OS shortcuts.
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // Focus reading mode: F toggles the mode entirely. When it's on, Space
    // pauses/resumes and ←/→ step by one word. Otherwise those keys keep
    // their normal reader-nav meaning.
    if (e.key === 'f' || e.key === 'F') {
      if (isFocusModeOn()) stopFocusMode();
      else { if (isTtsOn()) stopTts(); startFocusMode(); }
      return;
    }
    if (isFocusModeOn()) {
      if (e.key === ' ') { e.preventDefault(); toggleFocusPause(); return; }
      if (e.key === 'ArrowLeft')  { stepFocus(-1); return; }
      if (e.key === 'ArrowRight') { stepFocus(+1); return; }
    }

    // Read-aloud: R toggles. When on, Space pauses/resumes and ←/→ step.
    if (e.key === 'r' || e.key === 'R') {
      if (isTtsOn()) stopTts();
      else { if (isFocusModeOn()) stopFocusMode(); startTts(); }
      return;
    }
    if (isTtsOn()) {
      if (e.key === ' ') { e.preventDefault(); toggleTtsPause(); return; }
      if (e.key === 'ArrowLeft')  { stepTts(-1); return; }
      if (e.key === 'ArrowRight') { stepTts(+1); return; }
    }

    if (e.key === 'ArrowLeft' || e.key === 'PageUp')  navGo('prev');
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') navGo('next');
    if (e.key === 'b' || e.key === 'B') toggleBookmark();
    if (e.key === 't' || e.key === 'T') cycleTheme();

    // Typography shortcuts
    if (e.key === '-' || e.key === '_')      bumpFontSize(-10);
    else if (e.key === '=' || e.key === '+') bumpFontSize(+10);
    else if (e.key === '[')                  bumpMargin(-1); // narrower
    else if (e.key === ']')                  bumpMargin(+1); // wider
    else if (e.key === '\\')                 cycleLineHeight();

    if (e.key === 'Escape') {
      let hidSomething = false;
      if (isFocusModeOn()) { stopFocusMode(); hidSomething = true; }
      if (isTtsOn()) { stopTts(); hidSomething = true; }
      if (!el.selectionPopover.hidden) { hideSelectionPopover(); hidSomething = true; }
      if (!el.dictPopover.hidden) { hideDictPopover(); hidSomething = true; }
      if (!el.footnotePopover.hidden) { hideFootnotePopover(); hidSomething = true; }
      if (!hidSomething) closeDrawers();
    }
  });

  // Settings Modal
  el.openSettingsBtn.addEventListener('click', () => {
    el.settingsModal.hidden = false;
    el.appearanceSelect.value = settings.appearance;
    
    document.querySelectorAll('.theme-card').forEach(card => {
      if ((card as HTMLElement).dataset.themeVal === settings.theme) {
        card.classList.add('active');
      } else {
        card.classList.remove('active');
      }
    });
  });

  el.closeSettingsBtn.addEventListener('click', () => {
    el.settingsModal.hidden = true;
  });

  el.settingsModal.addEventListener('click', (e) => {
    if (e.target === el.settingsModal) el.settingsModal.hidden = true;
  });

  el.appearanceSelect.addEventListener('change', (e) => {
    settings.appearance = (e.target as HTMLSelectElement).value as Appearance;
    persistSettings();
    applyGlobalTheme();
    applyReaderSettings();
  });

  document.querySelectorAll('.theme-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.theme-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      settings.theme = (card as HTMLElement).dataset.themeVal as Theme;
      persistSettings();
      applyGlobalTheme();
      applyReaderSettings();
    });
  });
}

/* ============================================================
   Boot
   ============================================================ */
function boot() {
  applyGlobalTheme();
  wire();
  goToScreen('library');
  // Probe for a local LLM in the background — never block startup on it.
  // If nothing's installed, isLlmReady() stays false and the AI button
  // simply never appears.
  refreshLlmStatus();
}

boot();
