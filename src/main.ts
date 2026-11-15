import { open } from '@tauri-apps/plugin-dialog';
import { readFile, writeFile, mkdir, remove, exists, BaseDirectory } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { openPath, openUrl } from '@tauri-apps/plugin-opener';
import { readText as readClipboardText } from '@tauri-apps/plugin-clipboard-manager';
import ePub, { Book, Rendition, Location, NavItem } from 'epubjs';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { marked } from 'marked';
import { Readability } from '@mozilla/readability';
import DOMPurify from 'dompurify';
import TurndownService from 'turndown';
import { enhanceCodeBlocks, prepareCodeForImport, addCodeFenceRule } from './codeblocks';
import { VOCA_VOICES, VocaVoice, isVocaReady, startVoca, vocaSynthesize, vocaSynthesizeSamples, wavFromFloat32, setVocaProgressListener, setVocaReadyListener } from './voca';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;


/* ============================================================
   Types
   ============================================================ */
type Theme = 'default' | 'parchment' | 'almond' | 'sage' | 'mist' | 'blush'
  | 'eink' | 'einkwarm'
  | 'flexoki' | 'ayu' | 'catppuccin' | 'everforest' | 'gruvbox' | 'nord' | 'rosepine' | 'solarized';
type Appearance = 'light' | 'dark';
type FontKind = 'serif' | 'sans' | 'mono' | 'literata' | 'lora' | 'bitter' | 'atkinson';
type LineKind = 'compact' | 'normal' | 'relaxed';
type MarginKind = 'narrow' | 'medium' | 'wide';
type MeasureKind = 'full' | 'ch60' | 'ch70' | 'ch80';
type LayoutKind = 'paginated' | 'spread' | 'scroll';
type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink';
type FocusTracker = 'off' | 'word' | 'sentence';
type ParagraphKind = 'original' | 'indent' | 'spaced';
// Each kind of reading keeps its own typography: a novel wants a serif with
// indented, justified paragraphs; a Markdown spec wants a sans with spaced
// paragraphs. Changing type while reading one format only touches that
// format's profile.
type ReadingProfile = 'book' | 'document' | 'article';
interface ProfileValues {
  font: FontKind;
  line: LineKind;
  measure: MeasureKind;
  paragraph: ParagraphKind;
  justify: boolean;
}
export type BookFormat = 'epub' | 'pdf' | 'txt' | 'md';

interface Settings {
  theme: Theme;
  appearance: Appearance;
  font: FontKind;
  sizePct: number;
  line: LineKind;
  margin: MarginKind;
  measure: MeasureKind;
  layout: LayoutKind;
  focusTracker: FocusTracker;
  lastHighlightColor: HighlightColor;
  focusModeWpm: number;
  readingRuler: boolean;
  warmth: number;       // 0–100, screen warmth (amber tint) — 0 = off
  brightness: number;   // 40–100, screen brightness — 100 = untouched
  uiLayout: 'standard' | 'minimal';  // standard = sidebar + toolbars, minimal = text-only + command bar
  paragraph: ParagraphKind;
  justify: boolean;
  profiles: Record<ReadingProfile, ProfileValues>;
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
  sourceUrl?: string;               // present for web articles saved via "Read mode"
  lastOpenedAt?: number;            // stamped every time the book is opened (drives "recently opened")
  finishedAt?: number;              // set when the user marks the book / article as read
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

// Starting points for each kind of reading. The typography panel's "Style"
// buttons apply one of these to the profile of whatever is open.
const READING_PRESETS: Record<ReadingProfile, ProfileValues> = {
  book:     { font: 'literata', line: 'normal', measure: 'ch70', paragraph: 'indent', justify: true },
  document: { font: 'sans',     line: 'normal', measure: 'ch70', paragraph: 'spaced', justify: false },
  article:  { font: 'serif',    line: 'normal', measure: 'ch70', paragraph: 'spaced', justify: false },
};

const DEFAULT_SETTINGS: Settings = {
  theme: 'default',
  appearance: 'light',
  font: 'literata',
  sizePct: 100,
  line: 'normal',
  margin: 'medium',
  measure: 'ch70',
  layout: 'paginated',
  focusTracker: 'off',
  lastHighlightColor: 'yellow',
  focusModeWpm: 300,
  readingRuler: false,
  warmth: 0,
  brightness: 100,
  uiLayout: 'standard',
  paragraph: 'indent',
  justify: true,
  profiles: {
    book: { ...READING_PRESETS.book },
    document: { ...READING_PRESETS.document },
    article: { ...READING_PRESETS.article },
  },
};

const load = <T>(k: string, fallback: T): T => {
  try { const raw = localStorage.getItem(k); return raw ? JSON.parse(raw) as T : fallback; }
  catch { return fallback; }
};
const save = (k: string, v: unknown) => localStorage.setItem(k, JSON.stringify(v));

const storedSettings = load<Partial<Settings>>(KEY_SETTINGS, {});
let settings: Settings = { ...DEFAULT_SETTINGS, ...storedSettings };
if (!storedSettings.profiles) {
  // Upgrading from a version without profiles: keep the reader's own font,
  // spacing and line width, and only bring in the new paragraph handling.
  const keep = (p: ProfileValues): ProfileValues => storedSettings.font
    ? { ...p, font: storedSettings.font, line: storedSettings.line ?? p.line, measure: storedSettings.measure ?? p.measure }
    : { ...p };
  settings.profiles = {
    book: keep(READING_PRESETS.book),
    document: keep(READING_PRESETS.document),
    article: keep(READING_PRESETS.article),
  };
} else {
  settings.profiles = {
    book: { ...READING_PRESETS.book, ...storedSettings.profiles.book },
    document: { ...READING_PRESETS.document, ...storedSettings.profiles.document },
    article: { ...READING_PRESETS.article, ...storedSettings.profiles.article },
  };
}

// Migrate legacy theme settings
if (['light', 'sepia', 'dark'].includes(settings.theme as any)) {
  settings.appearance = (settings.theme as string) === 'dark' ? 'dark' : 'light';
  settings.theme = 'default';
  save(KEY_SETTINGS, settings);
}

let library: BookRecord[] = load<BookRecord[]>(KEY_LIBRARY, []);

// Which profile the open reader is using; null on the library screen.
let activeProfile: ReadingProfile | null = null;
const persistSettings = () => {
  if (activeProfile) captureProfile(activeProfile);
  save(KEY_SETTINGS, settings);
};

function profileForRecord(record: BookRecord): ReadingProfile {
  if (record.sourceUrl) return 'article';
  const fmt = record.format || getBookFormat(record);
  return fmt === 'md' || fmt === 'txt' ? 'document' : 'book';
}

function captureProfile(p: ReadingProfile) {
  settings.profiles[p] = {
    font: settings.font, line: settings.line, measure: settings.measure,
    paragraph: settings.paragraph, justify: settings.justify,
  };
}

function loadProfile(p: ReadingProfile) {
  const v = settings.profiles[p];
  settings.font = v.font;
  settings.line = v.line;
  settings.measure = v.measure;
  settings.paragraph = v.paragraph;
  settings.justify = v.justify;
}

function matchingPreset(): ReadingProfile | null {
  for (const key of Object.keys(READING_PRESETS) as ReadingProfile[]) {
    const p = READING_PRESETS[key];
    if (p.font === settings.font && p.line === settings.line && p.measure === settings.measure
      && p.paragraph === settings.paragraph && p.justify === settings.justify) return key;
  }
  return null;
}
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
// Separate from the native-viewer blob above — this is our own pdf.js parse,
// kept around purely for data the embedded Chromium viewer doesn't expose:
// outline, page count, and per-page text (chat, bookmark previews). The
// native viewer's actual scroll/page state lives inside a nested
// chrome-extension:// context we can't reach from JS, so page position here
// is tracked only through actions we control ourselves (TOC clicks, the
// edge-nav prev/next buttons, and resuming at the last such position) —
// never by observing the viewer's scroll.
let currentPdfDoc: pdfjsLib.PDFDocumentProxy | null = null;
// Kept alongside currentPdfDoc purely so cleanup can call .destroy() on it —
// that method isn't in PDFDocumentProxy's own type declarations, only the
// loading task's.
let currentPdfLoadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;
let currentPdfIframe: HTMLIFrameElement | null = null;
let currentPdfPage = 1;
// The native toolbar (and its zoom controls) is suppressed via the
// `toolbar=0` open-param — see navigateToPdfPage — so this is now the only
// source of truth for PDF zoom, applied through the same `#zoom=` param.
let currentPdfZoom = 100;
let pdfTotalPages = 0;
let pdfHasOutline = false;
let pdfPageTextCache: Map<number, string> = new Map();
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

// `webArticle` swaps in a distinct teal palette + "WEB" label so saved
// articles read differently from a plain imported .md file at a glance.
function generateTextCoverDataUrl(title: string, format: BookFormat, webArticle = false): string {
  const canvas = document.createElement('canvas');
  canvas.width = 300;
  canvas.height = 440;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  const grad = ctx.createLinearGradient(0, 0, 300, 440);
  if (webArticle) {
    grad.addColorStop(0, '#1b2e30');
    grad.addColorStop(1, '#132224');
  } else if (format === 'md') {
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

  ctx.fillStyle = webArticle ? '#4dd0c4' : (format === 'md' ? '#61afef' : '#98c379');
  ctx.font = 'bold 14px sans-serif';
  ctx.fillText(webArticle ? 'WEB' : format.toUpperCase(), 30, 50);

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
  librarySettingsBtn: $<HTMLButtonElement>('library-settings-btn'),
  libraryVocabReviewBtn: $<HTMLButtonElement>('library-vocab-review-btn'),
  libraryVocabCount: $<HTMLSpanElement>('library-vocab-count'),
  librarySearch: $<HTMLInputElement>('library-search'),
  navLibraryCount: $<HTMLSpanElement>('nav-library-count'),
  sidebarStreakTitle: $<HTMLSpanElement>('sidebar-streak-title'),
  sidebarStreakToday: $<HTMLSpanElement>('sidebar-streak-today'),
  sidebarStreakWeek: $<HTMLDivElement>('sidebar-streak-week'),
  continueReading: $<HTMLElement>('continue-reading'),
  continueCover: $<HTMLDivElement>('continue-cover'),
  continueFormat: $<HTMLSpanElement>('continue-format'),
  continueTitle: $<HTMLSpanElement>('continue-title'),
  continueAuthor: $<HTMLSpanElement>('continue-author'),
  continueHeading: $<HTMLHeadingElement>('continue-heading'),
  continueMeta: $<HTMLParagraphElement>('continue-meta'),
  continueQuote: $<HTMLParagraphElement>('continue-quote'),
  continueProgressFill: $<HTMLDivElement>('continue-progress-fill'),
  continueProgressChapter: $<HTMLSpanElement>('continue-progress-chapter'),
  continueProgressMeta: $<HTMLSpanElement>('continue-progress-meta'),
  continueResumeBtn: $<HTMLButtonElement>('continue-resume-btn'),
  continueListenBtn: $<HTMLButtonElement>('continue-listen-btn'),
  continueUpNextList: $<HTMLDivElement>('continue-up-next-list'),
  filterCountAll: $<HTMLSpanElement>('filter-count-all'),
  filterCountEpub: $<HTMLSpanElement>('filter-count-epub'),
  filterCountPdf: $<HTMLSpanElement>('filter-count-pdf'),
  filterCountWeb: $<HTMLSpanElement>('filter-count-web'),
  filterCountRead: $<HTMLSpanElement>('filter-count-read'),
  markReadBtn: $<HTMLButtonElement>('mark-read-btn'),
  librarySortBtn: $<HTMLButtonElement>('library-sort-btn'),
  librarySortLabel: $<HTMLSpanElement>('library-sort-label'),
  readerChapterTitle: $<HTMLSpanElement>('reader-chapter-title'),
  settingsReadingStyleBtn: $<HTMLButtonElement>('settings-reading-style-btn'),
  settingsVoicesBtn: $<HTMLButtonElement>('settings-voices-btn'),
  minSettingsBtn: $<HTMLButtonElement>('min-settings-btn'),
  minVocabLink: $<HTMLAnchorElement>('min-vocab-link'),
  minAddBook: $<HTMLAnchorElement>('min-add-book'),
  minSaveArticle: $<HTMLAnchorElement>('min-save-article'),
  minMenuBtn: $<HTMLButtonElement>('min-menu-btn'),
  minProgress: $<HTMLDivElement>('min-progress'),
  minProgressFill: $<HTMLDivElement>('min-progress-fill'),
  cmdbar: $<HTMLDivElement>('cmdbar'),
  cmdbarTitle: $<HTMLSpanElement>('cmdbar-title'),
  cmdbarSub: $<HTMLSpanElement>('cmdbar-sub'),
  cmdbarInput: $<HTMLInputElement>('cmdbar-input'),
  cmdbarList: $<HTMLElement>('cmdbar-list'),
  cmdbarMore: $<HTMLAnchorElement>('cmdbar-more'),

  // Save Article (web page → reader mode)
  importUrlBtn: $<HTMLButtonElement>('import-url-btn'),
  urlImportModal: $<HTMLDivElement>('url-import-modal'),
  closeUrlImportBtn: $<HTMLButtonElement>('close-url-import-btn'),
  urlImportForm: $<HTMLFormElement>('url-import-form'),
  urlImportInput: $<HTMLInputElement>('url-import-input'),
  urlImportSubmit: $<HTMLButtonElement>('url-import-submit'),
  urlImportSpinner: document.getElementById('url-import-spinner') as unknown as SVGSVGElement,
  urlImportSubmitLabel: $<HTMLSpanElement>('url-import-submit-label'),
  urlImportStatus: $<HTMLDivElement>('url-import-status'),
  openOriginalBtn: $<HTMLButtonElement>('open-original-btn'),

  readerTopbar: $<HTMLElement>('reader-topbar'),
  readerBottombar: $<HTMLElement>('reader-bottombar'),
  bookTitle: $<HTMLSpanElement>('reader-book-title'),
  formatBadge: $<HTMLSpanElement>('reader-format-badge'),
  pageOutline: $<HTMLElement>('page-outline'),
  resumeNote: $<HTMLElement>('resume-note'),
  resumeNoteSub: $<HTMLElement>('resume-note-sub'),
  pageStrip: $<HTMLElement>('page-strip'),
  presetScope: $<HTMLParagraphElement>('preset-scope'),
  returnPill: $<HTMLButtonElement>('return-pill'),
  progressSegments: $<HTMLDivElement>('progress-segments'),
  backBtn: $<HTMLButtonElement>('back-to-library-btn'),
  tocBtn: $<HTMLButtonElement>('toc-btn'),
  pdfZoomOutBtn: $<HTMLButtonElement>('pdf-zoom-out-btn'),
  pdfZoomInBtn: $<HTMLButtonElement>('pdf-zoom-in-btn'),
  pdfZoomValue: $<HTMLSpanElement>('pdf-zoom-value'),
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

  readingRuler: $<HTMLDivElement>('reading-ruler'),
  warmthSlider: $<HTMLInputElement>('warmth-slider'),
  warmthValue: $<HTMLSpanElement>('warmth-value'),
  brightnessSlider: $<HTMLInputElement>('brightness-slider'),
  brightnessValue: $<HTMLSpanElement>('brightness-value'),

  selectionPopover: $<HTMLDivElement>('selection-popover'),
  popoverRemove: $<HTMLButtonElement>('popover-remove'),
  popoverAi: $<HTMLButtonElement>('popover-ai'),
  popoverLookup: $<HTMLButtonElement>('popover-lookup'),
  popoverSay: $<HTMLButtonElement>('popover-say'),
  aiExportBtn: $<HTMLButtonElement>('ai-export-btn'),

  toast: $<HTMLDivElement>('toast'),

  statsStreak: $<HTMLSpanElement>('stats-streak'),
  statsMins: $<HTMLSpanElement>('stats-mins'),

  dictPopover: $<HTMLDivElement>('dict-popover'),
  dictWord: $<HTMLHeadingElement>('dict-word'),
  dictPronounceBtn: $<HTMLButtonElement>('dict-pronounce-btn'),
  dictVocabBtn: $<HTMLButtonElement>('dict-vocab-btn'),
  dictVocabLabel: $<HTMLSpanElement>('dict-vocab-label'),
  dictPhonetic: $<HTMLSpanElement>('dict-phonetic'),
  dictMeanings: $<HTMLDivElement>('dict-meanings'),
  dictAiBtn: $<HTMLButtonElement>('dict-ai-btn'),
  dictAiOutput: $<HTMLDivElement>('dict-ai-output'),
  dictAiActions: $<HTMLDivElement>('dict-ai-actions'),
  dictAiRetry: $<HTMLButtonElement>('dict-ai-retry'),
  dictAiExamplesBtn: $<HTMLButtonElement>('dict-ai-examples-btn'),
  dictAiExamplesOutput: $<HTMLDivElement>('dict-ai-examples-output'),

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

  // Dictionary-from-clipboard (PDF only — see #pdf-dict-btn's CSS comment)
  pdfDictBtn: $<HTMLButtonElement>('pdf-dict-btn'),

  // Chat (local-LLM Q&A about the current page/chapter)
  chatBtn: $<HTMLButtonElement>('chat-btn'),
  chatModal: $<HTMLDivElement>('chat-modal'),
  chatScopeToggle: $<HTMLDivElement>('chat-scope-toggle'),
  chatModelSelect: $<HTMLSelectElement>('chat-model-select'),
  chatMessages: $<HTMLDivElement>('chat-messages'),
  chatInput: $<HTMLTextAreaElement>('chat-input'),
  chatSendBtn: $<HTMLButtonElement>('chat-send-btn'),
  chatResetBtn: $<HTMLButtonElement>('chat-reset-btn'),
  closeChatBtn: $<HTMLButtonElement>('close-chat-btn'),
  chatTruncatedNote: $<HTMLParagraphElement>('chat-truncated-note'),

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
  vocabSkipBtn: $<HTMLButtonElement>('vocab-skip-btn'),
  vocabDeleteBtn: $<HTMLButtonElement>('vocab-delete-btn'),
  vocabReviewEmpty: $<HTMLDivElement>('vocab-review-empty'),
  vocabCard: $<HTMLDivElement>('vocab-review-card'),
  vocabCardWord: $<HTMLHeadingElement>('vocab-card-word'),
  vocabPronounceBtn: $<HTMLButtonElement>('vocab-pronounce-btn'),
  vocabCardPhonetic: $<HTMLSpanElement>('vocab-card-phonetic'),
  vocabCardContext: $<HTMLQuoteElement>('vocab-card-context'),
  vocabCardChapter: $<HTMLSpanElement>('vocab-card-chapter'),
  vocabCardBack: $<HTMLDivElement>('vocab-card-back'),
  vocabCardDefinition: $<HTMLDivElement>('vocab-card-definition'),
  vocabAiBtn: $<HTMLButtonElement>('vocab-ai-btn'),
  vocabAiOutput: $<HTMLDivElement>('vocab-ai-output'),
  vocabAiActions: $<HTMLDivElement>('vocab-ai-actions'),
  vocabAiRetry: $<HTMLButtonElement>('vocab-ai-retry'),
  vocabAiExamplesBtn: $<HTMLButtonElement>('vocab-ai-examples-btn'),
  vocabAiExamplesOutput: $<HTMLDivElement>('vocab-ai-examples-output'),
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
  ttsHeardFill: $<HTMLElement>('tts-heard-fill'),
  ttsTimeLeft: $<HTMLSpanElement>('tts-time-left'),
  ttsLoading: $<HTMLSpanElement>('tts-loading'),
  ttsVoiceSelect: $<HTMLSelectElement>('tts-voice'),
  ttsEngineSelect: $<HTMLSelectElement>('tts-engine'),
  ttsSetupBtn: $<HTMLButtonElement>('tts-setup'),
  ttsNaturalRateLabel: $<HTMLLabelElement>('tts-natural-rate-label'),
  ttsNaturalRate: $<HTMLInputElement>('tts-natural-rate'),
  ttsCacheBtn: $<HTMLButtonElement>('tts-cache-btn'),
  ttsTuneBtn: $<HTMLButtonElement>('tts-tune-btn'),
  ttsTune: $<HTMLDivElement>('tts-tune'),
  ttsVolume: $<HTMLInputElement>('tts-volume'),
  ttsVolumeLabel: $<HTMLSpanElement>('tts-volume-label'),
  ttsPitchRow: $<HTMLLabelElement>('tts-pitch-row'),
  ttsPitch: $<HTMLInputElement>('tts-pitch'),
  ttsPitchLabel: $<HTMLSpanElement>('tts-pitch-label'),
  ttsPauses: $<HTMLInputElement>('tts-pauses'),
  ttsPausesLabel: $<HTMLSpanElement>('tts-pauses-label'),
  ttsExpr: $<HTMLInputElement>('tts-expr'),
  ttsExprLabel: $<HTMLSpanElement>('tts-expr-label'),
  ttsExprRow: $<HTMLElement>('tts-expr-row'),
  ttsSleep: $<HTMLSelectElement>('tts-sleep'),

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

  llmErrorBanner: $<HTMLDivElement>('llm-error-banner'),
  llmErrorBody: $<HTMLPreElement>('llm-error-body'),
  llmErrorDismiss: $<HTMLButtonElement>('llm-error-dismiss'),
  llmBinaryStatus: $<HTMLDivElement>('llm-binary-status'),
  llmModelsStatus: $<HTMLDivElement>('llm-models-status'),
  llmPath: $<HTMLParagraphElement>('llm-path'),
  llmOpenFolderBtn: $<HTMLButtonElement>('llm-open-folder-btn'),
  llmRefreshBtn: $<HTMLButtonElement>('llm-refresh-btn'),
  llmInstallBinaryBtn: $<HTMLButtonElement>('llm-install-binary-btn'),
  llmCancelBinaryBtn: $<HTMLButtonElement>('llm-cancel-binary-btn'),
  llmBinaryProgress: $<HTMLDivElement>('llm-binary-progress'),
  llmModelCatalog: $<HTMLUListElement>('llm-model-catalog'),
  llmCustomUrlInput: $<HTMLInputElement>('llm-custom-url'),
  llmCustomInstallBtn: $<HTMLButtonElement>('llm-custom-install-btn'),
  llmCustomProgress: $<HTMLDivElement>('llm-custom-progress'),
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

// Forces WebView2/Chromium to recomposite the page. Minimizing suspends the
// GPU compositor; on some Windows setups the very first frame after restore
// is a stale, pre-minimize paint — clicks land on the right DOM element
// (hit-testing isn't affected) but nothing *looks* like it registered, which
// reads as "the button doesn't work". A sub-pixel opacity nudge is enough to
// force a real repaint and is imperceptible; unlike a transform/filter nudge,
// opacity doesn't create a new containing block, so it can't shift any
// position:fixed descendants (the reading ruler, modals, screen overlays).
function forceRepaint(): void {
  const prev = el.html.style.opacity;
  el.html.style.opacity = '0.9999';
  void el.html.offsetHeight; // force synchronous layout so the nudge "takes"
  requestAnimationFrame(() => { el.html.style.opacity = prev; });
}

function requestReflow(): void {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = undefined;
    if (el.html.dataset.screen !== 'reader') return;
    const stage = el.viewer.getBoundingClientRect();

    if (stage.width < 20 || stage.height < 20) {
      // Actually minimized / hidden — remember so we redisplay on restore.
      wasMinimized = true;
      return;
    }

    const restoring = wasMinimized;
    wasMinimized = false;

    // PDF and text/md have nothing to re-paginate (the native PDF viewer and
    // the plain-scroll text container both reflow themselves via CSS), but
    // still need the restore-from-minimize handling below: close any popover
    // whose on-screen position may now be stale, and force a repaint in case
    // the compositor is showing a frame from before the minimize.
    if (!currentRendition) {
      if (restoring) { hideAllPopovers(); forceRepaint(); }
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
        // display() re-lays out columns against the new width but doesn't
        // re-fire the 'rendered' hook (that's a section-load event, not a
        // relayout event), so the vocab-underline overlay's cached rects go
        // stale — words shift lines but the markers don't follow. Recompute
        // once the new layout is actually in place, not before — the rAF
        // inside scheduleVocabHighlightRefresh can otherwise beat this
        // still-in-flight async display() and re-measure the old rects.
        currentRendition.display(currentLocationCfi)
          .then(() => scheduleVocabHighlightRefresh())
          .catch(() => {});
      } else {
        scheduleVocabHighlightRefresh();
      }
      hideAllPopovers();
      updateProgress();
      if (restoring) forceRepaint();
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
  serif:    "'Newsreader', 'Georgia', serif",
  sans:     "'Inter', -apple-system, sans-serif",
  mono:     "'JetBrains Mono', monospace",
  // Reading-optimized additions (loaded via the Google Fonts link in index.html)
  literata: "'Literata', 'Georgia', serif",
  lora:     "'Lora', 'Georgia', serif",
  bitter:   "'Bitter', 'Georgia', serif",
  atkinson: "'Atkinson Hyperlegible', 'Inter', sans-serif",
};

// Google Fonts stylesheet (kept in sync with the <link> in index.html). EPUB
// sections render inside their own iframe documents, and @font-face rules are
// document-scoped — so the web fonts loaded by the parent page aren't visible
// inside the iframe. Without this, every serif (Newsreader/Literata/Lora/
// Bitter) silently falls back to Georgia and they all look identical. We
// inject the same stylesheet into each section document so the real faces load.
const READER_FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;450;500;600' +
  '&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400' +
  '&family=JetBrains+Mono:wght@400;500' +
  '&family=Literata:ital,opsz,wght@0,7..72,400;0,7..72,500;0,7..72,600;1,7..72,400' +
  '&family=Lora:ital,wght@0,400;0,500;0,600;1,400' +
  '&family=Bitter:ital,wght@0,400;0,500;0,600;1,400' +
  '&family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400&display=swap';

function injectReaderFonts(doc: Document) {
  try {
    const head = doc.head || doc.querySelector('head');
    if (!head || doc.getElementById('reader-font-link')) return;
    const link = doc.createElement('link');
    link.id = 'reader-font-link';
    link.rel = 'stylesheet';
    link.href = READER_FONTS_HREF;
    head.appendChild(link);
  } catch { /* cross-origin or headless section — skip */ }
}
const MIN_FONT_PCT = 70;
const MAX_FONT_PCT = 300;
const FONT_STEP = 10;
const LINE_MAP: Record<LineKind, number> = { compact: 1.4, normal: 1.65, relaxed: 1.95 };
const MARGIN_MAP: Record<MarginKind, string> = { narrow: '2rem', medium: '5rem', wide: '8rem' };
// Line-width cap. 'full' keeps the roomy default; the others cap the readable
// column so lines stay near a comfortable ~60–80 characters. Widths are rough
// character targets at the 100% serif baseline (they hold a fixed pixel width,
// so raising the font size trades a few characters for larger type).
// Values are the outer column box (text + the current side margins), tuned so
// that at the default medium margin the readable text lands near the labelled
// character count. Text/MD mode subtracts the margins again in CSS so both
// formats settle on the same text-column width.
const MEASURE_MAP: Record<MeasureKind, string> = {
  full: '1400px', ch60: '40rem', ch70: '45rem', ch80: '50rem',
};

function applyGlobalTheme() {
  el.html.dataset.theme = settings.theme;
  el.html.dataset.appearance = settings.appearance;
  el.html.dataset.layout = settings.uiLayout;
  document.querySelectorAll<HTMLButtonElement>('[data-ui-layout]').forEach(b => {
    const on = b.dataset.uiLayout === settings.uiLayout;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  // Highlight overlays live in each iframe and cache their color from
  // --accent — invalidate + repaint so a theme flip is felt everywhere.
  refreshHighlightColors();
}

// Reading-comfort knobs that live outside the epub theme: the line-width cap
// (drives .viewer max-width, which re-paginates epub via its ResizeObserver),
// the reading ruler toggle, and the night warmth/brightness overlays. Applied
// app-wide so the warmth/dim carry over to the library too.
function applyComfortSettings() {
  el.html.style.setProperty('--reader-measure', MEASURE_MAP[settings.measure]);
  el.html.dataset.measure = settings.measure;
  el.html.dataset.ruler = settings.readingRuler ? 'on' : 'off';
  // Warmth 0–100 → amber tint opacity 0–0.5.
  el.html.style.setProperty('--screen-warmth', (settings.warmth / 100 * 0.5).toFixed(3));
  // Brightness 100 = untouched; lower dials in a black overlay up to ~0.42.
  el.html.style.setProperty('--screen-dim', ((100 - settings.brightness) / 100 * 0.7).toFixed(3));
  if (!settings.readingRuler) el.readingRuler.style.opacity = '0';
}

// Slide the reading-ruler band to the cursor's viewport Y. Callers pass a
// viewport-relative Y (from the main document, or translated out of an epub
// iframe). No-op unless the ruler is on and we're in the reader.
function moveRuler(clientY: number) {
  if (!settings.readingRuler || el.html.dataset.screen !== 'reader') {
    el.readingRuler.style.opacity = '0';
    return;
  }
  const h = el.readingRuler.offsetHeight;
  el.readingRuler.style.top = `${Math.round(clientY - h / 2)}px`;
  el.readingRuler.style.opacity = '1';
}

function applyReaderSettings() {
  applyComfortSettings();
  el.html.style.setProperty('--reader-line', String(LINE_MAP[settings.line]));
  el.html.style.setProperty('--reader-margin', MARGIN_MAP[settings.margin]);
  el.html.style.setProperty('--reader-size', `${(1.0625 * settings.sizePct / 100).toFixed(3)}rem`);
  el.html.dataset.paragraph = settings.paragraph;
  el.html.dataset.justify = settings.justify ? 'on' : 'off';
  if (activeProfile) el.html.dataset.profile = activeProfile;

  if (currentTextElement) {
    currentTextElement.style.fontFamily = FONT_MAP[settings.font];
  }
  // PDF's dark-mode approximation (filter:invert) is pure CSS keyed off
  // data-appearance — no JS override needed here.

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

  // Book typography. Paragraph handling and justification only override the
  // publisher's CSS when the reader asks for it ('original' leaves it alone).
  const paragraphRules: Record<string, Record<string, string>> = {};
  const headingFollowers = 'h1 + p, h2 + p, h3 + p, h4 + p, h5 + p, h6 + p, hr + p, blockquote + p, figure + p, div + p, p:first-child';
  if (settings.paragraph === 'indent') {
    paragraphRules['p'] = { 'margin-top': '0 !important', 'margin-bottom': '0 !important' };
    paragraphRules['p + p'] = { 'text-indent': '1.5em !important' };
    paragraphRules[headingFollowers] = { 'text-indent': '0 !important' };
  } else if (settings.paragraph === 'spaced') {
    paragraphRules['p'] = { 'margin-top': '0 !important', 'margin-bottom': '0.9em !important', 'text-indent': '0 !important' };
  }
  if (settings.justify) {
    paragraphRules['p, li'] = {
      'text-align': 'justify !important',
      'hyphens': 'auto !important',
      '-webkit-hyphens': 'auto !important',
    };
  }

  currentRendition.themes.register('reader', {
    'body': {
      'background': `${colors.bg} !important`,
      'color': `${colors.text} !important`,
      'font-family': `${fontStack} !important`,
      'line-height': `${lineHeight} !important`,
      'padding': '0 !important',
      'font-variant-numeric': 'oldstyle-nums proportional-nums',
      'font-kerning': 'normal',
      'text-rendering': 'optimizeLegibility',
    },
    'p, li, blockquote, td': {
      'font-family': `${fontStack} !important`,
      'line-height': `${lineHeight} !important`,
      'color': `${colors.text} !important`,
      'text-wrap': 'pretty',
      'orphans': '2',
      'widows': '2',
    },
    'h1, h2, h3, h4, h5, h6': {
      'font-family': `${fontStack} !important`,
      'color': `${colors.text} !important`,
      'font-weight': '500',
      'letter-spacing': '-0.01em',
      'line-height': '1.2 !important',
      'text-wrap': 'balance',
      'text-indent': '0 !important',
      'hyphens': 'manual',
    },
    // Chapter openers: a clear break before the text starts.
    'h1, h2': { 'margin-top': '1.6em', 'margin-bottom': '1.1em', 'font-weight': '400' },
    'h1': { 'font-size': '1.9em' },
    'h2': { 'font-size': '1.5em' },
    'h3': { 'font-size': '1.2em', 'margin-top': '1.4em', 'margin-bottom': '0.6em' },
    'a': { 'color': `${colors.accent} !important`, 'text-decoration': 'none' },
    // Note references: a small, easy-to-hit target that opens the note
    // beside the text instead of jumping away.
    'a[epub\\:type~="noteref"], a[role="doc-noteref"], sup a': {
      'font-family': "'Geist', 'Inter', system-ui, sans-serif !important",
      'font-weight': '600',
      'font-size': '0.7em',
      'padding': '0.1em 0.35em',
      'border-radius': '4px',
      'background': `${colors.accent}1f`,
      'line-height': '1',
    },
    'blockquote': {
      'margin': '1.4em 1.5em',
      'padding': '0',
      'border': 'none',
      'color': `${colors.text} !important`,
      'font-style': 'italic',
    },
    // Scene breaks: a short centred rule instead of a full-width line.
    'hr': {
      'border': 'none',
      'border-top': `1px solid ${colors.muted}`,
      'width': '3em',
      'margin': '1.8em auto',
      'opacity': '0.6',
    },
    // EPUB 3 footnotes are read in the popover beside their reference, so
    // the note bodies don't also interrupt the running text.
    'aside[epub\\:type~="footnote"], aside[epub\\:type~="rearnote"], aside[role="doc-footnote"]': { 'display': 'none' },
    'figure': { 'margin': '1.6em 0' },
    'figcaption, .caption': {
      'font-family': "'Geist', 'Inter', system-ui, sans-serif !important",
      'font-size': '0.8em',
      'line-height': '1.45 !important',
      'color': `${colors.muted} !important`,
      'text-align': 'left',
      'margin-top': '0.6em',
    },
    'img': { 'max-width': '100% !important', 'height': 'auto !important' },
    'code, pre': { 'font-family': "'JetBrains Mono', monospace !important", 'font-size': '0.88em', 'hyphens': 'manual' },
    'pre': { 'white-space': 'pre-wrap', 'text-align': 'left !important' },
    'table': { 'border-collapse': 'collapse', 'font-variant-numeric': 'lining-nums tabular-nums' },
    'td, th': { 'text-align': 'left !important', 'hyphens': 'manual !important', 'padding': '0.3em 0.6em 0.3em 0' },
    ...paragraphRules,
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
    if (control === 'measure') match = btn.dataset.value === settings.measure;
    if (control === 'layout') match = btn.dataset.value === settings.layout;
    if (control === 'focusTracker') match = btn.dataset.value === settings.focusTracker;
    if (control === 'ruler')  match = btn.dataset.value === (settings.readingRuler ? 'on' : 'off');
    if (control === 'paragraph') match = btn.dataset.value === settings.paragraph;
    if (control === 'justify') match = btn.dataset.value === (settings.justify ? 'on' : 'off');
    if (control === 'preset') match = btn.dataset.value === matchingPreset();
    if (control === 'quicktheme') match = quickThemeFor(btn.dataset.value) === true;
    btn.classList.toggle('active', match);
    btn.setAttribute('aria-pressed', match ? 'true' : 'false');
  });
  el.sizeValue.textContent = `${settings.sizePct}%`;
  if (el.presetScope) {
    el.presetScope.textContent = activeProfile ? PROFILE_SCOPE_TEXT[activeProfile] : '';
  }
  el.warmthSlider.value = String(settings.warmth);
  el.warmthValue.textContent = settings.warmth === 0 ? 'Off' : `${settings.warmth}%`;
  el.brightnessSlider.value = String(settings.brightness);
  el.brightnessValue.textContent = `${settings.brightness}%`;
}

const PROFILE_SCOPE_TEXT: Record<ReadingProfile, string> = {
  book: 'Changes here apply to all EPUB books.',
  document: 'Changes here apply to all Markdown and text files.',
  article: 'Changes here apply to all saved web articles.',
};

// The four quick themes in the typography panel map onto the full theme set.
const QUICK_THEMES: Record<string, { theme: Theme; appearance: Appearance }> = {
  paper: { theme: 'default', appearance: 'light' },
  sepia: { theme: 'parchment', appearance: 'light' },
  eink: { theme: 'eink', appearance: 'light' },
  night: { theme: 'default', appearance: 'dark' },
};
function quickThemeFor(key: string | undefined): boolean {
  const q = key ? QUICK_THEMES[key] : undefined;
  return !!q && q.theme === settings.theme && q.appearance === settings.appearance;
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
  el.libraryCount.textContent = `${count} title${count === 1 ? '' : 's'}`;
  if (el.navLibraryCount) el.navLibraryCount.textContent = String(count);

  refreshLibraryVocabButton();
  renderContinueReading();
  renderFormatCounts();

  const visible = getVisibleLibrary();

  if (count === 0 || visible.length === 0) {
    el.libraryEmpty.hidden = false;
    el.libraryGrid.hidden = true;
    const heading = el.libraryEmpty.querySelector('h2');
    const copy = el.libraryEmpty.querySelector('p');
    const addBtn = el.libraryEmpty.querySelector<HTMLButtonElement>('#import-btn-empty');
    if (count === 0) {
      if (heading) heading.textContent = 'Nothing here yet';
      if (copy) copy.textContent = 'Add a book or document to start reading. Supports EPUB, PDF, TXT, and MD formats.';
      if (addBtn) addBtn.hidden = false;
    } else {
      if (heading) heading.textContent = 'No matches';
      if (copy) copy.textContent = 'Try a different search, or clear the format filter to see everything.';
      if (addBtn) addBtn.hidden = true;
    }
    return;
  }

  el.libraryEmpty.hidden = true;
  el.libraryGrid.hidden = false;
  el.libraryGrid.innerHTML = '';

  for (const book of visible) {
    el.libraryGrid.appendChild(renderBookCard(book));
  }
}

type LibraryFilter = 'all' | 'epub' | 'pdf' | 'web' | 'read';
type LibrarySort = 'recent' | 'title' | 'author';

let libraryQuery = '';
let libraryFilter: LibraryFilter = 'all';
let librarySort: LibrarySort = 'recent';

function bookFormatOf(book: BookRecord): string {
  return book.format || getBookFormat(book);
}

// When a book was last touched: opened, read further, or added. Opening a
// book without turning a page still counts (lastOpenedAt), and records from
// before that field existed fall back to updatedAt.
function recencyOf(b: BookRecord): number {
  return Math.max(b.lastOpenedAt || 0, b.updatedAt || 0, b.addedAt || 0);
}

function getVisibleLibrary(): BookRecord[] {
  const q = libraryQuery.trim().toLowerCase();
  let list = library.filter(book => {
    if (libraryFilter === 'read') { if (!book.finishedAt) return false; }
    else if (libraryFilter === 'web' && !book.sourceUrl) return false;
    else if (libraryFilter !== 'all' && libraryFilter !== 'web' && (book.sourceUrl || bookFormatOf(book) !== libraryFilter)) return false;
    if (!q) return true;
    return `${book.title} ${book.author || ''}`.toLowerCase().includes(q);
  });

  list = [...list].sort((a, b) => {
    if (librarySort === 'title') return (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' });
    if (librarySort === 'author') return (a.author || '').localeCompare(b.author || '', undefined, { sensitivity: 'base' });
    return recencyOf(b) - recencyOf(a);
  });
  return list;
}

function renderFormatCounts(): void {
  if (!el.filterCountAll) return;
  const web = library.filter(b => !!b.sourceUrl).length;
  const epub = library.filter(b => !b.sourceUrl && bookFormatOf(b) === 'epub').length;
  const pdf = library.filter(b => !b.sourceUrl && bookFormatOf(b) === 'pdf').length;
  el.filterCountAll.textContent = String(library.length);
  el.filterCountEpub.textContent = String(epub);
  el.filterCountPdf.textContent = String(pdf);
  el.filterCountWeb.textContent = String(web);
  el.filterCountRead.textContent = String(library.filter(b => !!b.finishedAt).length);
}

const BOOK_COVER_PALETTES = [
  { bg: '#22314F', font: "'Newsreader', Georgia, serif" },
  { bg: '#24402F', font: "'Newsreader', Georgia, serif" },
  { bg: '#4A2740', font: "'Newsreader', Georgia, serif" },
  { bg: '#6B3325', font: "'Newsreader', Georgia, serif" },
  { bg: '#2F3A45', font: "'Newsreader', Georgia, serif" },
  { bg: '#6B5320', font: "'Newsreader', Georgia, serif" },
  { bg: '#1F4444', font: "'Newsreader', Georgia, serif" },
  { bg: '#2B2E5A', font: "'Newsreader', Georgia, serif" },
];

function coverPalette(key: string): { bg: string; font: string } {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return BOOK_COVER_PALETTES[h % BOOK_COVER_PALETTES.length];
}

function renderContinueReading(): void {
  if (!el.continueReading) return;
  const started = [...library]
    .filter(b => b.progress > 0 && !b.finishedAt)
    .sort((a, b) => recencyOf(b) - recencyOf(a));

  if (started.length === 0) {
    el.continueReading.hidden = true;
    return;
  }

  const book = started[0];
  const fmt = book.sourceUrl ? 'web' : bookFormatOf(book);
  const pct = Math.round((book.progress || 0) * 100);
  const palette = coverPalette(book.id);

  el.continueReading.hidden = false;
  el.continueCover.style.setProperty('--cover-bg', palette.bg);
  el.continueFormat.textContent = book.sourceUrl ? 'ARTICLE' : fmt.toUpperCase();
  el.continueTitle.textContent = book.title;
  el.continueAuthor.textContent = book.author || 'Unknown';
  el.continueHeading.textContent = book.title;
  el.continueMeta.textContent = `${book.author || 'Unknown'} · ${pct}% read${book.lastCfi ? '' : ''}`;
  el.continueQuote.hidden = true;
  el.continueProgressFill.style.width = `${Math.max(2, pct)}%`;
  el.continueProgressChapter.textContent = `${pct}% complete`;
  el.continueProgressMeta.textContent = `${pct}%`;

  el.continueResumeBtn.onclick = () => openFromLibrary(book);
  el.continueListenBtn.onclick = async () => {
    await openFromLibrary(book);
    window.setTimeout(() => {
      if (!el.ttsBtn.hidden) el.ttsBtn.click();
    }, 600);
  };

  el.continueUpNextList.innerHTML = '';
  const upNext = [...library]
    .filter(b => b.id !== book.id && !b.finishedAt)
    .sort((a, b) => recencyOf(b) - recencyOf(a))
    .slice(0, 4);

  if (upNext.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'up-next-title';
    empty.textContent = 'Nothing else in your library yet.';
    el.continueUpNextList.appendChild(empty);
    return;
  }

  upNext.forEach((item, index) => {
    const btn = document.createElement('button');
    btn.className = 'up-next-item';
    btn.type = 'button';
    const num = document.createElement('span');
    num.className = 'up-next-num';
    num.textContent = String(index + 1).padStart(2, '0');
    const title = document.createElement('span');
    title.className = 'up-next-title';
    title.textContent = item.title;
    btn.appendChild(num);
    btn.appendChild(title);
    btn.addEventListener('click', () => openFromLibrary(item));
    el.continueUpNextList.appendChild(btn);
  });
}

// Update the aggregated due count on the library sidebar review item. The nav
// item stays visible at all times; only the due badge hides when nothing is
// pending.
function refreshLibraryVocabButton(): void {
  const dueTotal = loadAllDueVocab().length;
  const capped = applyDailyCap(loadAllDueVocab()).length;
  el.libraryVocabReviewBtn.hidden = false;
  el.libraryVocabCount.hidden = capped === 0;
  el.libraryVocabCount.textContent = `${capped} due`;
  el.libraryVocabReviewBtn.title = capped === 0
    ? 'No vocabulary due right now'
    : dueTotal > capped
      ? `${capped} of ${dueTotal} due — the rest wait until tomorrow (${NEW_CARDS_PER_DAY_CAP}/day cap)`
      : `${capped} card${capped === 1 ? '' : 's'} due for review`;
  el.minVocabLink.hidden = capped === 0;
  el.minVocabLink.textContent = `${capped} word${capped === 1 ? '' : 's'} to review`;
}

function renderBookCard(book: BookRecord): HTMLElement {
  const card = document.createElement('div');
  card.className = 'book-card' + (book.progress > 0 ? ' has-progress' : '') + (book.finishedAt ? ' is-finished' : '');

  const fmt = bookFormatOf(book);
  const palette = coverPalette(book.id);

  const cover = document.createElement('div');
  cover.className = 'book-cover' + (book.coverDataUrl ? ' has-image' : '');
  cover.style.setProperty('--cover-bg', palette.bg);

  if (book.coverDataUrl) {
    const img = document.createElement('img');
    img.src = book.coverDataUrl;
    img.alt = book.title;
    cover.appendChild(img);
  } else {
    const format = document.createElement('span');
    format.className = 'book-cover-format';
    format.textContent = book.sourceUrl ? 'ARTICLE' : fmt.toUpperCase();
    cover.appendChild(format);

    const t = document.createElement('span');
    t.className = 'book-cover-title';
    t.style.fontFamily = palette.font;
    t.textContent = book.title;
    cover.appendChild(t);

    const by = document.createElement('span');
    by.className = 'book-cover-author';
    by.textContent = book.author || 'Unknown';
    cover.appendChild(by);
  }

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

  const readBtn = document.createElement('button');
  readBtn.className = 'book-read-toggle' + (book.finishedAt ? ' on' : '');
  readBtn.title = book.finishedAt ? 'Mark as unread' : 'Mark as read';
  readBtn.setAttribute('aria-label', readBtn.title);
  readBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  readBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleBookFinished(book);
  });
  cover.appendChild(readBtn);

  if (book.finishedAt) {
    const badge = document.createElement('div');
    badge.className = 'book-read-badge';
    badge.textContent = 'Read';
    cover.appendChild(badge);
  }

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
  const minMeta = document.createElement('span');
  minMeta.className = 'book-min-meta';
  minMeta.textContent = `${book.sourceUrl ? 'Article' : fmt.toUpperCase()} · ${book.finishedAt ? 'Read' : book.progress > 0 ? Math.round(book.progress * 100) + '%' : 'New'}`;
  card.appendChild(minMeta);

  const bar = document.createElement('div');
  bar.className = 'book-progress-bar';
  const fill = document.createElement('span');
  fill.style.width = `${Math.round((book.progress || 0) * 100)}%`;
  bar.appendChild(fill);

  card.appendChild(cover);
  card.appendChild(meta);
  card.appendChild(bar);

  card.addEventListener('click', () => openFromLibrary(book));

  return card;
}

// Mark a book / article as read (or back to unread). Works from the library
// card and from the reader toolbar.
function toggleBookFinished(book: BookRecord): void {
  if (book.finishedAt) {
    book.finishedAt = undefined;
    toast('Marked "' + book.title + '" as unread');
  } else {
    book.finishedAt = Date.now();
    toast('Marked "' + book.title + '" as read');
  }
  persistLibrary();
  renderLibrary();
  refreshReadButton();
}

function refreshReadButton(): void {
  const done = !!currentBookRecord?.finishedAt;
  el.markReadBtn.classList.toggle('active', done);
  el.markReadBtn.title = done ? 'Marked as read — click to mark unread' : 'Mark as read';
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

/* ============================================================
   Save Article — "read mode" for the open web. Fetches a page's HTML in
   Rust (sidesteps CORS + lets us set a real browser User-Agent), extracts
   the article with Mozilla's Readability (the same algorithm behind
   Firefox Reader View), sanitizes it with DOMPurify, converts it to
   Markdown with Turndown, and drops it into the library as a normal .md
   book. Reusing the .md book pipeline means typography, the dictionary,
   TTS, RSVP, and the reading-comfort features all work on saved articles
   for free — no separate reader engine needed.
   ============================================================ */
let urlImportInFlight = false;

function openUrlImportModal() {
  el.urlImportModal.hidden = false;
  el.urlImportInput.value = '';
  el.urlImportStatus.hidden = true;
  el.urlImportStatus.className = 'url-import-status';
  setUrlImportBusy(false);
  requestAnimationFrame(() => el.urlImportInput.focus());
}

function closeUrlImportModal() {
  if (urlImportInFlight) return; // don't yank the modal out from under a fetch in flight
  el.urlImportModal.hidden = true;
}

function setUrlImportBusy(busy: boolean) {
  urlImportInFlight = busy;
  el.urlImportSubmit.disabled = busy;
  el.urlImportInput.disabled = busy;
  (el.urlImportSpinner as any).hidden = !busy;
  el.urlImportSubmitLabel.textContent = busy ? 'Saving…' : 'Save';
}

function showUrlImportStatus(kind: 'busy' | 'error', message: string) {
  el.urlImportStatus.hidden = false;
  el.urlImportStatus.className = `url-import-status ${kind}`;
  el.urlImportStatus.textContent = message;
}

// Normalize pasted input into a fetchable absolute URL — pasting a bare
// domain/path without a scheme ("example.com/post") is common; assume https.
function normalizeArticleUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

async function saveArticleFromUrl(rawUrl: string) {
  if (urlImportInFlight) return;
  const url = normalizeArticleUrl(rawUrl);

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    showUrlImportStatus('error', "That doesn't look like a valid URL.");
    return;
  }

  // Already saved — open the existing copy instead of re-fetching.
  const existing = library.find(b => b.sourceUrl === url);
  if (existing) {
    el.urlImportModal.hidden = true;
    openFromLibrary(existing);
    return;
  }

  setUrlImportBusy(true);
  showUrlImportStatus('busy', 'Fetching and cleaning up the page…');

  try {
    const html = await invoke<string>('fetch_url_html', { url });

    const doc = new DOMParser().parseFromString(html, 'text/html');
    // Readability resolves relative image/link URLs against the document's
    // base; a DOMParser document defaults to about:blank, so point it at the
    // real page URL first (reuse an existing <base> if the page shipped one).
    let base = doc.querySelector('base');
    if (!base) {
      base = doc.createElement('base');
      doc.head.prepend(base);
    }
    base.setAttribute('href', url);

    // Capture code languages / flatten code text before Readability strips classes.
    prepareCodeForImport(doc);
    const article = new Readability(doc).parse();
    if (!article || !article.content || (article.textContent || '').trim().length < 200) {
      showUrlImportStatus(
        'error',
        "Couldn't find a readable article on that page — it may be paywalled, script-rendered, or not article content."
      );
      setUrlImportBusy(false);
      return;
    }

    // DOMPurify strips scripts/handlers by default; the explicit FORBID list
    // additionally drops interactive/embed tags that make no sense in a
    // saved article (forms, iframes, buttons).
    const cleanHtml = DOMPurify.sanitize(article.content, {
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
      FORBID_ATTR: ['style', 'onerror', 'onload'],
    });

    const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    addCodeFenceRule(turndown);
    const markdownBody = turndown.turndown(cleanHtml);

    const title = (article.title || hostname).trim();
    const byline = (article.byline || article.siteName || hostname).trim();
    const markdown = `# ${title}\n\n*${byline} — [${hostname}](${url})*\n\n${markdownBody}\n`;

    const id = safeUuid();
    const record: BookRecord = {
      id,
      title,
      author: byline,
      filePath: url,
      coverDataUrl: generateTextCoverDataUrl(title, 'md', true),
      lastCfi: null,
      progress: 0,
      addedAt: Date.now(),
      updatedAt: Date.now(),
      format: 'md',
      sourceUrl: url,
    };

    await ensureBooksDir();
    const rel = `${BOOKS_DIR}/${id}.md`;
    await writeFile(rel, new TextEncoder().encode(markdown), { baseDir: BaseDirectory.AppData });
    record.storedRelPath = rel;

    library.push(record);
    persistLibrary();

    setUrlImportBusy(false);
    el.urlImportModal.hidden = true;
    openFromLibrary(record);
    toast('Article saved to your library');
  } catch (err) {
    console.error('saveArticleFromUrl failed:', err);
    showUrlImportStatus('error', `Couldn't save that page: ${String(err)}`);
    setUrlImportBusy(false);
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
  if (currentPdfLoadingTask) {
    currentPdfLoadingTask.destroy().catch(() => {});
  }
  currentPdfDoc = null;
  currentPdfLoadingTask = null;
  currentPdfIframe = null;
  currentPdfPage = 1;
  currentPdfZoom = 100;
  el.pdfZoomValue.textContent = '100%';
  pdfTotalPages = 0;
  pdfHasOutline = false;
  pdfPageTextCache = new Map();
  currentTextElement = null;
  el.viewer.innerHTML = '';
  delete document.documentElement.dataset.format;
  // Chat is per-book — a conversation about one book's chapter makes no
  // sense carried into the next book opened.
  chatHistory = [];
  el.chatModal.hidden = true;
  // Clear the reading position so a ResizeObserver-driven requestReflow that
  // fires during the next book's load can't replay THIS book's CFI against the
  // new rendition. A cross-book CFI won't resolve, and the continuous manager
  // scrolls to an empty region — the "book opens then disappears" blank. The
  // new book's first `relocated` repopulates this; until then requestReflow's
  // `if (currentLocationCfi)` guard skips display() and only resizes.
  currentLocationCfi = null;
  hideReturnPill();
  spineStats = [];
  el.progressSegments.innerHTML = '';
  el.progressTrack.classList.remove('is-segmented');
}

interface TocTreeNode {
  href: string;
  label: string;
  subitems?: TocTreeNode[];
}

// Renders a nested outline (section/subsection/...) into #toc-list. One
// click handler covers every format's navigation: PDF pages, EPUB CFIs (via
// currentRendition, only ever set for EPUB), and plain in-document anchors
// for text/md's synthetic heading TOC. Nodes without `subitems` just render
// as flat leaves, so this also replaces the old flat-only renderer.
function renderTocTree(nodes: TocTreeNode[] | NavItem[]) {
  el.tocList.innerHTML = '';
  const build = (items: TocTreeNode[] | NavItem[], parent: HTMLElement) => {
    for (const item of items) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.className = 'toc-item';
      const label = document.createElement('span');
      label.className = 'toc-label';
      label.textContent = item.label.trim();
      a.appendChild(label);
      a.href = '#';
      a.dataset.href = item.href;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        if (item.href.startsWith('pdf-page-')) {
          navigateToPdfPage(parseInt(item.href.slice('pdf-page-'.length), 10));
        } else if (currentRendition) {
          currentRendition.display(item.href);
        } else {
          const targetEl = document.getElementById(item.href);
          if (targetEl) targetEl.scrollIntoView({ behavior: 'smooth' });
        }
        // Docked beside the text on wide windows, the panel can stay open.
        if (!isDockedLayout()) closeDrawers();
      });
      li.appendChild(a);
      if (item.subitems && item.subitems.length) {
        const ul = document.createElement('ul');
        build(item.subitems, ul);
        li.appendChild(ul);
      }
      parent.appendChild(li);
    }
  };
  build(nodes, el.tocList);
}

async function openPdfReader(record: BookRecord, buffer: ArrayBuffer) {
  // Create a Blob URL so the WebView2 (Chromium) built-in PDF viewer handles rendering.
  // This is identical to Chrome/Edge's PDF viewer — instant, native zoom/search/selection.
  const blob = new Blob([buffer], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  currentPdfBlobUrl = url;

  // pdf.js's getDocument() takes ownership of (detaches) whatever ArrayBuffer
  // it's handed, so it can't share `buffer` with the Blob above — give it an
  // independent copy for our own outline/text-extraction parse.
  const docBytes = new Uint8Array(buffer).slice();

  // Resume where the reader last left off (see the module-level currentPdfDoc
  // comment for why this is set only from explicit nav, never live scroll).
  const savedPage = record.lastCfi?.startsWith('pdf-page-')
    ? parseInt(record.lastCfi.slice('pdf-page-'.length), 10)
    : null;
  currentPdfPage = savedPage && savedPage > 0 ? savedPage : 1;

  const container = document.createElement('div');
  container.className = 'pdf-reader-container';
  container.id = 'pdf-container';
  el.viewer.appendChild(container);

  const iframe = document.createElement('iframe');
  iframe.className = 'pdf-native-iframe';
  iframe.src = `${url}${pdfViewerFragment(currentPdfPage, currentPdfZoom)}`;
  iframe.title = record.title;
  container.appendChild(iframe);
  currentPdfIframe = iframe;

  // Placeholder TOC/progress until the parse below resolves (or if it fails).
  flatToc = [{ href: 'pdf-page-1', label: record.title }];
  renderTocTree(flatToc);
  updatePdfProgressUi(record);

  try {
    const loadingTask = pdfjsLib.getDocument({ data: docBytes });
    currentPdfLoadingTask = loadingTask;
    currentPdfDoc = await loadingTask.promise;
    pdfTotalPages = currentPdfDoc.numPages;
    if (currentPdfPage > pdfTotalPages) currentPdfPage = 1;
    updatePdfProgressUi(record);

    const outline = await currentPdfDoc.getOutline();
    if (outline && outline.length) {
      const { flat, tree } = await pdfOutlineToToc(currentPdfDoc, outline);
      flatToc = flat;
      pdfHasOutline = true;
      renderTocTree(tree);
      updatePdfProgressUi(record);
    }
  } catch (err) {
    console.warn('PDF outline/text setup failed:', err);
  }

  // Chat's availability depends on currentPdfDoc, which just resolved above.
  refreshChatButtonVisibility();
}

// Walks a pdf.js outline tree, resolving each entry's destination to a
// 1-based page number (encoded as `pdf-page-N`, the same pseudo-cfi
// bookmarks/progress use). Returns both a flat list in document order (for
// pdfChapterLabelForPage's "which section am I in" scan, which needs a flat
// sequence, not a tree) and the nested tree itself (for rendering
// section/subsection structure in the Contents drawer).
async function pdfOutlineToToc(
  pdfDoc: pdfjsLib.PDFDocumentProxy,
  outline: any[]
): Promise<{ flat: TocTreeNode[]; tree: TocTreeNode[] }> {
  const flat: TocTreeNode[] = [];

  async function resolvePage(dest: any): Promise<number | null> {
    try {
      const resolved = typeof dest === 'string' ? await pdfDoc.getDestination(dest) : dest;
      if (!resolved || !Array.isArray(resolved)) return null;
      const index = await pdfDoc.getPageIndex(resolved[0]);
      return index + 1;
    } catch {
      return null;
    }
  }

  async function walk(items: any[]): Promise<TocTreeNode[]> {
    const nodes: TocTreeNode[] = [];
    for (const item of items) {
      const page = item.dest ? await resolvePage(item.dest) : null;
      const node: TocTreeNode = {
        href: `pdf-page-${page ?? 1}`,
        label: (item.title || '').trim() || 'Untitled',
      };
      flat.push({ href: node.href, label: node.label });
      if (item.items && item.items.length) node.subitems = await walk(item.items);
      nodes.push(node);
    }
    return nodes;
  }

  const tree = await walk(outline);
  return { flat, tree };
}

// PDF Open Parameters fragment: pins the page, applies our own tracked zoom
// (the native toolbar — and its zoom controls — is suppressed via toolbar=0,
// since its sidebar toggle lives in an unreachable nested chrome-extension://
// context we can't fix, so we replace the whole thing with our own Contents
// drawer + zoom buttons).
function pdfViewerFragment(page: number, zoom: number): string {
  return `#page=${page}&zoom=${zoom}&toolbar=0`;
}

// Reassigning `.src` on an already-loaded PDF iframe does NOT reliably
// re-navigate Chromium's built-in viewer — confirmed empirically: a freshly
// created iframe honors `#page=N` immediately, but changing `.src` on a live
// one silently no-ops. So every navigation (page or zoom change) replaces
// the iframe element outright instead of reassigning its src.
function reloadPdfIframe(page: number, zoom: number) {
  if (!currentPdfIframe || !currentPdfBlobUrl) return;
  const container = currentPdfIframe.parentElement;
  if (!container) return;
  const iframe = document.createElement('iframe');
  iframe.className = 'pdf-native-iframe';
  iframe.title = currentPdfIframe.title;
  iframe.src = `${currentPdfBlobUrl}${pdfViewerFragment(page, zoom)}`;
  container.replaceChild(iframe, currentPdfIframe);
  currentPdfIframe = iframe;
}

// Jumps the native viewer to a given 1-based page. Also updates
// progress/bookmark state, since this is the only moment we actually know
// what page the reader is on.
function navigateToPdfPage(page: number) {
  if (!currentPdfIframe || !currentPdfBlobUrl || !currentBookRecord || !Number.isFinite(page)) return;
  const clamped = pdfTotalPages > 0 ? Math.min(Math.max(1, page), pdfTotalPages) : Math.max(1, page);
  currentPdfPage = clamped;
  reloadPdfIframe(clamped, currentPdfZoom);
  updatePdfProgressUi(currentBookRecord, true);
}

// Zoom range mirrors common PDF viewers (50%–300%, 10% steps). Reloads the
// iframe at the current page so zoom and page position stay in sync.
function setPdfZoom(zoom: number) {
  if (!currentPdfIframe) return;
  currentPdfZoom = Math.min(300, Math.max(50, zoom));
  el.pdfZoomValue.textContent = `${currentPdfZoom}%`;
  reloadPdfIframe(currentPdfPage, currentPdfZoom);
}

// flatToc is built in document order by pdfOutlineToToc's depth-first walk,
// so the last entry at or before the current page is a reasonable "which
// section am I in" guess — same idea as epub's updateChapterFromCfi.
function pdfChapterLabelForPage(page: number): string {
  // Default covers pages before the first outline entry (e.g. a cover or
  // title page that isn't itself bookmarked) — only overwritten below once
  // an entry at or before `page` is actually found.
  let label = `Page ${page}`;
  if (!pdfHasOutline) return label;
  for (const t of flatToc) {
    const m = /^pdf-page-(\d+)$/.exec(t.href);
    if (!m) continue;
    if (parseInt(m[1], 10) <= page) label = t.label; else break;
  }
  return label;
}

// Mirrors the scroll-driven progress handler text/md uses (openTextReader),
// but PDF has no scroll signal to hook — this is called only from explicit
// page moves (initial open, TOC clicks, edge-nav prev/next).
function updatePdfProgressUi(record: BookRecord, persist = false) {
  const pct = pdfTotalPages > 1 ? (currentPdfPage - 1) / (pdfTotalPages - 1) : 0;
  currentChapterLabel = pdfHasOutline ? pdfChapterLabelForPage(currentPdfPage) : record.title;
  el.progressChapter.textContent = currentChapterLabel;
  syncReaderChapterTitle();
  el.progressRemaining.textContent = pdfTotalPages ? `Page ${currentPdfPage}/${pdfTotalPages}` : '';
  el.progressPercent.textContent = `${Math.round(pct * 100)}%`;
  el.progressFill.style.width = `${pct * 100}%`;

  const pseudoCfi = `pdf-page-${currentPdfPage}`;
  currentLocationCfi = pseudoCfi;
  refreshBookmarkButton();

  if (persist) {
    record.progress = pct;
    record.lastCfi = pseudoCfi;
    persistLibrary();
  }
}

// Extracts and caches one PDF page's text — used for both the chat passage
// and bookmark previews. Cached because chat re-derives its passage fresh on
// every send (see currentChatPassage) and re-parsing the same page each time
// would be wasteful.
async function getPdfPageText(pageNum: number): Promise<string> {
  const cached = pdfPageTextCache.get(pageNum);
  if (cached !== undefined) return cached;
  if (!currentPdfDoc) return '';
  try {
    const page = await currentPdfDoc.getPage(pageNum);
    const content = await page.getTextContent();
    const text = content.items.map((it: any) => it.str || '').join(' ').replace(/\s+/g, ' ').trim();
    pdfPageTextCache.set(pageNum, text);
    return text;
  } catch (err) {
    console.warn('PDF page text extraction failed:', err);
    return '';
  }
}



// Markdown/text footer: the section being read and the time left, the same
// two facts the EPUB footer gives.
const WORDS_PER_MIN = 230;
function updateTextProgressMeta(container: HTMLElement, pct: number) {
  const words = Number(container.dataset.words || 0);
  const left = Math.max(1, Math.round((words * (1 - pct)) / WORDS_PER_MIN));
  el.progressRemaining.textContent = pct >= 0.995 ? 'Finished' : `${minutesLabel(left)} left`;
  const top = container.scrollTop + 120;
  let label = currentBookRecord?.title || '';
  container.querySelectorAll<HTMLElement>('h1, h2, h3').forEach(h => {
    if (h.offsetTop <= top) label = h.textContent?.trim() || label;
  });
  el.progressChapter.textContent = label;
}

async function openTextReader(record: BookRecord, buffer: ArrayBuffer) {
  const container = document.createElement('div');
  container.className = 'text-reader-container';
  container.id = 'text-container';
  el.viewer.appendChild(container);
  currentTextElement = container;

  const rawText = new TextDecoder('utf-8').decode(buffer);
  const fmt = record.format || getBookFormat(record);

  currentTextRaw = rawText;

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
  container.dataset.words = String((container.textContent || '').split(/\s+/).filter(Boolean).length);
  // Frame + syntax-colour code blocks (async; never changes the text itself).
  void enhanceCodeBlocks(container);

  flatToc = [];
  const tocTree: TocTreeNode[] = [];
  // Stack of open ancestors by heading level, so e.g. an h3 nests under the
  // nearest preceding h2 (which nests under the nearest preceding h1) —
  // headings carry their own section/subsection structure for free.
  const openAncestors: { level: number; node: TocTreeNode }[] = [];
  const headings = container.querySelectorAll<HTMLHeadingElement>('h1, h2, h3, h4');
  headings.forEach((h, idx) => {
    const id = `heading-${idx}`;
    h.id = id;
    const label = h.textContent || `Section ${idx + 1}`;
    flatToc.push({ href: id, label });
    const level = parseInt(h.tagName[1], 10);
    const node: TocTreeNode = { href: id, label };
    while (openAncestors.length && openAncestors[openAncestors.length - 1].level >= level) {
      openAncestors.pop();
    }
    if (openAncestors.length) {
      const parent = openAncestors[openAncestors.length - 1].node;
      (parent.subitems ??= []).push(node);
    } else {
      tocTree.push(node);
    }
    openAncestors.push({ level, node });
  });
  renderTocTree(tocTree);
  renderPageOutline(tocTree, container);

  // Seed the bookmark-tracking location from the saved position immediately
  // — otherwise the bookmark button/state stay unset until the first scroll
  // event fires, which never happens if the reader opens already at the top.
  currentLocationCfi = record.lastCfi?.startsWith('scroll-') ? record.lastCfi : `scroll-${record.progress.toFixed(4)}`;
  refreshBookmarkButton();

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
    const pseudoCfi = `scroll-${pct.toFixed(4)}`;
    record.lastCfi = pseudoCfi;
    // Bookmarks have no EPUB CFI to anchor to in plain text, so they reuse
    // this same scroll-percentage encoding — keep the module-level "current
    // location" in sync so toggleBookmark()/refreshBookmarkButton() work here
    // exactly like they do for epub's relocated-driven currentLocationCfi.
    currentLocationCfi = pseudoCfi;
    refreshBookmarkButton();

    el.progressPercent.textContent = `${Math.round(pct * 100)}%`;
    el.progressFill.style.width = `${pct * 100}%`;
    updateTextProgressMeta(container, pct);
    persistLibrary();
    scheduleTextSpy(container);
    // A scroll the reader made themselves (not our own follow-scroll) means they
    // are browsing: read-aloud must stay where it is, not chase or fight the view.
    if (ttsOn && performance.now() > ttsAutoScrollUntil) ttsUserScrolled = true;
  });
  updateTextProgressMeta(container, record.progress);
  scheduleTextSpy(container);
}

// "On this page": a small outline beside the text of Markdown / text / saved
// articles, shown only when there is room beside the column.
function renderPageOutline(tree: TocTreeNode[], container: HTMLElement): void {
  el.pageOutline.innerHTML = '';
  const entries: { node: TocTreeNode; depth: number }[] = [];
  for (const n of tree) {
    entries.push({ node: n, depth: 0 });
    for (const s of n.subitems ?? []) entries.push({ node: s, depth: 1 });
  }
  // A lone top-level title (the document's own H1) is not an outline.
  if (entries.length < 3) { el.pageOutline.hidden = true; return; }

  const title = document.createElement('div');
  title.className = 'po-title';
  title.textContent = 'On this page';
  el.pageOutline.appendChild(title);
  for (const { node, depth } of entries) {
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'po-link' + (depth ? ' po-sub' : '');
    a.dataset.href = node.href;
    a.innerHTML = '<span class="po-dot" aria-hidden="true"></span>' + escapeHtml(node.label.trim());
    a.addEventListener('click', (e) => {
      e.preventDefault();
      container.querySelector<HTMLElement>('#' + CSS.escape(node.href))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    el.pageOutline.appendChild(a);
  }
  el.pageOutline.hidden = false;
}

let textSpyQueued = false;
function scheduleTextSpy(container: HTMLElement): void {
  if (textSpyQueued) return;
  textSpyQueued = true;
  requestAnimationFrame(() => {
    textSpyQueued = false;
    const top = container.getBoundingClientRect().top + 90;
    let current = '';
    container.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id], h4[id]').forEach(h => {
      if (h.getBoundingClientRect().top <= top) current = h.id;
    });
    document.querySelectorAll<HTMLElement>('#page-outline .po-link, #toc-list .toc-item').forEach(a => {
      a.classList.toggle('current', !!current && a.dataset.href === current);
    });
  });
}

// "You stopped here": a quiet note in the left margin when a book is reopened.
// It fades after a few seconds or on the first page turn, whichever is first.
let resumeShownAt = 0;
let resumeTimer = 0;
let resumePending = false;

function describeWhen(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const h = d.getHours();
  const part = h < 5 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86400000);
  if (days <= 0) return 'This ' + part;
  if (days === 1) return 'Yesterday ' + part;
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' }) + ' ' + part;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function showResumeNote(prevSeen: number): void {
  el.resumeNoteSub.textContent = describeWhen(prevSeen) + '.';
  el.resumeNote.hidden = true;
  resumePending = true;   // shown by placeResumeNote() once the text column is measurable
}

function placeResumeNote(): void {
  if (!resumePending) return;
  const col = readingColumnRect();
  if (!col || col.width === 0) return;
  resumePending = false;
  if (col.left < 220) return;   // no room in the margin
  el.resumeNote.style.left = `${Math.round(col.left - 206)}px`;
  el.resumeNote.hidden = false;
  el.resumeNote.classList.remove('is-leaving');
  resumeShownAt = Date.now();
  window.clearTimeout(resumeTimer);
  resumeTimer = window.setTimeout(() => dismissResumeNote(true), 12000);
}

function dismissResumeNote(force: boolean): void {
  if (el.resumeNote.hidden) return;
  // The first relocation right after opening is the restore itself, not a page turn.
  if (!force && Date.now() - resumeShownAt < 3000) return;
  window.clearTimeout(resumeTimer);
  el.resumeNote.classList.add('is-leaving');
  window.setTimeout(() => { el.resumeNote.hidden = true; el.resumeNote.classList.remove('is-leaving'); }, 400);
}

// Where each spine section starts, as a fraction of the book, read straight from
// the generated locations.
let secStartMap: Map<string, number> | null = null;

function sectionStartPct(cfiBase: string): number {
  const locs: any = (currentBook as any)?.locations;
  const list: string[] = locs?._locations ?? [];
  if (list.length < 2 || !cfiBase) return NaN;
  if (!secStartMap || (secStartMap as any).__n !== list.length) {
    const m = new Map<string, number>();
    list.forEach((c, i) => {
      const bang = c.indexOf('!');
      if (bang < 0) return;
      const b = c.slice(8, bang);
      if (!m.has(b)) m.set(b, i);
    });
    (m as any).__n = list.length;
    secStartMap = m;
  }
  const i = secStartMap.get(cfiBase);
  return i === undefined ? NaN : i / (list.length - 1);
}

// The text column the EPUB is laid out in. The iframe itself is not it: epub.js
// scrolls a strip of page-wide iframes inside this container.
function readingColumnRect(): DOMRect | null {
  return document.querySelector('#viewer .epub-container')?.getBoundingClientRect() ?? null;
}

// Re-draw the strip for the current page (marks changed).
function refreshPageStrip(): void {
  if (!currentRendition || activeFormat !== 'epub') return;
  try { updatePageStrip(currentRendition.currentLocation()); } catch { /* not displayed yet */ }
}

// One tick per page of the current chapter (the current page longer and in the
// accent colour), with a dot for highlights and a flag for bookmarks. Page
// numbers come from epub.js; where a mark falls is estimated from the book's
// location data, so it can be a page off.
function updatePageStrip(loc: any): void {
  const strip = el.pageStrip;
  const disp = loc?.start?.displayed;
  if (!currentRendition || !currentBook || settings.layout !== 'paginated' || !disp || !(disp.total > 1)) {
    strip.hidden = true;
    return;
  }
  placeResumeNote();
  const col = readingColumnRect();
  if (!col || window.innerWidth - col.right < 48) { strip.hidden = true; return; }
  strip.style.left = `${Math.round(col.right + 16)}px`;
  const total: number = disp.total;
  const page: number = Math.max(1, Math.min(total, disp.page));

  const book: any = currentBook;
  const locs: any = book.locations;
  let secStart = NaN;
  let secEnd = 1;
  let base = '';
  try {
    const cfi: string = loc.start.cfi;
    base = cfi.slice(8, cfi.indexOf('!'));
    if (((locs?.length?.() ?? 0) > 0) && base) {
      secStart = sectionStartPct(base);
      const next = book.spine.get((loc.start.index ?? -1) + 1);
      if (next?.cfiBase) {
        const e = sectionStartPct(next.cfiBase);
        if (Number.isFinite(e)) secEnd = e;
      }
    }
  } catch { /* marks are optional */ }

  // Ignore id assertions ("[chapter1]") when comparing, and read a range CFI by its start.
  const bare = (c: string) => c.replace(/\[[^\]]*\]/g, '');
  const pageOf = (cfi: string): number => {
    if (!Number.isFinite(secStart) || !(secEnd > secStart) || !base || !bare(cfi).includes(bare(base) + '!')) return -1;
    let point = cfi;
    const inner = cfi.slice(8, -1).split(',');
    if (inner.length === 3) point = 'epubcfi(' + inner[0] + inner[1] + ')';
    const pct = locs.percentageFromCfi(point);
    if (!Number.isFinite(pct)) return -1;
    return Math.max(0, Math.min(total - 1, Math.floor(((pct - secStart) / (secEnd - secStart)) * total)));
  };
  const hl = new Set<number>();
  const bm = new Set<number>();
  for (const h of currentMarks.highlights) { const p = pageOf(h.cfi); if (p >= 0) hl.add(p); }
  for (const b of currentMarks.bookmarks) { const p = pageOf(b.cfi); if (p >= 0) bm.add(p); }

  // Long chapters share ticks so the strip stays short.
  const ticks = Math.min(total, 36);
  const per = total / ticks;
  const cur = Math.min(ticks - 1, Math.floor((page - 1) / per));
  const inTick = (set: Set<number>, t: number) => {
    for (const p of set) if (Math.min(ticks - 1, Math.floor(p / per)) === t) return true;
    return false;
  };

  strip.textContent = '';
  for (let t = 0; t < ticks; t++) {
    const row = document.createElement('div');
    row.className = 'ps-row' + (t < cur ? ' is-past' : t === cur ? ' is-current' : '');
    const mark = document.createElement('span');
    mark.className = 'ps-mark';
    if (inTick(bm, t)) mark.classList.add('is-bookmark');
    else if (inTick(hl, t)) mark.classList.add('is-highlight');
    const bar = document.createElement('span');
    bar.className = 'ps-bar';
    row.append(mark, bar);
    strip.appendChild(row);
  }
  strip.setAttribute('role', 'img');
  strip.setAttribute('aria-label', 'Page ' + page + ' of ' + total + ' in this chapter, ' + hl.size + ' highlights and ' + bm.size + ' bookmarks');
  strip.hidden = false;
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
    if (ttsOn && performance.now() > ttsAutoScrollUntil) ttsUserScrolled = true;
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
  currentRendition.on('relocated', () => { hideSelectionPopover(); decorateTocProgress(); });
  currentRendition.hooks.content.register((contents: any) => {
    const doc: Document = contents.document;
    injectReaderFonts(doc);
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

    // Vim nav keys don't bubble out of the iframe to the document-level
    // keyup listener, so once a click has moved focus into the page content
    // (e.g. to select a word for lookup) hjkl/gg/G would silently stop
    // working without this mirror.
    doc.addEventListener('keyup', (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target as Element)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'h' || e.key === 'k') vimPageNav('prev');
      else if (e.key === 'j' || e.key === 'l') vimPageNav('next');
      else if (e.key === 'g') {
        const now = Date.now();
        if (now - lastGKeydownAt < GG_CHORD_WINDOW_MS) {
          lastGKeydownAt = 0;
          vimGoToStart();
        } else {
          lastGKeydownAt = now;
        }
      } else if (e.key === 'G') {
        lastGKeydownAt = 0;
        vimGoToEnd();
      }
    });

    doc.addEventListener('click', (e: MouseEvent) => {
      const a = (e.target as Element).closest('a');
      if (a && a.getAttribute('href')) {
        const href = a.getAttribute('href');
        if (href && isExternalLink(href)) {
          // Web / mail links go to the default browser, never into the page frame.
          e.preventDefault();
          e.stopPropagation();
          openExternalLink(href);
        } else if (href && (href.startsWith('#') || a.getAttribute('epub:type') === 'noteref' || a.textContent?.match(/^[\d\*\[\]]+$/))) {
          e.preventDefault();
          e.stopPropagation();
          // Event coordinates are relative to the page's iframe; the popover
          // lives in the main window.
          const frameRect = (contents.window?.frameElement as HTMLElement | null)?.getBoundingClientRect();
          showFootnote(href, e.clientX + (frameRect?.left ?? 0), e.clientY + (frameRect?.top ?? 0), doc);
        } else if (href && !/^[a-z]+:/i.test(href) && currentLocationCfi) {
          // A link to another part of the book: remember where the reader
          // was so they can come straight back.
          showReturnPill(currentLocationCfi);
        }
      }
    }, true);

    installFocusTracker(contents.document, contents.window?.frameElement ?? null);

    // Underline any saved-vocab words on the freshly-loaded section. The
    // overlay is body-relative so paginated column turns within the
    // section keep the markers aligned automatically.
    renderVocabHighlightsForDoc(contents.document);
  });

  await currentRendition.display(record.lastCfi || undefined);

  currentBook.loaded.navigation.then((nav) => {
    flatToc = [];
    flatTocFromNav(nav.toc);
    renderTocTree(nav.toc);
    decorateTocProgress();
  });

  currentBook.ready.then(async () => {
    const book = currentBook;
    if (!book) return;
    const cached = localStorage.getItem(KEY_LOCATIONS(record.id));
    if (cached) {
      try {
        (book.locations as any).load(cached);
        buildSpineStats();
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
    buildSpineStats();
    updateProgress();
  });
}

// Links that leave the book (web pages, mail, phone) open in the system's
// default browser instead of navigating the reading surface.
function isExternalLink(href: string): boolean {
  return /^(https?:|mailto:|tel:)/i.test(href.trim());
}
function openExternalLink(href: string): void {
  openUrl(href.trim()).catch(err => {
    console.warn('openUrl failed:', err);
    toast("Couldn't open the link");
  });
}

async function openReader(record: BookRecord, buffer: ArrayBuffer) {
  cleanupCurrentReader();

  currentBookRecord = record;
  const prevSeen = record.lastOpenedAt || 0;
  record.lastOpenedAt = Date.now();     // "recently opened" ordering on the library screen
  persistLibrary();
  refreshReadButton();
  activeFormat = record.format || getBookFormat(record);
  activeProfile = profileForRecord(record);
  loadProfile(activeProfile);
  el.formatBadge.textContent = record.sourceUrl ? 'WEB' : activeFormat.toUpperCase();
  el.formatBadge.title = record.sourceUrl
    ? 'Saved web article'
    : ({ epub: 'EPUB book', pdf: 'PDF document', md: 'Markdown file', txt: 'Text file' } as Record<string, string>)[activeFormat] || '';
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
  if (el.readerChapterTitle) el.readerChapterTitle.textContent = '';
  secStartMap = null;
  el.pageOutline.hidden = true;
  el.pageOutline.innerHTML = '';
  el.resumeNote.hidden = true;
  resumePending = false;
  el.pageStrip.hidden = true;
  el.pageStrip.innerHTML = '';
  if (activeFormat === 'epub' && (record.progress || 0) > 0.01 && prevSeen && Date.now() - prevSeen > 10 * 60 * 1000) {
    showResumeNote(prevSeen);
  }
  el.openOriginalBtn.hidden = !record.sourceUrl;
  goToScreen('reader');
  resetReflowTracking();
  // Covers the case where this book opens before the boot-time LLM probe
  // resolves. For PDF this also correctly hides it pending currentPdfDoc
  // (still null from cleanup at this point) — openPdfReader re-checks once
  // its parse resolves.
  refreshChatButtonVisibility();
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

function syncReaderChapterTitle() {
  if (!el.readerChapterTitle) return;
  const title = currentBookRecord?.title || '';
  el.readerChapterTitle.textContent = currentChapterLabel && currentChapterLabel !== title
    ? currentChapterLabel
    : '';
}

function updateChapterFromCfi(href: string) {
  const clean = href.split('#')[0];
  const match = flatToc.find(t => t.href.split('#')[0] === clean) || flatToc[0];
  currentChapterLabel = match?.label || '';
  el.progressChapter.textContent = currentChapterLabel;
  syncReaderChapterTitle();

  document.querySelectorAll<HTMLAnchorElement>('#toc-list .toc-item').forEach(a => {
    a.classList.toggle('current', a.dataset.href?.split('#')[0] === clean);
  });
}

// Per-chapter location counts, so the progress bar can show the book as a
// row of chapters and "time left" can be given for the current chapter.
// Built from epub.js locations (one entry per ~1600 characters): each
// location CFI starts with the spine step of the section it falls in.
interface SpineStat { spineIndex: number; start: number; count: number; }
let spineStats: SpineStat[] = [];
const MIN_PER_LOCATION = 0.35;

function spineIndexFromCfi(cfi: string): number {
  const m = /^epubcfi\(\/6\/(\d+)/.exec(cfi);
  return m ? parseInt(m[1], 10) / 2 - 1 : -1;
}

function buildSpineStats() {
  spineStats = [];
  const locs: string[] = (currentBook?.locations as any)?._locations ?? [];
  locs.forEach((cfi, i) => {
    const idx = spineIndexFromCfi(cfi);
    const last = spineStats[spineStats.length - 1];
    if (last && last.spineIndex === idx) last.count++;
    else spineStats.push({ spineIndex: idx, start: i, count: 1 });
  });
  renderProgressSegments();
  decorateTocProgress();
}

function renderProgressSegments() {
  const host = el.progressSegments;
  host.innerHTML = '';
  const segmented = activeFormat === 'epub' && spineStats.length > 1 && spineStats.length <= 120;
  el.progressTrack.classList.toggle('is-segmented', segmented);
  if (!segmented) return;
  host.style.setProperty('--seg-gap', spineStats.length > 40 ? '1px' : '3px');
  for (const st of spineStats) {
    const seg = document.createElement('span');
    seg.className = 'progress-seg';
    seg.style.flexGrow = String(st.count);
    const fill = document.createElement('span');
    fill.className = 'progress-seg-fill';
    seg.appendChild(fill);
    host.appendChild(seg);
  }
}

function paintProgressSegments(locIndex: number) {
  const segs = el.progressSegments.children;
  spineStats.forEach((st, i) => {
    const seg = segs[i] as HTMLElement | undefined;
    if (!seg) return;
    const done = locIndex >= st.start + st.count;
    const current = !done && locIndex >= st.start;
    seg.classList.toggle('is-done', done);
    seg.classList.toggle('is-current', current);
    const fill = seg.firstElementChild as HTMLElement | null;
    if (fill) fill.style.width = current ? `${((locIndex - st.start + 1) / st.count) * 100}%` : '';
  });
}

function minutesLabel(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
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
  dismissResumeNote(false);
  updatePageStrip(loc);

  const total = (currentBook.locations as any).length?.() ?? 0;
  const current = (currentBook.locations as any).locationFromCfi(loc.start.cfi) ?? 0;
  if (total > 0) {
    const section = spineStats.find(st => current >= st.start && current < st.start + st.count);
    if (section) {
      const left = Math.max(1, Math.round((section.start + section.count - current) * MIN_PER_LOCATION));
      el.progressRemaining.textContent = `${minutesLabel(left)} left in chapter`;
    } else {
      const remainingMin = Math.max(1, Math.round((total - current) * MIN_PER_LOCATION));
      el.progressRemaining.textContent = `${minutesLabel(remainingMin)} left`;
    }
    paintProgressSegments(current);
  } else {
    el.progressRemaining.textContent = '';
  }
}

// Contents panel: tick chapters already read, and give the reading time of
// the ones still ahead.
function decorateTocProgress() {
  if (!currentBook || activeFormat !== 'epub') return;
  const book = currentBook;
  const currentIdx = currentLocationCfi ? spineIndexFromCfi(currentLocationCfi) : -1;
  const counts = new Map(spineStats.map(st => [st.spineIndex, st.count]));
  document.querySelectorAll<HTMLAnchorElement>('#toc-list .toc-item').forEach(a => {
    const href = a.dataset.href?.split('#')[0];
    const item = href ? (book.spine as any).get(href) : null;
    const idx: number = item ? item.index : -1;
    a.classList.toggle('is-read', idx >= 0 && currentIdx >= 0 && idx < currentIdx);
    let meta = a.querySelector<HTMLSpanElement>('.toc-meta');
    const count = counts.get(idx);
    const showTime = idx > currentIdx && count != null && a.closest('ul ul') == null;
    if (!showTime) { meta?.remove(); return; }
    if (!meta) {
      meta = document.createElement('span');
      meta.className = 'toc-meta';
      a.appendChild(meta);
    }
    meta.textContent = minutesLabel(Math.max(1, Math.round(count * MIN_PER_LOCATION)));
  });
}

/* ============================================================
   TOC / Bookmarks / Highlights drawer
   ============================================================ */
// Bookmarks/highlights normally jump via an EPUB CFI (currentRendition.display).
// Text/md has no CFI, so its entries carry a `scroll-<pct>` pseudo-cfi instead
// (same encoding openTextReader's scroll handler writes into lastCfi) — this
// routes to whichever navigation the format actually has.
function navigateToCfi(cfi: string) {
  if (cfi.startsWith('scroll-') && currentTextElement) {
    const pct = parseFloat(cfi.slice('scroll-'.length));
    if (!Number.isNaN(pct)) {
      const totalScroll = currentTextElement.scrollHeight - currentTextElement.clientHeight;
      currentTextElement.scrollTop = pct * totalScroll;
    }
    return;
  }
  if (cfi.startsWith('pdf-page-')) {
    const page = parseInt(cfi.slice('pdf-page-'.length), 10);
    if (!Number.isNaN(page)) navigateToPdfPage(page);
    return;
  }
  currentRendition?.display(cfi);
}

function renderBookmarksList() {
  refreshPageStrip();
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
    li.addEventListener('click', () => { navigateToCfi(b.cfi); closeDrawers(); });
    el.bookmarksList.appendChild(li);
  }
}

function renderHighlightsList() {
  refreshPageStrip();
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
    li.addEventListener('click', () => { navigateToCfi(h.cfi); closeDrawers(); });
    el.highlightsList.appendChild(li);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
}

// Local-LLM replies routinely come back with markdown formatting (**bold**
// labels, numbered lists) rather than plain prose — render it instead of
// dumping asterisks/numbers as literal text. Sanitized because it's model
// output, not something we've reviewed; same defense-in-depth as the
// readability-extracted article HTML elsewhere in this file.
function renderAiMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
}

/* ============================================================
   Drawer open/close + tab switching
   ============================================================ */
// closeDrawers() defers `hidden = true` to let the CSS close transition play.
// Reopening before that timer fires must cancel it — otherwise the stale
// timeout still lands after the reopen and force-hides the drawer again
// (`[hidden]` beats the `open` class), so it flashes open then vanishes.
const drawerHideTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

function openDrawer(which: 'toc' | 'typography', tab?: DrawerTab) {
  closeDrawers();
  const target = which === 'toc' ? el.tocDrawer : el.typographyDrawer;
  const pending = drawerHideTimers.get(target);
  if (pending != null) {
    clearTimeout(pending);
    drawerHideTimers.delete(target);
  }
  target.hidden = false;
  // Force a synchronous layout flush between un-hiding and adding `open` so
  // the browser registers the closed (translateX) position before the class
  // change, letting the CSS transition actually play. Avoids requestAnimationFrame
  // here on purpose — rAF can be throttled/delayed by the browser (observed
  // firsthand: it can stall indefinitely on a nominally-active tab), which
  // would leave the drawer stuck at `hidden: false` but never `open` — visible
  // in the DOM yet still translated off-screen.
  void target.offsetHeight;
  target.classList.add('open');
  // On wide windows the panel docks beside the text instead of covering it;
  // the reader stage makes room (CSS keyed off data-drawer) and EPUB
  // re-paginates through the viewer's ResizeObserver.
  el.html.dataset.drawer = which;
  if (which === 'toc') {
    switchTab(tab || 'toc');
  } else {
    refreshTypographyUI();
  }
}

type DrawerTab = 'toc' | 'bookmarks' | 'highlights' | 'vocab';

const DOCK_MIN_WIDTH = 1180;
function isDockedLayout(): boolean {
  return window.innerWidth >= DOCK_MIN_WIDTH && settings.uiLayout !== 'minimal';
}

function closeDrawers() {
  delete el.html.dataset.drawer;
  [el.tocDrawer, el.typographyDrawer].forEach(d => {
    if (!d.classList.contains('open')) return;
    d.classList.remove('open');
    const timer = setTimeout(() => { d.hidden = true; drawerHideTimers.delete(d); }, 260);
    drawerHideTimers.set(d, timer);
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
  // No `!currentRendition` gate: text/md tracks a scroll-percentage pseudo-cfi,
  // and PDF tracks a page-number pseudo-cfi (see updatePdfProgressUi), into
  // this same variable — so this works unmodified for all three formats.
  if (!currentBookRecord || !currentLocationCfi) return;
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
  save(KEY_MARKS(currentBookRecord.id), currentMarks); refreshPageStrip();
  refreshBookmarkButton();
}

function refreshBookmarkButton() {
  const active = currentLocationCfi != null && currentMarks.bookmarks.some(b => b.cfi === currentLocationCfi);
  el.bookmarkBtn.classList.toggle('active', active);
}

function getVisiblePreviewText(): string {
  try {
    if (activeFormat === 'pdf') {
      // Synchronous by necessity (called from the bookmark click handler) —
      // use whatever's already cached from a chat lookup on this page, or
      // fall back to a page-number label and let the cache fill in later.
      const cached = pdfPageTextCache.get(currentPdfPage);
      if (cached) return cached.slice(0, 160);
      void getPdfPageText(currentPdfPage);
      return `Page ${currentPdfPage}`;
    }

    if (currentTextElement) {
      // Grab the first block element actually within the container's visible
      // viewport, rather than just the top of the whole (possibly huge)
      // document — mirrors "what's on screen right now" like the epub branch.
      const containerRect = currentTextElement.getBoundingClientRect();
      const blocks = currentTextElement.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote');
      for (const node of blocks) {
        const r = node.getBoundingClientRect();
        if (r.bottom > containerRect.top && r.top < containerRect.bottom) {
          const text = (node.textContent || '').trim().replace(/\s+/g, ' ');
          if (text) return text.slice(0, 160);
        }
      }
      return '';
    }

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

// `frameEl` is the iframe hosting `doc` for epub content, or null when `doc`
// is the top-level document (the text/md reader, which renders straight into
// the main page — no iframe to translate coordinates out of). That single
// flag is also what tells the tracker whether it needs to scope itself to a
// sub-region: an epub iframe document IS the book, entirely, but the main
// document also hosts the library screen and reader chrome, so on the main
// document the tracker only engages inside the live text/md container.
function installFocusTracker(doc: Document, frameEl: HTMLIFrameElement | null) {
  if (!doc.body) return;
  const isMainDoc = frameEl === null;
  const inScope = (target: EventTarget | null): boolean => {
    if (!isMainDoc) return true;
    return !!currentTextElement && !!target && currentTextElement.contains(target as Node);
  };

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
    if (settings.focusTracker === 'off' || !inScope(lastEvent.target)) { hide(); return; }
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
    if (settings.focusTracker === 'off' || !inScope(e.target)) { hide(); return; }
    lastEvent = e;
    if (!rafId) rafId = requestAnimationFrame(paint);
  });
  doc.addEventListener('mouseleave', hide);
  doc.body.addEventListener('mouseleave', hide);

  // Drive the reading ruler from inside the iframe: translate the cursor's
  // iframe-local Y into the main viewport so the fixed band lines up with the
  // text the pointer is over. Separate from the focus tracker above — the
  // ruler runs independently of it. Main-document case (text/md) doesn't need
  // this: wire() already installs a plain document-level mousemove listener
  // for the ruler, and there's no iframe offset to translate out of.
  if (frameEl) {
    doc.addEventListener('mousemove', (e: MouseEvent) => {
      if (!settings.readingRuler) return;
      moveRuler(frameEl.getBoundingClientRect().top + e.clientY);
    });
    doc.addEventListener('mouseleave', () => {
      if (settings.readingRuler) el.readingRuler.style.opacity = '0';
    });
  }

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
  //   - TTS on → jump playback to the clicked word (the user has an audible
  //     cursor and wants to move it)
  //   - Otherwise → let the click through. The focus tracker is a passive
  //     read-along guide; a single click no longer auto-saves a highlight
  //     (use drag-select → the highlight popover to save one deliberately).
  doc.addEventListener('click', (e: MouseEvent) => {
    if (!inScope(e.target)) return;
    if ((e.target as Element).closest('a')) return;
    if (isDragging) return;
    const sel = doc.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;

    // TTS click-to-jump. We need a word range to jump to — prefer the
    // currently-hovered focus range (if focus tracker is on), fall back to
    // computing one at the click point in 'word' mode.
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
    }
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

/* ==========================================================================
   Copy for AI — put the passage you're reading on the clipboard, ready to
   paste into Claude (or any chat). Scope, most specific first:
     1. the text you've selected
     2. PDF  -> the current page
     3. Markdown / text / saved article -> the whole document
     4. EPUB -> the whole current chapter
   Output is Markdown (headings, lists and code blocks kept), wrapped in
   <passage> tags under a one-line description of where it came from, with a
   "My question:" line left open to type after pasting.
   ========================================================================== */
let currentTextRaw = '';
let exportTurndown: TurndownService | null = null;

function getExportTurndown(): TurndownService {
  if (!exportTurndown) {
    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
    addCodeFenceRule(td);
    // Images can't travel through a text paste — keep their alt text as a marker.
    td.addRule('exportImages', {
      filter: 'img',
      replacement: (_content, node) => {
        const alt = ((node as HTMLElement).getAttribute('alt') || '').trim();
        return alt ? '[Image: ' + alt + ']' : '';
      },
    });
    exportTurndown = td;
  }
  return exportTurndown;
}

const EXPORT_STRIP_SELECTOR =
  'script, style, svg, .code-block-head, [data-focus-word], [data-focus-sentence], [data-focus-overlay], [data-vocab-highlights]';

function nodeToMarkdown(root: HTMLElement): string {
  root.querySelectorAll(EXPORT_STRIP_SELECTOR).forEach(n => n.remove());
  try {
    return getExportTurndown().turndown(root.innerHTML).replace(/\n{3,}/g, '\n\n').trim();
  } catch (err) {
    console.warn('markdown export failed, falling back to plain text', err);
    return (root.textContent || '').trim();
  }
}

// The user's current selection as Markdown ('' when there isn't one).
function exportSelectionMarkdown(): string {
  let range: Range | null = null;
  if (currentTextElement) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount && currentTextElement.contains(sel.anchorNode)) {
      range = sel.getRangeAt(0);
    }
  } else {
    const sel = getVisibleIframe()?.contentWindow?.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount) range = sel.getRangeAt(0);
    // The selection can be gone by the time a toolbar button is clicked, but
    // the popover remembers what it was.
    if (!range && !el.selectionPopover.hidden && pendingSelectionCfi && currentRendition) {
      try { range = (currentRendition as any).getRange(pendingSelectionCfi) as Range; } catch { /* ignore */ }
    }
  }
  if (!range || range.collapsed) return '';
  const holder = document.createElement('div');
  holder.appendChild(range.cloneContents());
  return nodeToMarkdown(holder) || range.toString().trim();
}

// The whole section (chapter) the EPUB viewer is showing.
function exportChapterMarkdown(): string {
  const body = getVisibleIframe()?.contentDocument?.body;
  return body ? nodeToMarkdown(body.cloneNode(true) as HTMLElement) : '';
}

async function writeClipboardText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

async function copyForAi(): Promise<void> {
  const rec = currentBookRecord;
  if (!rec || (!currentRendition && !currentTextElement && activeFormat !== 'pdf')) {
    toast('Open a book first');
    return;
  }

  let scope = '';
  let body = '';
  const selected = activeFormat === 'pdf' ? '' : exportSelectionMarkdown();
  if (selected) {
    scope = 'selected passage';
    body = selected;
  } else if (activeFormat === 'pdf') {
    scope = 'text of page ' + currentPdfPage;
    body = (await getPdfPageText(currentPdfPage)).trim();
  } else if (currentTextElement) {
    scope = rec.sourceUrl ? 'full article' : 'full document';
    body = currentTextRaw.trim();
  } else {
    scope = 'current chapter';
    body = exportChapterMarkdown();
  }
  if (!body) { toast('Nothing to copy here'); return; }

  let from = '"' + rec.title + '"' + (rec.author ? ' by ' + rec.author : '');
  if (currentChapterLabel && activeFormat === 'epub') from += ' (chapter: ' + currentChapterLabel + ')';
  if (rec.sourceUrl) from += ' — ' + rec.sourceUrl;
  const text = "I'm reading " + from + '. Here is the ' + scope + ':\n\n<passage>\n' + body + '\n</passage>\n\nMy question: ';

  const words = body.split(/\s+/).filter(Boolean).length;
  if (await writeClipboardText(text)) {
    toast('Copied ' + scope + ' (' + words.toLocaleString() + ' words) — paste it into Claude');
  } else {
    toast("Couldn't access the clipboard");
  }
}

let selAnchorX = 0;
let selAnchorY = 0;

function isSingleWord(t: string): boolean {
  return t.length > 1 && !/\s/.test(t);
}

// Speak one word: the Piper voice when it is installed, otherwise the system voice.
function sayWord(word: string, btn: HTMLButtonElement): void {
  const w = word.replace(/[^\p{L}'’-]/gu, '').trim();
  if (!w) return;
  if (canPronounceNeural()) { void pronounceWord(w, btn); return; }
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(w);
    u.lang = 'en-US';
    window.speechSynthesis.speak(u);
  } catch { /* no system voice available */ }
}

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

    // One popover: highlight colours, plus Look up / Pronounce for a single
    // word. The dictionary no longer opens on its own beside it.
    selAnchorX = pageX;
    selAnchorY = pageY;
    const single = isSingleWord(pendingSelectionText);
    el.popoverLookup.hidden = !single;
    el.popoverSay.hidden = !single;
    showSelectionPopover(pageX, pageY);
  } catch (e) { console.error(e); }
}

// Dictionary lookup for the Text/Markdown reader. epub content lives inside
// an iframe and finalizes selections via epub.js's own 'selected' event
// (onSelected, above); the text/md reader renders straight into the main
// document, so a plain mouseup is the equivalent "selection is done" signal.
// Only the word-lookup half of onSelected applies here — highlight swatches
// stay epub-only because persisted highlights are anchored to an EPUB CFI,
// which plain text has no equivalent of.
function onTextReaderMouseUp(e: MouseEvent) {
  if (!currentTextElement) return;
  // This listener is global (registered once on `document`), so it fires for
  // EVERY mouseup in the app — including clicks on the dict popover's own
  // buttons, which live in the same main document as the text reader. Without
  // checking the click's actual target, clicking "Explain in context" (or any
  // other popover button) while a just-made word selection is still technically
  // non-collapsed would be misread as "a new selection just finished here",
  // triggering hideDictPopover() and hiding the very popover being clicked —
  // the button's own handler still runs afterward, but on a display:none
  // element nobody can see. mouseup fires before click, so this race is real.
  if (!currentTextElement.contains(e.target as Node)) return;

  const sel = window.getSelection();
  const text = (sel?.toString() || '').trim();
  if (!sel || sel.isCollapsed || !text) return;
  const anchorNode = sel.anchorNode;
  if (!anchorNode || !currentTextElement.contains(anchorNode)) return;

  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return;
  const pageX = rect.left + rect.width / 2;
  const pageY = rect.top - 10;

  pendingSelectionCfi = null;
  pendingSelectionText = text;
  pendingSelectionContext = extractSentenceContext(range);

  hideDictPopover();
  hideFootnotePopover();
  const currentId = ++dictionaryLookupId;

  if (!text.includes(' ') && text.length > 1) {
    lookupWord(text, pageX, pageY, currentId);
  }
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
      dictAi.prepare(wikiData.title, pendingSelectionContext);
      preparePronounceBtn(el.dictPronounceBtn, wikiData.title);
      offerVocabEntry({ display: wikiData.title, definitionHtml: wikiHtml, phonetic: 'Wikipedia' });
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
    dictAi.prepare(entry.word, pendingSelectionContext);
    preparePronounceBtn(el.dictPronounceBtn, entry.word);
    offerVocabEntry({ display: entry.word, definitionHtml: el.dictMeanings.innerHTML, phonetic });
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
    dictAi.prepare(cleanWord, pendingSelectionContext);
    preparePronounceBtn(el.dictPronounceBtn, cleanWord);
  }
}

// Dictionary lookup for PDF: the native viewer's own text selection isn't
// reachable from JS — its actual page content lives inside a nested
// chrome-extension:// context, the same wall documented on currentPdfDoc —
// so there's no selection/mouseup event to hook the way epub/text do. This
// is copy-paste driven instead: the user selects+copies a word using the
// native viewer's own (fully working) selection, then clicks this button,
// which reads it back off the clipboard.
async function lookupWordFromPdfClipboard() {
  let clip: string | null = null;
  try {
    clip = await readClipboardText();
  } catch (err) {
    console.error('Clipboard read failed:', err);
    toast("Couldn't read the clipboard.");
    return;
  }

  const word = (clip || '').trim();
  if (!word) {
    toast('Select a word in the PDF and copy it (Ctrl+C), then try again.');
    return;
  }
  if (/\s/.test(word)) {
    toast('Copy a single word to look it up.');
    return;
  }

  pendingSelectionCfi = null;
  pendingSelectionText = word;
  pendingSelectionContext = await pdfWordSentenceContext(word);

  hideDictPopover();
  hideFootnotePopover();
  const currentId = ++dictionaryLookupId;

  // No selection rect to anchor to (see above) — center the popover under
  // the button that triggered it instead.
  const btnRect = el.pdfDictBtn.getBoundingClientRect();
  lookupWord(word, btnRect.left + btnRect.width / 2, btnRect.bottom + 10, currentId);
}

// Plain-text counterpart of extractSentenceContext (which needs a DOM
// Range) — PDF has no DOM to range over, only the page text pdf.js already
// extracted for chat (see getPdfPageText). Finds the word's first
// case-insensitive occurrence on the current page and returns the sentence
// around it, so the AI "explain in context" button has something to work
// with. Falls back to '' (context-free explain) if the word isn't found on
// this page — e.g. the user copied it, then turned the page before clicking
// the lookup button.
async function pdfWordSentenceContext(word: string): Promise<string> {
  const pageText = await getPdfPageText(currentPdfPage);
  const idx = pageText.toLowerCase().indexOf(word.toLowerCase());
  if (idx === -1) return '';

  let start = idx;
  while (start > 0 && !/[.!?…]/.test(pageText[start - 1])) start--;
  while (start < pageText.length && /[\s"'`«»‹›]/.test(pageText[start])) start++;

  let end = idx + word.length;
  while (end < pageText.length && !/[.!?…]/.test(pageText[end])) end++;
  if (end < pageText.length) end++; // include the terminator

  return pageText.slice(start, end).trim();
}

// Anchor point (viewport coords, above the selection) the dict popover was
// last opened at. Stashed so repositionDictPopover() can re-clamp after the
// popover's own content changes size (the "Explain in context" button and
// AI output appear later, asynchronously, after the popover is first shown).
let dictAnchorX = 0;
let dictAnchorY = 0;

function showDictPopover(pageX: number, pageY: number) {
  dictAnchorX = pageX;
  dictAnchorY = pageY;
  el.dictPopover.hidden = false;
  repositionDictPopover();
}

// Clamps the popover fully inside the viewport on every edge, not just the
// top-left. The original version only floored `top` at 8px — on a short
// window (or a word selected low in the Markdown reader's long scrolling
// page, which — unlike EPUB's padded, paginated columns — can put a
// selection anywhere including near the bottom edge) the popover could be
// positioned with its bottom, including the "Explain in context" button,
// past `window.innerHeight`: invisible/unreachable, which looks exactly
// like the button "not working". Also re-run this after the popover's
// content grows (AI button appearing, AI answer streaming in) since its
// rendered height at those points is larger than when first opened.
function repositionDictPopover() {
  const p = el.dictPopover;
  if (p.hidden) return;
  const w = p.offsetWidth || 300;
  const h = p.offsetHeight || 200;

  const left = Math.max(8, Math.min(window.innerWidth - w - 8, dictAnchorX - w / 2));

  // Prefer above the selection (matches the original behavior). If it
  // doesn't fit above, flip to below the selection instead of just clamping
  // to the top edge and hoping the content fits — that's what let the AI
  // button end up hidden below the fold.
  let top = dictAnchorY - h - 50;
  if (top < 8) top = dictAnchorY + 60;
  top = Math.max(8, Math.min(window.innerHeight - h - 8, top));

  p.style.left = `${left}px`;
  p.style.top = `${top}px`;
}

function hideDictPopover() {
  el.dictPopover.hidden = true;
  dictionaryLookupId++;              // any in-flight lookup becomes stale
  dictAbortController?.abort();      // cancel network work too
  dictAbortController = null;
  dictAi.reset();
  el.dictPronounceBtn.hidden = true;
  el.dictVocabBtn.hidden = true;
  pendingVocabCandidate = null;
  stopPronounce();
}

/* ------------------------------------------------------------------
   Smart AI — "Explain in context" / "Try again" / usage examples via the
   local LLM. Two surfaces use this: the dictionary popover (opened from an
   in-text word lookup) and the vocab review card (opened once a saved
   word's definition is revealed during spaced-repetition review). Both
   drive the same llm_explain / llm_word_examples commands with identical
   busy/staleness/timeout handling, so it's one controller factory
   instantiated per surface rather than duplicated per call site.

   When a definition is shown and a local model is installed, we offer a
   button that asks the model to explain the word *as used in this sentence*.
   This picks up idioms, disambiguates senses, and even helps for words the
   Free Dictionary API couldn't find. Entirely offline.
   ------------------------------------------------------------------ */
interface AiExplainElements {
  btn: HTMLButtonElement;
  output: HTMLDivElement;
  actions: HTMLDivElement;
  retryBtn: HTMLButtonElement;
  examplesBtn: HTMLButtonElement;
  examplesOutput: HTMLDivElement;
  // Popover surfaces need re-clamping as their content grows; the vocab
  // review card is a fixed-position modal and doesn't need this.
  onLayoutChange?: () => void;
}

interface AiExplainController {
  prepare(word: string, sentence: string): void;
  reset(): void;
  explain(): Promise<void>;
  examples(): Promise<void>;
}

// Rejects with `message` if `promise` hasn't settled within `ms`. The
// underlying Tauri invoke() has no cancellation, so a hung `llama-cli`
// subprocess (e.g. CPU-starved while the whole app is minimized/throttled
// by the OS) would otherwise leave the controller's in-flight flag stuck
// true forever — its own guard clause would then permanently no-op every
// future click, which looks exactly like "the button doesn't work". This
// guarantees the UI always recovers within `ms` regardless of backend state.
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

function createAiExplainController(els: AiExplainElements): AiExplainController {
  let word = '';
  let sentence = '';
  let explainInFlight = false;
  let examplesInFlight = false;

  // Called right after a lookup/reveal shows this surface. Decides whether
  // to offer the AI button and stashes the word + its sentence for the
  // click handlers.
  function prepare(w: string, s: string) {
    word = w;
    sentence = s;
    // A fresh word abandons any prior in-flight run (its response is now
    // stale and its finally-block will no-op on the word mismatch), so
    // clear the flags here — otherwise the buttons could stay wedged as
    // "in flight".
    explainInFlight = false;
    examplesInFlight = false;
    els.output.hidden = true;
    els.output.textContent = '';
    // Only offer the button when a model is actually installed and we have
    // a real word — otherwise the click would just error.
    const offer = isLlmReady() && !!w && w.trim().length > 0;
    els.btn.hidden = !offer;
    els.btn.disabled = false;
    els.btn.classList.remove('is-busy');
    // Retry + usage-examples only appear once the first explanation lands.
    els.actions.hidden = true;
    els.retryBtn.disabled = false;
    els.retryBtn.classList.remove('is-busy');
    els.examplesBtn.disabled = false;
    els.examplesBtn.classList.remove('is-busy');
    els.examplesOutput.hidden = true;
    els.examplesOutput.textContent = '';
    // The AI button showing/hiding changes the popover's rendered height —
    // re-clamp so it (and the button) stay fully on-screen.
    els.onLayoutChange?.();
  }

  function reset() {
    explainInFlight = false;
    examplesInFlight = false;
    els.btn.hidden = true;
    els.btn.disabled = false;
    els.btn.classList.remove('is-busy');
    els.actions.hidden = true;
    els.retryBtn.disabled = false;
    els.retryBtn.classList.remove('is-busy');
    els.examplesBtn.disabled = false;
    els.examplesBtn.classList.remove('is-busy');
    els.examplesOutput.hidden = true;
    els.examplesOutput.textContent = '';
    els.output.hidden = true;
    els.output.textContent = '';
  }

  async function explain() {
    if (explainInFlight || !isLlmReady() || !word) return;
    const model = currentLlmModel()!;

    explainInFlight = true;
    els.btn.disabled = true;
    els.btn.classList.add('is-busy');
    // While a run is in flight, keep the retry pill visible but spinning +
    // disabled so a regenerate can't stack a second request.
    els.retryBtn.disabled = true;
    els.retryBtn.classList.add('is-busy');
    els.output.hidden = false;
    els.output.textContent = 'Thinking…';
    // The output area just appeared, growing the surface — re-clamp.
    els.onLayoutChange?.();

    const w = word;
    const s = sentence;
    try {
      const answer = await withTimeout(
        invoke<string>('llm_explain', { word: w, sentence: s, modelPath: model.path }),
        60_000,
        'Timed out waiting for the local model — it may have stalled while the app was minimized. Try again.'
      );
      // Guard against a stale response after the user moved on to another word.
      if (word !== w) return;
      els.output.innerHTML = renderAiMarkdown(answer);   // sanitized — see renderAiMarkdown
    } catch (err) {
      if (word !== w) return;
      console.error('llm_explain failed:', err);
      els.output.textContent = `Couldn't run the local model: ${String(err)}`;
    } finally {
      if (word === w) {
        explainInFlight = false;
        els.btn.disabled = false;
        els.btn.classList.remove('is-busy');
        // The first-run button is done; swap in the retry + usage-examples
        // icons. The model is non-deterministic, so a second explain pass
        // yields a fresh explanation for the same word + sentence (like
        // ChatGPT's regenerate).
        els.btn.hidden = true;
        els.actions.hidden = false;
        els.retryBtn.disabled = false;
        els.retryBtn.classList.remove('is-busy');
        // The final answer/error text is in and the button row swapped —
        // the surface's final height is now settled, so re-clamp once more.
        els.onLayoutChange?.();
      }
    }
  }

  // "Show other example usages" — asks the local model for a few sentences
  // using the current word in senses/contexts other than the one the reader
  // is currently looking at. Shares the same word/sentence bookkeeping as
  // explain() (word doubles as the staleness guard for both), since this
  // button only ever appears for the word that's currently explained.
  async function examples() {
    if (examplesInFlight || !isLlmReady() || !word) return;
    const model = currentLlmModel()!;

    examplesInFlight = true;
    els.examplesBtn.disabled = true;
    els.examplesBtn.classList.add('is-busy');
    els.examplesOutput.hidden = false;
    els.examplesOutput.textContent = 'Finding other examples…';
    els.onLayoutChange?.();

    const w = word;
    const s = sentence;
    try {
      const answer = await withTimeout(
        invoke<string>('llm_word_examples', { word: w, sentence: s, modelPath: model.path }),
        60_000,
        'Timed out waiting for the local model — it may have stalled while the app was minimized. Try again.'
      );
      if (word !== w) return;
      els.examplesOutput.innerHTML = renderAiMarkdown(answer);
    } catch (err) {
      if (word !== w) return;
      console.error('llm_word_examples failed:', err);
      els.examplesOutput.textContent = `Couldn't run the local model: ${String(err)}`;
    } finally {
      if (word === w) {
        examplesInFlight = false;
        els.examplesBtn.disabled = false;
        els.examplesBtn.classList.remove('is-busy');
        els.onLayoutChange?.();
      }
    }
  }

  return { prepare, reset, explain, examples };
}

const dictAi = createAiExplainController({
  btn: el.dictAiBtn,
  output: el.dictAiOutput,
  actions: el.dictAiActions,
  retryBtn: el.dictAiRetry,
  examplesBtn: el.dictAiExamplesBtn,
  examplesOutput: el.dictAiExamplesOutput,
  onLayoutChange: () => repositionDictPopover(),
});

const vocabAi = createAiExplainController({
  btn: el.vocabAiBtn,
  output: el.vocabAiOutput,
  actions: el.vocabAiActions,
  retryBtn: el.vocabAiRetry,
  examplesBtn: el.vocabAiExamplesBtn,
  examplesOutput: el.vocabAiExamplesOutput,
});

/* ------------------------------------------------------------------
   Chat — free-form Q&A about the current page/chapter via the local LLM.

   Unlike dictAi/vocabAi above (one word/sentence pair, one request), this
   is a genuine multi-turn conversation. But llama-cli has no persistent-
   conversation mode the way we invoke it (see llm_chat_reply on the Rust
   side) — every call is a fresh process, so "chat" means resending a capped
   slice of prior turns as plain text alongside the passage on every send.
   That keeps the whole thing inside the shared 4096-token context, which is
   also why the passage is scoped to the visible page by default rather than
   the whole chapter (a chapter routinely doesn't fit; a screen always does).
   ------------------------------------------------------------------ */
interface ChatMessage { role: 'user' | 'assistant'; content: string; }
let chatHistory: ChatMessage[] = [];
let chatScope: 'page' | 'chapter' = 'page';
let chatInFlight = false;
// Resent as context on every send (capped independently of the full,
// unbounded chatHistory kept for on-screen scrollback) — keeps the prompt
// from growing without bound turn after turn.
const CHAT_HISTORY_MAX_TURNS = 3;
// Chapter scope gets a hard word budget; page scope is naturally small
// (one screen) and never needs it.
const CHAT_CHAPTER_WORD_BUDGET = 1800;

// Extracts the text to answer against. Always recomputed fresh right before
// a send (never cached at modal-open time) — if the reader turns a page
// mid-conversation, the next answer simply reflects what's on screen now,
// same as a person looking over your shoulder would. `focusWords` is the
// same word-token array TTS/focus-mode/chapter-caching already build via
// collectFocusWords(); classifyWord() is the same visible/before/after
// classifier focus mode uses to know when to turn a page.
async function currentChatPassage(scope: 'page' | 'chapter'): Promise<{ text: string; truncated: boolean }> {
  if (activeFormat === 'pdf') {
    if (!currentPdfDoc) return { text: '', truncated: false };
    if (scope === 'page') {
      return { text: await getPdfPageText(currentPdfPage), truncated: false };
    }
    // No epub-style "chapter" to bound chapter scope by, so it's approximated
    // as however many pages starting at the current one fit the same word
    // budget epub/text chapter scope uses.
    const words: string[] = [];
    let truncated = false;
    for (let p = currentPdfPage; p <= pdfTotalPages; p++) {
      const pageWords = (await getPdfPageText(p)).split(/\s+/).filter(Boolean);
      if (words.length + pageWords.length > CHAT_CHAPTER_WORD_BUDGET) {
        words.push(...pageWords.slice(0, CHAT_CHAPTER_WORD_BUDGET - words.length));
        truncated = true;
        break;
      }
      words.push(...pageWords);
    }
    return { text: words.join(' '), truncated };
  }

  if (!currentRendition && !currentTextElement) return { text: '', truncated: false };
  collectFocusWords();

  if (scope === 'page') {
    const words: string[] = [];
    for (const fw of focusWords) {
      if (classifyWord(fw).pos !== 'visible') continue;
      const text = (fw.node.textContent || '').slice(fw.start, fw.end).trim();
      if (text) words.push(text);
    }
    return { text: words.join(' '), truncated: false };
  }

  const { texts } = collectSectionSentences();
  const words = texts.join(' ').split(/\s+/).filter(Boolean);
  const truncated = words.length > CHAT_CHAPTER_WORD_BUDGET;
  return { text: words.slice(0, CHAT_CHAPTER_WORD_BUDGET).join(' '), truncated };
}

function renderChatMessages(): void {
  if (chatHistory.length === 0) {
    el.chatMessages.innerHTML = '<div class="chat-empty">Ask a question about what you\'re reading — it can see whatever\'s on screen (or the chapter, if you switch scope above).</div>';
    return;
  }
  el.chatMessages.innerHTML = '';
  for (const m of chatHistory) {
    const div = document.createElement('div');
    div.className = `chat-msg ${m.role}`;
    if (m.role === 'assistant') div.innerHTML = renderAiMarkdown(m.content);
    else div.textContent = m.content;
    el.chatMessages.appendChild(div);
  }
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
}

function openChat(): void {
  if (!currentRendition && !currentTextElement && !currentPdfDoc) { toast('Open a book first'); return; }
  if (!isLlmReady()) { toast('Set up a local LLM to chat (see TTS/AI setup)'); return; }
  el.chatModal.hidden = false;
  renderLlmModelSelect();
  renderChatMessages();
  el.chatInput.focus();
}

function closeChat(): void {
  el.chatModal.hidden = true;
}

function resetChat(): void {
  chatHistory = [];
  el.chatTruncatedNote.hidden = true;
  renderChatMessages();
}

async function sendChatMessage(): Promise<void> {
  if (chatInFlight || !isLlmReady()) return;
  const question = el.chatInput.value.trim();
  if (!question) return;
  const model = currentLlmModel()!;

  chatHistory.push({ role: 'user', content: question });
  el.chatInput.value = '';
  el.chatInput.style.height = 'auto';
  renderChatMessages();

  chatInFlight = true;
  el.chatInput.disabled = true;
  el.chatSendBtn.disabled = true;

  // Placeholder bubble while the model thinks — replaced in place below
  // rather than re-pushed onto chatHistory, so a failure doesn't leave a
  // bogus assistant turn in the resent-history slice.
  const placeholder = document.createElement('div');
  placeholder.className = 'chat-msg assistant is-busy';
  placeholder.textContent = 'Thinking…';
  el.chatMessages.appendChild(placeholder);
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;

  const { text: passage, truncated } = await currentChatPassage(chatScope);
  el.chatTruncatedNote.hidden = !truncated;
  if (truncated) {
    el.chatTruncatedNote.textContent = `Using the first ~${CHAT_CHAPTER_WORD_BUDGET} words of this chapter.`;
  }

  if (!passage) {
    placeholder.className = 'chat-msg assistant is-error';
    placeholder.textContent = "Couldn't find any text to answer against — try scrolling to a page with content.";
    chatInFlight = false;
    el.chatInput.disabled = false;
    el.chatSendBtn.disabled = false;
    return;
  }

  // Everything except the user turn just pushed, capped to the last few
  // exchanges — chatHistory itself stays unbounded for on-screen scrollback.
  const historyForPrompt = chatHistory.slice(0, -1).slice(-CHAT_HISTORY_MAX_TURNS * 2);

  try {
    const answer = await withTimeout(
      invoke<string>('llm_chat_reply', {
        passage,
        history: historyForPrompt,
        question,
        modelPath: model.path,
      }),
      // Larger prompts (page/chapter text + history) take longer to evaluate
      // on CPU before generation even starts — more headroom than the 60s
      // used for single-word explain.
      90_000,
      'Timed out waiting for the local model — it may have stalled while the app was minimized. Try again.'
    );
    chatHistory.push({ role: 'assistant', content: answer });
    renderChatMessages();
  } catch (err) {
    console.error('llm_chat_reply failed:', err);
    placeholder.className = 'chat-msg assistant is-error';
    placeholder.textContent = `Couldn't run the local model: ${String(err)}`;
  } finally {
    chatInFlight = false;
    el.chatInput.disabled = false;
    el.chatSendBtn.disabled = false;
    el.chatInput.focus();
  }
}

/* ------------------------------------------------------------------
   Pronounce — plays a single word through the local Piper voice model.
   Shared by the dictionary popover (word lookup) and the vocab review
   card, same reasoning as the AI controller above: identical synth +
   playback + busy-state handling, two call sites.

   Reuses `piper_synthesize` (already used for read-aloud chunks) rather
   than any new backend command — a single word is just a very short chunk.
   Length scale is pinned to 1.0 regardless of the reader's TTS speed
   setting, since a pronunciation check should sound natural, not sped up.
   ------------------------------------------------------------------ */
let pronounceAudio: HTMLAudioElement | null = null;
let pronounceAudioUrl: string | null = null;
let pronounceInFlight = false;

function stopPronounce(): void {
  if (pronounceAudio) {
    pronounceAudio.pause();
    pronounceAudio = null;
  }
  if (pronounceAudioUrl) {
    URL.revokeObjectURL(pronounceAudioUrl);
    pronounceAudioUrl = null;
  }
}

// Shows/hides a pronounce button for `word`, mirroring how prepareAiExplain
// gates the AI button on isLlmReady(). Call whenever the surface starts
// showing a new word; also stops any pronunciation still playing for the
// previous word.
function preparePronounceBtn(btn: HTMLButtonElement, word: string): void {
  stopPronounce();
  const offer = canPronounceNeural() && !!word && word.trim().length > 0;
  btn.hidden = !offer;
  btn.disabled = false;
  btn.classList.remove('is-busy');
  btn.dataset.word = word;
}

async function pronounceWord(word: string, btn: HTMLButtonElement): Promise<void> {
  const text = word.trim();
  const useVoca = ttsSettings.engine === 'voca';
  if (!text || pronounceInFlight || (!useVoca && !ttsSettings.piperVoicePath)) return;

  stopPronounce();
  pronounceInFlight = true;
  btn.disabled = true;
  btn.classList.add('is-busy');

  try {
    let wavBytes: Uint8Array;
    if (useVoca) {
      wavBytes = await vocaSynthesize(text, ttsSettings.vocaVoice, 1);
    } else {
      const result = await invoke<number[] | Uint8Array>('piper_synthesize', {
        text,
        voicePath: ttsSettings.piperVoicePath,
        lengthScale: 1.0,
      });
      wavBytes = result instanceof Uint8Array ? result : new Uint8Array(result);
    }
    const blob = new Blob([wavBytes.buffer as ArrayBuffer], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    pronounceAudio = audio;
    pronounceAudioUrl = url;
    audio.addEventListener('ended', () => {
      if (pronounceAudioUrl === url) { URL.revokeObjectURL(url); pronounceAudioUrl = null; }
      if (pronounceAudio === audio) pronounceAudio = null;
    });
    await audio.play();
  } catch (err) {
    console.error('pronounce failed:', err);
    toast(`Couldn't pronounce "${text}": ${String(err)}`);
  } finally {
    pronounceInFlight = false;
    btn.disabled = false;
    btn.classList.remove('is-busy');
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
  save(KEY_MARKS(currentBookRecord.id), currentMarks); refreshPageStrip();
  hideSelectionPopover();
  toast('Highlighted');
}

function removePendingHighlight() {
  if (!currentRendition || !currentBookRecord || !pendingSelectionCfi) return;
  try { currentRendition.annotations.remove(pendingSelectionCfi, 'highlight'); } catch {}
  currentMarks.highlights = currentMarks.highlights.filter(h => h.cfi !== pendingSelectionCfi);
  save(KEY_MARKS(currentBookRecord.id), currentMarks); refreshPageStrip();
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
let returnCfi: string | null = null;
let returnPillTimer: number | undefined;

function showReturnPill(cfi: string) {
  returnCfi = cfi;
  el.returnPill.hidden = false;
  clearTimeout(returnPillTimer);
  // Long enough to read the linked passage; it goes once it's no longer useful.
  returnPillTimer = window.setTimeout(hideReturnPill, 90_000);
}

function hideReturnPill() {
  returnCfi = null;
  el.returnPill.hidden = true;
  clearTimeout(returnPillTimer);
}

async function showFootnote(href: string, clientX: number, clientY: number, sourceDoc?: Document) {
  if (!currentBook) return;
  try {
    const [path, id] = href.split('#');
    // "#n1" points into the chapter being read; anything else names a file.
    const doc = !path && sourceDoc ? sourceDoc : await currentBook.load(path) as Document;
    const target = id ? doc.getElementById(id) : doc.body;
    if (target) {
      el.footnoteContent.innerHTML = target.innerHTML;
      const p = el.footnotePopover;
      p.hidden = false;
      // With room to the right of the text column, the note sits in the margin
      // beside the line it belongs to instead of covering the page.
      const col = readingColumnRect();
      const roomRight = col ? window.innerWidth - col.right : 0;
      const docked = !!col && settings.layout !== 'spread' && roomRight >= 300;
      p.classList.toggle('is-margin', docked);
      const w = docked ? 268 : 320;
      const h = p.offsetHeight || 200;
      if (docked && col) {
        p.style.left = `${Math.min(window.innerWidth - w - 16, col.right + 16)}px`;
        p.style.top  = `${Math.max(8, Math.min(window.innerHeight - h - 8, clientY - 24))}px`;
      } else {
        p.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, clientX - w / 2))}px`;
        p.style.top  = `${Math.max(8, clientY - h - 20)}px`;
      }
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
  if (el.sidebarStreakTitle) {
    el.sidebarStreakTitle.textContent = `${stats.streakDays}-day streak`;
  }
  if (el.sidebarStreakToday) {
    el.sidebarStreakToday.textContent = `${stats.todayMins} min today`;
  }
  renderStreakWeek();
}

// The persisted stats only store a running day-count, not a history. Render a
// seven-day glance where the trailing `streakDays` columns are filled and
// today is emphasised when any reading happened.
function renderStreakWeek(): void {
  if (!el.sidebarStreakWeek) return;
  const labels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const today = new Date();
  const streak = Math.max(0, Math.min(stats.streakDays, 7));
  el.sidebarStreakWeek.innerHTML = '';

  for (let offset = 6; offset >= 0; offset--) {
    const date = new Date(today);
    date.setDate(today.getDate() - offset);
    const isToday = offset === 0;
    const filled = isToday ? stats.todayMins > 0 : offset < streak;

    const day = document.createElement('div');
    day.className = 'streak-day' + (filled ? ' is-filled' : '') + (isToday ? ' is-today' : '');

    const bar = document.createElement('span');
    bar.className = 'streak-bar';

    const label = document.createElement('span');
    label.className = 'streak-day-label';
    label.textContent = labels[date.getDay()];

    day.appendChild(bar);
    day.appendChild(label);
    el.sidebarStreakWeek.appendChild(day);
  }
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

type VocabCandidate = { display: string; definitionHtml: string; phonetic?: string; context?: string };

// The word currently shown in the meaning popover. Looking a word up no
// longer saves it — the user opts in with the popover's "Add to vocabulary"
// button, which saves this candidate.
let pendingVocabCandidate: VocabCandidate | null = null;

function offerVocabEntry(entry: { display: string; definitionHtml: string; phonetic?: string }) {
  // Capture the sentence now: the module-level context can change before the click.
  pendingVocabCandidate = { ...entry, context: pendingSelectionContext };
  el.dictVocabBtn.hidden = !currentBookRecord;
  syncVocabBtn();
}

function isWordInVocab(display: string): boolean {
  const canonical = display.trim().toLowerCase();
  return currentVocab.words.some(w => w.word === canonical);
}

function syncVocabBtn() {
  const cand = pendingVocabCandidate;
  const saved = !!cand && isWordInVocab(cand.display);
  el.dictVocabBtn.classList.toggle('is-saved', saved);
  el.dictVocabBtn.title = saved ? 'In your vocabulary — click to remove' : 'Save this word for review';
  el.dictVocabLabel.textContent = saved ? 'In vocabulary' : 'Add to vocabulary';
  repositionDictPopover();
}

function toggleVocabCandidate() {
  const cand = pendingVocabCandidate;
  if (!cand) return;
  if (isWordInVocab(cand.display)) {
    removeVocabEntry(cand.display.trim().toLowerCase());
    toast(`Removed "${cand.display}" from vocabulary`);
  } else {
    saveVocabEntry(cand);
  }
  syncVocabBtn();
}

function saveVocabEntry(entry: VocabCandidate) {
  if (!currentBookRecord) return;
  const canonical = entry.display.trim().toLowerCase();
  if (!canonical) return;

  // The sentence containing the word — grabbed by onSelected before the
  // async dictionary lookup fired. May be empty if the user triggered the
  // save through some other path (long-press without selection etc.).
  const context = entry.context ?? pendingSelectionContext;

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

// Delete a review card's word from its source book's journal entirely —
// the review-modal counterpart to removeVocabEntry(), which only ever
// operates on the currently-open book's journal (currentVocab). A
// cross-book "Review all" session can show a card from a book that isn't
// open, so deletion needs the same same-book/other-book branch as
// persistCrossBookUpdate above.
function deleteCrossBookVocabWord(card: CrossBookVocabWord): void {
  if (currentBookRecord && card.bookId === currentBookRecord.id) {
    currentVocab.words = currentVocab.words.filter(w => w.word !== card.word);
    persistVocab();
    refreshVocabPanelIfOpen();
    scheduleVocabHighlightRefresh();
    return;
  }
  const journal = loadVocab(card.bookId);
  journal.words = journal.words.filter(w => w.word !== card.word);
  save(KEY_VOCAB(card.bookId), journal);
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
    el.vocabList.innerHTML = '<div class="mark-empty">No vocabulary yet.<br>Look up a word while reading, then tap “Add to vocabulary”.</div>';
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
  vocabAi.reset();
  stopPronounce();
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
  el.vocabSkipBtn.disabled = true;
  el.vocabDeleteBtn.disabled = true;
  el.vocabPronounceBtn.hidden = true;
  vocabAi.reset();
  stopPronounce();
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
  // Stashes word + context for the AI buttons living inside vocab-card-back;
  // they only become reachable once revealReviewCard() unhides that panel.
  vocabAi.prepare(w.displayWord, w.context || '');
  // Pronounce is on the card front, so available immediately — no need to
  // reveal the definition first to hear the word.
  preparePronounceBtn(el.vocabPronounceBtn, w.displayWord);

  el.vocabRevealActions.hidden = false;
  el.vocabRateActions.hidden = true;
  el.vocabSkipBtn.disabled = false;
  el.vocabDeleteBtn.disabled = false;

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

// "Skip" — move past this card without rating it, so its SM-2 schedule is
// left untouched (it stays due and will show up again next session) rather
// than being penalized or promoted. Doesn't count toward reviewSessionDone
// or the daily new-card cap since nothing was actually reviewed.
function skipReviewCard() {
  const w = reviewQueue[reviewIdx];
  if (!w) return;
  reviewIdx++;
  if (reviewIdx >= reviewQueue.length) {
    showReviewEmpty();
    el.vocabReviewProgress.textContent = `Session done — ${reviewSessionDone} card${reviewSessionDone === 1 ? '' : 's'}`;
    return;
  }
  showReviewCard();
}

// "Remove" — delete this word from vocabulary entirely (not just skip it).
// Works the same whether the card came from the currently-open book or a
// different one in a cross-book "Review all" session, since
// deleteCrossBookVocabWord branches on that internally.
function removeCurrentReviewCard() {
  const w = reviewQueue[reviewIdx];
  if (!w) return;
  deleteCrossBookVocabWord(w);
  reviewQueue.splice(reviewIdx, 1);   // next card lands at the same index
  toast(`Removed "${w.displayWord}" from vocabulary`);
  refreshLibraryVocabButton();

  if (reviewIdx >= reviewQueue.length) {
    showReviewEmpty();
    el.vocabReviewProgress.textContent = reviewSessionDone === 0
      ? 'Nothing due right now'
      : `Session done — ${reviewSessionDone} card${reviewSessionDone === 1 ? '' : 's'}`;
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
  const rect = el.progressTrack.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

  if (activeFormat === 'pdf') {
    // Inverse of updatePdfProgressUi's pct formula: (page-1)/(total-1).
    if (!pdfTotalPages) return;
    navigateToPdfPage(Math.round(pct * (pdfTotalPages - 1)) + 1);
    return;
  }
  if (currentTextElement) {
    const totalScroll = currentTextElement.scrollHeight - currentTextElement.clientHeight;
    if (totalScroll > 0) currentTextElement.scrollTop = pct * totalScroll;
    return;
  }
  if (!currentBook || !currentRendition) return;
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
  // Hover tracker overlay lives inside each epub iframe; find and repaint.
  const iframes = el.viewer?.querySelectorAll('iframe');
  iframes?.forEach((raw) => {
    const doc = (raw as HTMLIFrameElement).contentDocument;
    const trackerOverlay = doc?.querySelector('[data-focus-overlay]') as HTMLDivElement | null;
    if (trackerOverlay) trackerOverlay.style.background = `rgba(${rgb}, 0.18)`;
  });
  // The text/md reader's tracker overlay lives directly on the main document
  // (installFocusTracker(document, null) in boot()) rather than in an iframe.
  const mainTrackerOverlay = document.querySelector('[data-focus-overlay]') as HTMLDivElement | null;
  if (mainTrackerOverlay) mainTrackerOverlay.style.background = `rgba(${rgb}, 0.18)`;
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
// Timestamp of the last standalone 'g' press, for detecting the vim "gg"
// (go to start) chord — a second 'g' within the window counts as the pair.
let lastGKeydownAt = 0;
const GG_CHORD_WINDOW_MS = 500;

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
  if (activeFormat === 'pdf') {
    navigateToPdfPage(currentPdfPage + (dir === 'prev' ? -1 : 1));
    return;
  }
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

// Vim-style h/j/k/l page stepping. epub already has navGo(); text/md books
// have no scroll-stepping equivalent (Space/PageUp/PageDown page them via
// native browser scrolling instead), so this adds a matching one-viewport
// scroll step for those formats.
function vimPageNav(dir: 'prev' | 'next'): void {
  if (currentRendition) { navGo(dir); return; }
  if (currentTextElement) {
    const box = currentTextElement;
    box.scrollTop += (dir === 'next' ? 1 : -1) * box.clientHeight * 0.9;
  }
}

// Vim-style gg/G jump to the start/end of the book.
async function vimGoToStart(): Promise<void> {
  if (currentRendition && currentBook) {
    const first = (currentBook.spine as any).first();
    if (first?.href) await currentRendition.display(first.href).catch(() => {});
  } else if (currentTextElement) {
    currentTextElement.scrollTop = 0;
  }
}

async function vimGoToEnd(): Promise<void> {
  if (currentRendition && currentBook) {
    const last = (currentBook.spine as any).last();
    if (last?.href) await currentRendition.display(last.href).catch(() => {});
  } else if (currentTextElement) {
    currentTextElement.scrollTop = currentTextElement.scrollHeight;
  }
}

// Shared by both content sources RSVP/TTS can read from: an epub section's
// iframe body, or (for text/md) the live .text-reader-container in the main
// document. `root` is the tree-walk root; `doc` owns range/style creation.
// Footnote / endnote reference marks ("1", "*", "†" in a <sup> or a noteref
// link) are navigation, not prose.
function isNoteRefNode(el: Element): boolean {
  let n: Element | null = el;
  for (let i = 0; n && i < 3; i++, n = n.parentElement) {
    const t = (n.getAttribute('epub:type') || '') + ' ' + (n.getAttribute('role') || '');
    if (/noteref/.test(t)) return true;
    if (n.tagName === 'SUP' && /^[\s\d*†‡\[\]()]+$/.test(n.textContent || '')) return true;
  }
  return false;
}

function walkFocusWords(doc: Document, root: Node): FocusWord[] {
  const win = doc.defaultView;
  const words: FocusWord[] = [];
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent || !node.textContent.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript') return NodeFilter.FILTER_REJECT;
      // Code isn't read aloud / flashed in focus mode, and highlight spans would shred it into thousands of tokens.
      if (parent.closest('pre')) return NodeFilter.FILTER_REJECT;
      if (isNoteRefNode(parent)) return NodeFilter.FILTER_REJECT;
      const style = win?.getComputedStyle(parent);
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
      words.push({ node: node as Text, start: m.index, end: m.index + m[0].length });
    }
  }
  return words;
}

function collectFocusWords(): void {
  focusWords = [];
  focusOverlay = null;
  focusIframeDoc = null;

  // Text/md has no per-section iframe — its content is the live container
  // in the main document. Walking from it (rather than doc.body) means the
  // reader's own chrome (topbar, drawers, popovers) never gets swept in.
  if (currentTextElement) {
    focusIframeDoc = document;
    focusWords = walkFocusWords(document, currentTextElement);
    return;
  }

  const iframe = getVisibleIframe();
  if (!iframe || !iframe.contentDocument?.body) return;
  const doc = iframe.contentDocument;
  focusIframeDoc = doc;
  focusWords = walkFocusWords(doc, doc.body);
}

// Text/md documents render into `currentTextElement` (.text-reader-container),
// which scrolls internally (overflow-y:auto) while `document`/`body` never
// scroll (see html,body{overflow:hidden} in styles.css). An overlay appended
// to `doc.body` and positioned from `window.scrollX/Y` is anchored to the
// (static) page instead of that scrolling container, so it visibly detaches
// from the highlighted word the moment the container scrolls out from under
// it. Anchoring the overlay to the scrolling container itself — and
// expressing its position in that container's own content coordinates —
// makes it scroll natively with the text, same as epub's per-iframe overlays
// already do relative to their iframe document.
function overlayHostFor(doc: Document): HTMLElement {
  if (doc === document && currentTextElement) return currentTextElement;
  return doc.body;
}

// Companion to overlayHostFor: the (sx, sy) to add to a viewport-relative
// rect so the result is in overlayHostFor(doc)'s own content coordinate
// space, valid regardless of how the host has scrolled since.
function overlayOffset(doc: Document): { sx: number; sy: number } {
  if (doc === document && currentTextElement) {
    const hostRect = currentTextElement.getBoundingClientRect();
    return {
      sx: currentTextElement.scrollLeft - hostRect.left,
      sy: currentTextElement.scrollTop - hostRect.top,
    };
  }
  const win = doc.defaultView;
  return { sx: win?.scrollX || 0, sy: win?.scrollY || 0 };
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
  overlayHostFor(doc).appendChild(div);
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
  overlayHostFor(doc).appendChild(div);
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

  // Text/md is one continuous scrolling container (overflow-y:auto), not
  // epub's paginated columns — "visible" means inside that container's own
  // clipped box. Its content lives in the main document, so unlike the epub
  // iframe case below, `rect` is already in top-window coordinates — no
  // offset translation needed.
  if (currentTextElement) {
    const box = currentTextElement.getBoundingClientRect();
    if (rect.bottom <= box.top + 4) return { pos: 'before', range, rect };
    if (rect.top >= box.bottom - 4) return { pos: 'after', range, rect };
    return { pos: 'visible', range, rect };
  }

  const iframe = (focusIframeDoc.defaultView?.frameElement as HTMLIFrameElement | null) ?? getVisibleIframe();
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
// Block-level tags that end a "sentence" on their own even without trailing
// punctuation — a heading, list item, or table cell is never a run-on into
// whatever follows it just because it lacks a period. Markdown/web-article
// content is dense with these (headings, bullet lists) in a way prose-heavy
// EPUB chapters usually aren't, which is why a purely punctuation-based walk
// (the only check this function used to do) mostly got away with it in EPUB
// but visibly over-dims across whole sections of a Markdown/web article —
// every un-punctuated heading and list item got silently swallowed into one
// enormous "sentence".
const SENTENCE_BLOCK_TAGS = new Set([
  'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'TD', 'TH', 'PRE', 'FIGCAPTION', 'DT', 'DD',
]);

function sentenceBlockAncestor(node: Node): Element | null {
  let el = node.parentElement;
  while (el) {
    if (SENTENCE_BLOCK_TAGS.has(el.tagName)) return el;
    el = el.parentElement;
  }
  return null;
}

function sentenceRangeAround(wordIdx: number): [number, number] {
  if (wordIdx < 0 || wordIdx >= focusWords.length) return [-1, -1];

  const wordText = (fw: FocusWord) =>
    (fw.node.textContent || '').slice(fw.start, fw.end).trim();

  let start = wordIdx;
  while (start > 0) {
    if (endsSentence(wordText(focusWords[start - 1]), wordText(focusWords[start]))) break;
    if (sentenceBlockAncestor(focusWords[start - 1].node) !== sentenceBlockAncestor(focusWords[start].node)) break;
    start--;
  }
  let end = wordIdx;
  while (end < focusWords.length - 1) {
    if (endsSentence(wordText(focusWords[end]), wordText(focusWords[end + 1]))) break;
    if (sentenceBlockAncestor(focusWords[end].node) !== sentenceBlockAncestor(focusWords[end + 1].node)) break;
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
  const { sx, sy } = overlayOffset(focusIframeDoc);
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
  const { sx, sy } = overlayOffset(focusIframeDoc);

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
  if (advancingPage) return;

  // Text/md is one continuous scroll, not epub's discrete pages — "turning
  // the page" means scrolling the container to reveal more content. No
  // section swap ever happens, so unlike the epub path below we never need
  // to re-collect focusWords: the same live DOM nodes stay valid, we just
  // need one paint frame for their new on-screen position to register.
  if (currentTextElement) {
    if (!focusModeOn && !ttsOn) { cb(); return; }
    advancingPage = true;
    const box = currentTextElement;
    const before = box.scrollTop;
    const max = box.scrollHeight - box.clientHeight;
    box.scrollTop = Math.min(max, before + box.clientHeight * 0.85);
    await raf();
    advancingPage = false;
    if (!focusModeOn && !ttsOn) return;
    if (box.scrollTop <= before) {
      // Scroll position didn't move — genuinely nothing left below the fold.
      toast('End of book');
      if (focusModeOn) stopFocusMode();
      if (ttsOn) stopTts();
      return;
    }
    cb();
    return;
  }

  if (!currentRendition) { cb(); return; }
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
    if (!focusModeOn && !ttsOn) { advancingPage = false; return; }
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
  // Fixes a pre-existing gap while here: this function is also called from
  // TTS's page-turn paths (speakNextChunk/speakNextChunkPipelined), but the
  // callback used to only fire when RSVP focus mode was on — TTS and focus
  // mode are mutually exclusive, so TTS's own page turns across an epub
  // chapter boundary could never actually resume.
  if (focusModeOn || ttsOn) cb();
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
  if (!currentRendition && !currentTextElement) { toast('Open a book first'); return; }
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
type TtsEngine = 'system' | 'piper' | 'voca';

interface TtsSettings {
  engine: TtsEngine;
  rate: number;             // 0.5 – 2.0
  voiceUri: string;         // system engine: SpeechSynthesisVoice.voiceURI; '' = system default
  piperVoicePath: string;   // piper engine: absolute path to .onnx model
  vocaVoice: VocaVoice;     // Tiny Voca engine: F2 (female) or M2 (male)
  // Piper-only: when true, rate is achieved by piper's `--length-scale` at
  // synth time (natural pitch, requires re-synth on rate change) instead of
  // HTMLAudioElement.playbackRate (instant, but pitch-shifted — chipmunk
  // when fast, unnaturally deep when slow).
  piperNaturalRate: boolean;
  volume: number;           // 0 – 1
  pitch: number;            // 0.5 – 1.5 (system voices only; Piper has no pitch control)
  pauseScale: number;       // multiplier for heading / paragraph / sentence pauses
  expressiveness: number;   // Piper only: multiplier on the voice's noise-scale / noise-w (1 = voice default)
}

const DEFAULT_TTS: TtsSettings = {
  engine: 'system',
  rate: 1.0,
  voiceUri: '',
  piperVoicePath: '',
  vocaVoice: 'F2',
  piperNaturalRate: false,
  volume: 1,
  pitch: 1,
  pauseScale: 1,
  expressiveness: 1,
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

// Which installed .gguf to use — persisted across sessions, same pattern as
// ttsSettings.piperVoicePath. Before this existed, every AI feature just
// took llmStatus.models[0] (alphabetically-first file in the models
// folder), so a second installed model was silently never used.
const KEY_LLM_MODEL = 'read.llm.modelPath';
let llmModelPath: string = load<string>(KEY_LLM_MODEL, '');
const persistLlmModel = () => save(KEY_LLM_MODEL, llmModelPath);

// Resolves the persisted choice against what's actually installed, falling
// back to the first available model if the saved one was deleted/renamed
// (or nothing was ever chosen) — same fallback shape as the Piper voice
// picker's "saved voice no longer exists" handling.
function currentLlmModel(): LlmModel | null {
  if (!isLlmReady()) return null;
  const models = llmStatus!.models;
  return models.find(m => m.path === llmModelPath) || models[0];
}

// Populates the model picker in the chat modal header. Only called when the
// modal is about to be shown (openChat already guards on isLlmReady, so
// there's always at least one model by the time this runs) — no need for a
// live boot-time refresh the way refreshChatButtonVisibility needs one.
function renderLlmModelSelect(): void {
  el.chatModelSelect.innerHTML = '';
  if (!isLlmReady()) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No local model installed';
    opt.disabled = true;
    el.chatModelSelect.appendChild(opt);
    el.chatModelSelect.disabled = true;
    return;
  }
  el.chatModelSelect.disabled = false;
  const models = llmStatus!.models;
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.path;
    opt.textContent = `${m.name} (${fmtBytes(m.size_bytes)})`;
    if (m.path === llmModelPath) opt.selected = true;
    el.chatModelSelect.appendChild(opt);
  }
  // Saved choice no longer exists (deleted/renamed) — fall back to first,
  // same as the Piper voice select does.
  if (!models.some(m => m.path === llmModelPath)) {
    llmModelPath = models[0].path;
    persistLlmModel();
    el.chatModelSelect.value = llmModelPath;
  }
}

function isLlmReady(): boolean {
  return !!llmStatus && llmStatus.binary_exists && llmStatus.models.length > 0;
}

// The chat toolbar button is persistent chrome (not gated per-lookup like
// dictAiBtn/vocabAiBtn), so it needs its own visibility refresh whenever LLM
// readiness could have changed — after the boot-time probe resolves, and
// whenever a new book opens. Also stays hidden for PDF until the parallel
// pdf.js parse in openPdfReader resolves currentPdfDoc — otherwise the
// button would appear before there's any text to extract.
function refreshChatButtonVisibility(): void {
  const pdfNotReady = activeFormat === 'pdf' && !currentPdfDoc;
  el.chatBtn.hidden = !isLlmReady() || pdfNotReady;
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
const TRAILING_CLOSING_RE = /["'”’)\]}»›]+$/;
// Titles/abbreviations that are (almost) never the last word of a sentence.
const NON_TERMINAL_ABBREVS = new Set([
  'mr', 'mrs', 'ms', 'mx', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'vs', 'fig', 'figs', 'eq',
  'gen', 'col', 'capt', 'lt', 'sgt', 'rev', 'hon', 'gov', 'sen', 'rep', 'cf', 'pp', 'vol',
  'ave', 'blvd', 'rd', 'viz',
]);
const NEXT_STARTS_LOWER_RE = /^[("'“‘[]*[a-z]/;

// `next` is the following word, when known. A terminator followed by a
// lowercase word isn't a sentence end ("Dr. smith", "approx. five", and the
// dialogue tag in `"Why?" she asked`). Abbreviations ("Mr.", "e.g.", "J.")
// and mid-sentence ellipses don't end sentences either.
function endsSentence(text: string, next?: string): boolean {
  const t = text.replace(TRAILING_CLOSING_RE, '');
  if (!SENTENCE_END_RE.test(t)) return false;
  if (next && NEXT_STARTS_LOWER_RE.test(next)) return false;
  if (/[.]{2,}$|…$/.test(t) || !t.endsWith('.')) return true;   // ellipsis, ?, !
  const base = t.replace(/^[("'“‘[]+/, '').slice(0, -1);
  if (/^[A-Z]$/.test(base) && base !== 'I') return false;        // initials: "J. Smith"
  if (/^(?:[A-Za-z]{1,2}[.])+[A-Za-z]{1,2}$/.test(base)) {       // dotted acronyms
    return !/^(?:e[.]g|i[.]e|a[.]k[.]a|p[.]s)$/i.test(base);
  }
  return !NON_TERMINAL_ABBREVS.has(base.toLowerCase());
}

function isTtsOn(): boolean { return ttsOn; }
function isTtsSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

// Engines that produce audio files we play through <audio> (Piper, Tiny Voca),
// as opposed to the browser's own speechSynthesis.
function isAudioEngine(): boolean {
  return ttsSettings.engine === 'piper' || ttsSettings.engine === 'voca';
}

// Tiny Voca loads Python + the model on first use (a few seconds, once per
// launch). Show where it is in the listening bar, and say so once as a toast.
let vocaToldLoading = false;
setVocaProgressListener((stage, step, steps) => {
  el.ttsLoading.textContent = `Loading Tiny Voca · ${step}/${steps} · ${stage}…`;
  el.ttsLoading.hidden = false;
  if (!vocaToldLoading) { vocaToldLoading = true; toast('Preparing Tiny Voca — first start takes a few seconds'); }
});
// Called once the model is up (or failed): clears the indicator.
function vocaLoadFinished(): void { el.ttsLoading.hidden = true; el.ttsLoading.textContent = ''; }
setVocaReadyListener(vocaLoadFinished);   // covers every load path (play, pronounce, cache)
// True when the neural word-pronouncer should be used (Tiny Voca is chosen, or Piper is installed).
function canPronounceNeural(): boolean {
  return ttsSettings.engine === 'voca' || (isPiperReady() && !!ttsSettings.piperVoicePath);
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

  if (ttsSettings.engine === 'voca') {
    for (const v of VOCA_VOICES) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = v.label;
      if (v.id === ttsSettings.vocaVoice) opt.selected = true;
      el.ttsVoiceSelect.appendChild(opt);
    }
    return;
  }

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

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function updateEngineUi() {
  // iOS can't run the Piper helper process; offer System and Tiny Voca only.
  if (IS_IOS) {
    el.ttsEngineSelect.querySelector('option[value="piper"]')?.remove();
    if (ttsSettings.engine === 'piper') ttsSettings.engine = 'voca';
  }
  el.ttsEngineSelect.value = ttsSettings.engine;
  // Setup button and natural-rate toggle only make sense for Piper.
  el.ttsSetupBtn.hidden = ttsSettings.engine !== 'piper';
  el.ttsNaturalRateLabel.hidden = !isAudioEngine();
  el.ttsNaturalRate.checked = ttsSettings.piperNaturalRate;
  el.ttsPitchRow.hidden = isAudioEngine();
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
  if (!currentRendition && !currentTextElement) { toast('Open a book first'); return; }
  if (ttsSettings.engine === 'system' && !isTtsSupported()) {
    toast('Text-to-speech not supported'); return;
  }
  if (ttsSettings.engine === 'piper' && !isPiperReady()) {
    openPiperSetup();
    toast('Piper needs setup — see the panel');
    return;
  }
  if (ttsSettings.engine === 'voca' && !isVocaReady()) {
    // warm up while the first chunk queues
    void startVoca().then(vocaLoadFinished, (err) => { vocaLoadFinished(); toast(`Tiny Voca failed to load: ${err?.message || err}`); });
  }
  if (isFocusModeOn()) stopFocusMode();     // mutually exclusive

  ttsOn = true;
  ttsPaused = false;
  ttsUserScrolled = false;
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
  const engineLabel = ttsSettings.engine === 'piper' ? 'Piper' : ttsSettings.engine === 'voca' ? 'Tiny Voca' : 'System';
  toast(`Read aloud · ${engineLabel} · ${ttsSettings.rate.toFixed(1)}×`);
}

function stopTts(): void {
  clearTtsSleep();
  closeTtsTune();
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
  updateTtsPlayIcon();
  hideAllHighlights();
}

function pauseTts(): void {
  if (!ttsOn || ttsPaused) return;
  ttsPaused = true;
  if (cachedPlayback) {
    cachedPlayback.audio.pause();
  } else if (isAudioEngine()) {
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
  if (ttsGapHeld) {
    const held = ttsGapHeld;
    ttsGapHeld = null;
    updateTtsPlayIcon();
    held();
    return;
  }
  if (cachedPlayback) {
    cachedPlayback.audio.play()
      .then(() => startCachedPaintLoop())
      .catch(err => console.warn('resume cached:', err));
  } else if (isAudioEngine()) {
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
  // SVG elements have no .hidden property — toggle the attribute instead.
  const showPlay = !ttsOn || ttsPaused;
  el.ttsIconPlay.toggleAttribute("hidden", !showPlay);
  el.ttsIconPause.toggleAttribute("hidden", showPlay);
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

// [start, end] word indexes of the paragraph (block) containing idx.
function ttsParagraphRange(idx: number): [number, number] {
  const block = ttsBlockOf(focusWords[idx]);
  let s = idx;
  let e = idx;
  while (s > 0 && ttsBlockOf(focusWords[s - 1]) === block) s--;
  while (e < focusWords.length - 1 && ttsBlockOf(focusWords[e + 1]) === block) e++;
  return [s, e];
}

// Where a prev/next step lands. "Previous" first returns to the start of the
// current sentence/paragraph, like a media player's rewind-to-start.
function ttsStepTarget(delta: number, unit: 'sentence' | 'paragraph'): number {
  const last = focusWords.length - 1;
  const cur = Math.max(0, Math.min(last, focusIndex));
  const range = (i: number): [number, number] => unit === 'paragraph' ? ttsParagraphRange(i) : sentenceRangeAround(i);
  const [s, e] = range(cur);
  if (s < 0) return cur;
  if (delta > 0) return Math.min(last, e + 1);
  if (cur > s) return s;
  return s > 0 ? Math.max(0, range(s - 1)[0]) : 0;
}

function stepTts(delta: number, unit: 'word' | 'sentence' | 'paragraph' = 'sentence'): void {
  if (!ttsOn) return;
  const target = unit === 'word' ? focusIndex + delta : ttsStepTarget(delta, unit);
  focusIndex = Math.max(0, Math.min(focusWords.length - 1, target));
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
  ttsUserScrolled = false;           // they just pointed at it: they are looking at it
  cancelCurrentUtterance();
  ttsPaused = false;
  updateTtsPlayIcon();
  speakNextChunk();
}

function cancelCurrentUtterance(): void {
  clearTtsGap();
  try { speechSynthesis.cancel(); } catch {}
  stopPiperPlayback();
  stopCachedPlayback();
}

/* --- Extra speaking controls: volume, pitch, pauses, sleep timer ------- */
function describePauseScale(v: number): string {
  if (v <= 0.5) return 'Short';
  if (v < 1) return 'Brisk';
  if (v === 1) return 'Normal';
  if (v <= 1.5) return 'Relaxed';
  return 'Long';
}

const EXPRESSION_LABELS: [number, string][] = [[0.4, 'Flat'], [0.6, 'Steady'], [0.8, 'Calm'], [1, 'Natural'], [1.2, 'Lively'], [1.4, 'Expressive'], [1.6, 'Dramatic']];
function describeExpression(v: number): string {
  let best = EXPRESSION_LABELS[0];
  for (const e of EXPRESSION_LABELS) if (Math.abs(e[0] - v) < Math.abs(best[0] - v)) best = e;
  return best[1];
}

// Sent to Piper; null (= leave the voice alone) when at the default.
function currentExpressiveness(): number | null {
  const v = ttsSettings.expressiveness;
  return typeof v === 'number' && Math.abs(v - 1) > 0.01 ? v : null;
}

function syncTtsTuneUi(): void {
  el.ttsVolume.value = String(ttsSettings.volume);
  el.ttsVolumeLabel.textContent = `${Math.round(ttsSettings.volume * 100)}%`;
  el.ttsPitch.value = String(ttsSettings.pitch);
  el.ttsPitchLabel.textContent = ttsSettings.pitch.toFixed(2).replace(/0$/, '');
  el.ttsPauses.value = String(ttsSettings.pauseScale);
  el.ttsPausesLabel.textContent = describePauseScale(ttsSettings.pauseScale);
  el.ttsPitchRow.hidden = isAudioEngine();
  el.ttsExpr.value = String(ttsSettings.expressiveness ?? 1);
  el.ttsExprLabel.textContent = describeExpression(ttsSettings.expressiveness ?? 1);
  el.ttsExprRow.hidden = ttsSettings.engine !== 'piper';
}

function setTtsVolume(v: number, commit: boolean): void {
  ttsSettings.volume = Math.max(0, Math.min(1, v));
  persistTts();
  syncTtsTuneUi();
  // Piper audio elements take the new volume immediately.
  if (piperAudio) piperAudio.volume = ttsSettings.volume;
  if (piperPrefetched) piperPrefetched.audio.volume = ttsSettings.volume;
  if (cachedPlayback) cachedPlayback.audio.volume = ttsSettings.volume;
  // A system utterance bakes its volume in at speak() time: restart the
  // current chunk once the slider is released.
  if (commit && ttsOn && ttsSettings.engine === 'system' && !ttsPaused) {
    cancelCurrentUtterance();
    speakNextChunk();
  }
}

function setTtsPitch(v: number, commit: boolean): void {
  ttsSettings.pitch = Math.max(0.5, Math.min(1.5, v));
  persistTts();
  syncTtsTuneUi();
  if (commit && ttsOn && ttsSettings.engine === 'system' && !ttsPaused) {
    cancelCurrentUtterance();
    speakNextChunk();
  }
}

function setTtsPauseScale(v: number): void {
  ttsSettings.pauseScale = Math.max(0.25, Math.min(2, v));
  persistTts();
  syncTtsTuneUi();
  // Pauses are read when each chunk ends, so new values apply from the next
  // chunk on. Audio cached earlier keeps the pauses it was made with.
}

function setTtsExpressiveness(v: number): void {
  ttsSettings.expressiveness = Math.max(0.4, Math.min(1.6, v));
  persistTts();
  syncTtsTuneUi();
  // Applies to audio synthesized from now on (the chunk already prefetched,
  // and chapters cached earlier, keep the expression they were made with).
}

let ttsSleepTimer = 0;
function clearTtsSleep(): void {
  if (ttsSleepTimer) { clearTimeout(ttsSleepTimer); ttsSleepTimer = 0; }
  el.ttsSleep.value = '0';
  el.ttsTuneBtn.classList.remove('active');
}
function setTtsSleep(minutes: number): void {
  if (ttsSleepTimer) { clearTimeout(ttsSleepTimer); ttsSleepTimer = 0; }
  el.ttsTuneBtn.classList.toggle('active', minutes > 0);
  if (minutes <= 0) return;
  ttsSleepTimer = window.setTimeout(() => {
    ttsSleepTimer = 0;
    if (!ttsOn) return;
    stopTts();
    toast('Sleep timer: read aloud stopped');
  }, minutes * 60_000);
  toast(`Read aloud will stop in ${minutes} min`);
}

function closeTtsTune(): void {
  el.ttsTune.hidden = true;
  el.ttsTuneBtn.setAttribute('aria-expanded', 'false');
}
function toggleTtsTune(): void {
  const open = el.ttsTune.hidden;
  if (open) syncTtsTuneUi();
  el.ttsTune.hidden = !open;
  el.ttsTuneBtn.setAttribute('aria-expanded', String(open));
}

function setTtsRate(rate: number): void {
  ttsSettings.rate = Math.max(0.5, Math.min(2, rate));
  persistTts();
  el.ttsRateLabel.textContent = `${ttsSettings.rate.toFixed(1)}×`;
  updateTtsHeard();
  if (!ttsOn) return;

  if (isAudioEngine()) {
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
  if (ttsOn && isAudioEngine()) {
    cancelCurrentUtterance();
    speakNextChunk();
  }
}

function setTtsVoice(value: string): void {
  if (ttsSettings.engine === 'voca') {
    ttsSettings.vocaVoice = value === 'M2' ? 'M2' : 'F2';
  } else if (ttsSettings.engine === 'piper') {
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
  // High-quality voices first: slower to generate but noticeably smoother over long reading. Best with "cache chapter".
  { id: 'en_US-ryan-high', label: 'Ryan (US, male, high)', desc: 'Best for long reading · natural pacing', lang: 'en_US', langGroup: 'en', speaker: 'ryan', quality: 'high', sizeMb: 121 },
  { id: 'en_US-ljspeech-high', label: 'LJSpeech (US, female, high)', desc: 'Audiobook-style, very smooth', lang: 'en_US', langGroup: 'en', speaker: 'ljspeech', quality: 'high', sizeMb: 114 },
  { id: 'en_US-lessac-high', label: 'Lessac (US, female, high)', desc: 'Clear, neutral, high quality', lang: 'en_US', langGroup: 'en', speaker: 'lessac', quality: 'high', sizeMb: 114 },
  { id: 'en_GB-cori-high', label: 'Cori (UK, female, high)', desc: 'British, warm narrator', lang: 'en_GB', langGroup: 'en', speaker: 'cori', quality: 'high', sizeMb: 114 },
  // Medium voices: fast enough for live reading.
  { id: 'en_US-lessac-medium', label: 'Lessac (US, female)', desc: 'Clear, neutral', lang: 'en_US', langGroup: 'en', speaker: 'lessac', quality: 'medium', sizeMb: 63 },
  { id: 'en_US-libritts_r-medium', label: 'LibriTTS-R (US, female)', desc: 'Warm, expressive', lang: 'en_US', langGroup: 'en', speaker: 'libritts_r', quality: 'medium', sizeMb: 63 },
  { id: 'en_US-ryan-medium', label: 'Ryan (US, male)', desc: 'Conversational', lang: 'en_US', langGroup: 'en', speaker: 'ryan', quality: 'medium', sizeMb: 63 },
  { id: 'en_US-amy-medium', label: 'Amy (US, female)', desc: 'Friendly, animated', lang: 'en_US', langGroup: 'en', speaker: 'amy', quality: 'medium', sizeMb: 63 },
  { id: 'en_US-kristin-medium', label: 'Kristin (US, female)', desc: 'Calm, even', lang: 'en_US', langGroup: 'en', speaker: 'kristin', quality: 'medium', sizeMb: 63 },
  { id: 'en_US-norman-medium', label: 'Norman (US, male)', desc: 'Steady, mature', lang: 'en_US', langGroup: 'en', speaker: 'norman', quality: 'medium', sizeMb: 63 },
  { id: 'en_US-hfc_male-medium', label: 'HFC (US, male)', desc: 'Natural, HuggingFace', lang: 'en_US', langGroup: 'en', speaker: 'hfc_male', quality: 'medium', sizeMb: 63 },
  { id: 'en_US-hfc_female-medium', label: 'HFC (US, female)', desc: 'Natural, HuggingFace', lang: 'en_US', langGroup: 'en', speaker: 'hfc_female', quality: 'medium', sizeMb: 63 },
  { id: 'en_GB-alan-medium', label: 'Alan (UK, male)', desc: 'British, calm', lang: 'en_GB', langGroup: 'en', speaker: 'alan', quality: 'medium', sizeMb: 63 },
  { id: 'en_GB-jenny_dioco-medium', label: 'Jenny (UK, female)', desc: 'British, friendly', lang: 'en_GB', langGroup: 'en', speaker: 'jenny_dioco', quality: 'medium', sizeMb: 63 },
  { id: 'en_GB-alba-medium', label: 'Alba (Scottish, female)', desc: 'Scottish, clear', lang: 'en_GB', langGroup: 'en', speaker: 'alba', quality: 'medium', sizeMb: 63 },
  { id: 'en_GB-northern_english_male-medium', label: 'Northern English male', desc: 'UK regional', lang: 'en_GB', langGroup: 'en', speaker: 'northern_english_male', quality: 'medium', sizeMb: 63 },
];

function voiceOnnxUrl(v: CatalogVoice): string {
  return `https://huggingface.co/rhasspy/piper-voices/resolve/main/${v.langGroup}/${v.lang}/${v.speaker}/${v.quality}/${v.id}.onnx`;
}
function voiceJsonUrl(v: CatalogVoice): string {
  return `${voiceOnnxUrl(v)}.json`;
}

interface CatalogModel {
  id: string;      // file stem — must match what Rust's file_stem() produces
                    // for `file`, since renderLlmModelCatalog cross-references
                    // this against installed LlmModel.name the same way
                    // PIPER_CATALOG's `id` is matched against installed voices.
  label: string;
  desc: string;
  repo: string;     // Hugging Face repo, e.g. "Qwen/Qwen2.5-1.5B-Instruct-GGUF"
  file: string;     // exact filename inside that repo
  sizeMb: number;
}

// Small, curated set from one trusted publisher (Qwen's own GGUF repos),
// spanning fast/balanced/best-quality — mirrors PIPER_CATALOG's shape for
// voices. All three URLs and sizes were verified live before adding here.
const LLM_CATALOG: CatalogModel[] = [
  { id: 'qwen2.5-0.5b-instruct-q4_k_m', label: 'Qwen2.5 0.5B Instruct', desc: 'Fastest, lower quality', repo: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF', file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf', sizeMb: 469 },
  { id: 'qwen2.5-1.5b-instruct-q4_k_m', label: 'Qwen2.5 1.5B Instruct', desc: 'Balanced (recommended)',  repo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF', file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf', sizeMb: 1066 },
  { id: 'qwen2.5-3b-instruct-q4_k_m',   label: 'Qwen2.5 3B Instruct',   desc: 'Best quality, slower',     repo: 'Qwen/Qwen2.5-3B-Instruct-GGUF',   file: 'qwen2.5-3b-instruct-q4_k_m.gguf',   sizeMb: 2008 },
];

function modelGgufUrl(m: CatalogModel): string {
  return `https://huggingface.co/${m.repo}/resolve/main/${m.file}`;
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

// Unlike Piper's release assets, llama.cpp's asset filenames embed a
// changing build tag (e.g. "llama-b10099-bin-win-cpu-x64.zip" today,
// "llama-b10098-..." on the prior release) — there's no stable filename to
// hardcode, so GitHub's `/releases/latest/download/<name>` redirect trick
// doesn't apply here. Instead this resolves the current release via the
// GitHub API and pattern-matches the plain CPU-only asset for this platform
// (the same release also ships cuda/vulkan/rocm/hip/sycl/opencl/openvino
// variants, which the anchored suffix match below deliberately excludes —
// we can't assume the right GPU drivers are present). This is genuinely
// async where piperBinaryUrl() is sync; don't "fix" it back to sync.
async function llamaBinaryUrl(): Promise<{ url: string; archiveName: string } | null> {
  const ua = navigator.userAgent;
  const platform = (navigator as any).userAgentData?.platform || '';
  const isWindows = /Windows/i.test(ua);
  const isMac = /Mac/i.test(ua) || platform === 'macOS';
  const isLinux = /Linux/i.test(ua) && !/Android/i.test(ua);

  let suffix: string;
  let ext: 'zip' | 'tar.gz';
  if (isWindows) {
    suffix = 'win-cpu-x64';
    ext = 'zip';
  } else if (isMac) {
    const isArm = /arm64|aarch64/i.test(ua) || /Mac.*ARM/i.test(platform);
    suffix = isArm ? 'macos-arm64' : 'macos-x64';
    ext = 'tar.gz';
  } else if (isLinux) {
    suffix = 'ubuntu-x64';
    ext = 'tar.gz';
  } else {
    return null;
  }

  let assets: Array<{ name: string; browser_download_url: string }>;
  try {
    const res = await fetch('https://api.github.com/repos/ggml-org/llama.cpp/releases/latest');
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
    const data = await res.json();
    assets = data.assets || [];
  } catch (err) {
    console.error('llamaBinaryUrl: failed to resolve latest release:', err);
    throw new Error("Couldn't reach GitHub to find the latest llama.cpp release. Check your connection and try again.");
  }

  // Anchored suffix match — a GPU-backend asset inserts an extra segment
  // before the platform suffix (e.g. "llama-b10099-bin-win-cuda-12.4-x64.zip"),
  // so it never matches this pattern.
  const re = new RegExp(`^llama-b\\d+-bin-${suffix.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\.(zip|tar\\.gz)$`);
  const asset = assets.find(a => re.test(a.name));
  if (!asset) return null;

  return {
    url: asset.browser_download_url,
    archiveName: `_llm_download.${ext}`,
  };
}

// Track in-flight downloads so we don't launch duplicates when a button is
// clicked twice. Values are truthy sentinels; the Rust side owns the actual
// curl process and there's no cancel path currently (curl runs to completion
// or errors out on its own timeout).
const activeDownloads = new Map<string, boolean>();

// Download `url` into `<root>/<relPath>` via the Rust curl command, while
// polling the destination file's size every 500ms to render live progress.
// We don't know the total size up front — the UI shows bytes downloaded,
// and (if `estimateMb` is provided) an approximate percentage.
//
// `commands` selects which pair of Tauri commands to drive this with —
// defaults to the Piper (TTS) ones so every existing call site is
// unaffected; the local-LLM install flow passes the llm_* pair to land
// downloads in the LLM root instead.
async function downloadFileWithProgress(
  url: string,
  relPath: string,
  onProgress: (received: number, estimateBytes: number) => void,
  estimateMb = 0,
  commands: { download: string; size: string } = { download: 'piper_download_file', size: 'piper_file_size' },
): Promise<void> {
  const estimateBytes = estimateMb > 0 ? estimateMb * 1024 * 1024 : 0;
  let cancelled = false;

  const poll = window.setInterval(async () => {
    if (cancelled) return;
    try {
      const size = await invoke<number>(commands.size, { relPath });
      onProgress(size, estimateBytes);
    } catch { /* file not yet written */ }
  }, 500);

  try {
    const finalSize = await invoke<number>(commands.download, { url, relPath });
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

/* --- Local LLM: automated install --------------------------------------
   Same shape as the Piper install flow above, but rendered inside the
   Settings modal's "Local AI" section rather than a dedicated modal (there
   was no other natural home for "configure the model chat/explain/examples
   all share" — see renderLlmSetupSection). One real difference: resolving
   the llama-cli binary URL is async (llamaBinaryUrl hits the GitHub API),
   where piperBinaryUrl() is a synchronous hardcoded lookup.
   ---------------------------------------------------------------------- */
function showLlmError(message: string): void {
  el.llmErrorBody.textContent = message;
  el.llmErrorBanner.hidden = false;
}
function hideLlmError(): void { el.llmErrorBanner.hidden = true; }

async function ensureLlmDirs(): Promise<void> {
  const roots = ['llm', 'llm/models'];
  for (const p of roots) {
    if (!(await exists(p, { baseDir: BaseDirectory.AppData }))) {
      await mkdir(p, { baseDir: BaseDirectory.AppData, recursive: true });
    }
  }
}

// Populates the "Local AI" section of the Settings modal from llmStatus.
// Called whenever Settings opens and after every install/refresh.
function renderLlmSetupSection(): void {
  const s = llmStatus;
  if (!s) {
    el.llmBinaryStatus.textContent = 'Could not read llm folder';
    el.llmBinaryStatus.className = 'piper-status err';
    el.llmModelsStatus.textContent = '—';
    el.llmModelsStatus.className = 'piper-status';
    el.llmModelCatalog.innerHTML = '';
    return;
  }

  el.llmPath.textContent = s.models_dir.replace(/\\models$/i, '').replace(/\/models$/, '');

  if (s.binary_exists) {
    el.llmBinaryStatus.textContent = 'Binary installed';
    el.llmBinaryStatus.className = 'piper-status ok';
    el.llmInstallBinaryBtn.textContent = 'Re-install';
  } else {
    el.llmBinaryStatus.textContent = 'Not installed (~30-50 MB download)';
    el.llmBinaryStatus.className = 'piper-status warn';
    el.llmInstallBinaryBtn.textContent = 'Install';
  }

  if (s.models.length === 0) {
    el.llmModelsStatus.textContent = 'No models installed — pick one below';
    el.llmModelsStatus.className = 'piper-status warn';
  } else {
    el.llmModelsStatus.textContent = `${s.models.length} model${s.models.length === 1 ? '' : 's'} installed`;
    el.llmModelsStatus.className = 'piper-status ok';
  }

  renderLlmModelCatalog();
}

// Opens the Settings modal and refreshes both its sections (Theme, Local
// AI). Shared by every entry point — the library toolbar's gear icon and
// the "Settings" link inside the reader's Typography drawer — so both
// always show current status rather than whatever was last rendered.
function openSettings(): void {
  el.settingsModal.hidden = false;
  el.appearanceSelect.value = settings.appearance;

  document.querySelectorAll('.theme-card').forEach(card => {
    if ((card as HTMLElement).dataset.themeVal === settings.theme) {
      card.classList.add('active');
    } else {
      card.classList.remove('active');
    }
  });

  hideLlmError();
  el.llmBinaryStatus.textContent = 'Checking…';
  el.llmModelsStatus.textContent = 'Checking…';
  renderLlmSetupSection();
  // Status may be stale from boot or a while-ago install — refresh live
  // every time Settings opens rather than only once at startup.
  refreshLlmStatus().then(renderLlmSetupSection);
}

async function installLlmBinary(): Promise<void> {
  if (activeDownloads.has('llm-binary')) return;
  activeDownloads.set('llm-binary', true);

  hideLlmError();
  el.llmInstallBinaryBtn.disabled = true;
  el.llmBinaryProgress.hidden = false;
  paintProgress(el.llmBinaryProgress, 0, 40 * 1024 * 1024, 'Resolving latest release…');

  try {
    const spec = await llamaBinaryUrl();
    if (!spec) {
      throw new Error('No prebuilt llama.cpp binary found for your platform — install manually.');
    }

    await ensureLlmDirs();

    // relPath is llm-root-relative (Rust joins onto llm_root()) — no
    // leading "llm/" here, otherwise the extract step wouldn't find it.
    // ~40MB estimate for the CPU-only zip — not to be confused with the
    // much larger model downloads below.
    await downloadFileWithProgress(
      spec.url,
      spec.archiveName,
      (r, est) => paintProgress(el.llmBinaryProgress, r, est, 'Downloading'),
      40,
      { download: 'llm_download_file', size: 'llm_file_size' },
    );

    paintProgress(el.llmBinaryProgress, 1, 1, 'Extracting');
    await invoke('llm_extract_downloaded_archive', { archiveName: spec.archiveName });

    paintProgress(el.llmBinaryProgress, 1, 1, 'Done');
    toast('llama.cpp installed');
  } catch (err: any) {
    const msg = typeof err === 'string' ? err : (err?.message || String(err));
    console.error('llm binary install failed:', err);
    showLlmError(msg);
  } finally {
    activeDownloads.delete('llm-binary');
    el.llmInstallBinaryBtn.disabled = false;
    setTimeout(() => { el.llmBinaryProgress.hidden = true; }, 1200);
    await refreshLlmStatus();
    renderLlmSetupSection();
    renderLlmModelSelect();
    refreshChatButtonVisibility();
  }
}

// Same no-op-with-toast shape as cancelPiperBinaryInstall — curl has no
// cancel path here either.
function cancelLlmBinaryInstall(): void {
  toast('Install runs to completion; wait or restart the app');
}

async function installLlmModel(model: CatalogModel, row: HTMLElement): Promise<void> {
  const key = `model:${model.id}`;
  if (activeDownloads.has(key)) return;
  activeDownloads.set(key, true);

  hideLlmError();
  const btn = row.querySelector<HTMLButtonElement>('.piper-mini-btn');
  const progress = row.querySelector<HTMLElement>('.piper-progress');
  if (btn) { btn.disabled = true; btn.textContent = 'Downloading…'; }
  if (progress) {
    progress.hidden = false;
    paintProgress(progress, 0, model.sizeMb * 1024 * 1024, 'Model');
  }

  try {
    await ensureLlmDirs();

    // Single file — GGUF has no sidecar config the way Piper voices do.
    await downloadFileWithProgress(
      modelGgufUrl(model),
      `models/${model.file}`,
      (r, est) => progress && paintProgress(progress, r, est, 'Model'),
      model.sizeMb,
      { download: 'llm_download_file', size: 'llm_file_size' },
    );

    if (progress) paintProgress(progress, 1, 1, 'Done');
    toast(`Installed ${model.label}`);
  } catch (err: any) {
    const msg = typeof err === 'string' ? err : (err?.message || String(err));
    console.error('model install failed:', err);
    showLlmError(`${model.label}: ${msg}`);
    if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
  } finally {
    activeDownloads.delete(key);
    await refreshLlmStatus();
    renderLlmSetupSection();
    renderLlmModelSelect();
    refreshChatButtonVisibility();
  }
}

// Extracts a safe destination filename from a user-pasted URL: the last
// path segment, URL-decoded, and validated as a plain "name.gguf" with no
// path separators or traversal sequences. This matters because the result
// becomes `rel_path` for llm_download_file, which joins it straight onto
// llm_root() on the Rust side — an unsanitized "../../something" here
// would let a pasted URL write outside the models folder. The catalog's
// own `installLlmModel` doesn't need this check because its filenames come
// from LLM_CATALOG, not from arbitrary user input.
function ggufFilenameFromUrl(rawUrl: string): string {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('Enter a valid URL.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error('URL must start with http:// or https://.');
  }
  const segments = u.pathname.split('/').filter(Boolean);
  const last = decodeURIComponent(segments[segments.length - 1] || '');
  // No slashes/backslashes (rules out any encoded path-traversal sequence
  // surviving decodeURIComponent), must end in .gguf.
  if (!/^[^\\/]+\.gguf$/i.test(last)) {
    throw new Error('URL must point directly to a .gguf file.');
  }
  return last;
}

async function installLlmCustomModel(): Promise<void> {
  const rawUrl = el.llmCustomUrlInput.value.trim();
  if (!rawUrl) return;

  let filename: string;
  try {
    filename = ggufFilenameFromUrl(rawUrl);
  } catch (err: any) {
    showLlmError(err?.message || 'Enter a valid URL to a .gguf file.');
    return;
  }

  const key = `custom:${filename}`;
  if (activeDownloads.has(key)) return;
  activeDownloads.set(key, true);

  hideLlmError();
  el.llmCustomInstallBtn.disabled = true;
  el.llmCustomUrlInput.disabled = true;
  el.llmCustomProgress.hidden = false;
  // No size estimate up front for an arbitrary URL — paintProgress shows
  // bytes-received-so-far without a percentage bar in that case.
  paintProgress(el.llmCustomProgress, 0, 0, 'Starting…');

  try {
    await ensureLlmDirs();
    await downloadFileWithProgress(
      rawUrl,
      `models/${filename}`,
      (r, est) => paintProgress(el.llmCustomProgress, r, est, 'Downloading'),
      0,
      { download: 'llm_download_file', size: 'llm_file_size' },
    );
    paintProgress(el.llmCustomProgress, 1, 1, 'Done');
    toast(`Installed ${filename}`);
    el.llmCustomUrlInput.value = '';
  } catch (err: any) {
    const msg = typeof err === 'string' ? err : (err?.message || String(err));
    console.error('custom model install failed:', err);
    showLlmError(`${filename}: ${msg}`);
  } finally {
    activeDownloads.delete(key);
    el.llmCustomInstallBtn.disabled = false;
    el.llmCustomUrlInput.disabled = false;
    setTimeout(() => { el.llmCustomProgress.hidden = true; }, 1200);
    await refreshLlmStatus();
    renderLlmSetupSection();
    renderLlmModelSelect();
    refreshChatButtonVisibility();
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

function renderLlmModelCatalog(): void {
  const installedIds = new Set(
    (llmStatus?.models || []).map(m => m.name),
  );
  el.llmModelCatalog.innerHTML = '';
  for (const model of LLM_CATALOG) {
    const li = document.createElement('li');
    li.className = 'piper-voice-row' + (installedIds.has(model.id) ? ' installed' : '');
    li.innerHTML = `
      <div class="piper-voice-meta">
        <span class="piper-voice-name">${escapeHtml(model.label)}</span>
        <span class="piper-voice-desc">${escapeHtml(model.desc)} · ${model.sizeMb} MB</span>
      </div>
      <div class="piper-voice-action">
        <div class="piper-progress" hidden>
          <div class="piper-progress-bar"><span></span></div>
          <div class="piper-progress-label">—</div>
        </div>
        ${installedIds.has(model.id)
          ? '<span class="installed-tag">Installed</span>'
          : '<button class="piper-mini-btn" type="button">Install</button>'}
      </div>
    `;
    const btn = li.querySelector<HTMLButtonElement>('.piper-mini-btn');
    if (btn) btn.addEventListener('click', () => installLlmModel(model, li));
    el.llmModelCatalog.appendChild(li);
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

type ChunkWord = { wordIdx: number; text: string; glue?: boolean };
// A chunk is the words handed to the synth engine in one go, plus how the
// reader should pace the gap that follows it.
type Chunk = ChunkWord[] & { pauseAfterMs?: number; sentenceEnd?: boolean; aside?: boolean; softEnd?: boolean };

/* --- Structure-aware pacing --------------------------------------------
   Words are flat tokens, so on their own a heading ("Chapter 1") runs
   straight into the paragraph below it. These helpers recover the block
   (heading / paragraph / list item) each word lives in, so chunks never
   straddle blocks and headings, paragraphs and list items get a real pause.
   ----------------------------------------------------------------------- */
const TTS_BLOCK_SELECTOR =
  'h1,h2,h3,h4,h5,h6,p,li,dt,dd,blockquote,figcaption,pre,tr,td,th,caption,div,section,article,header,footer,aside,summary';
const TTS_HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
const TTS_HEADING_CLASS_RE = /(^|[-_ ])(title|subtitle|heading|subhead|chapter-?title|chap-?title|ch-?title)([-_ ]|$)/i;

const TTS_PAUSE_HEADING_MS = 750;
const TTS_PAUSE_PARAGRAPH_MS = 450;
const TTS_PAUSE_ITEM_MS = 320;
const TTS_PAUSE_SENTENCE_MS = 160;   // piper only: breath between sentences

const ttsScaledPause = (ms: number) => Math.round(ms * (ttsSettings.pauseScale || 1));

const ttsBlockCache = new WeakMap<Node, Element | null>();
const ttsHeadingCache = new WeakMap<Element, boolean>();

function ttsBlockOf(fw: FocusWord): Element | null {
  const cached = ttsBlockCache.get(fw.node);
  if (cached !== undefined) return cached;
  const block = fw.node.parentElement?.closest(TTS_BLOCK_SELECTOR) ?? null;
  ttsBlockCache.set(fw.node, block);
  return block;
}

// Calibre-style books give titles opaque classes (class="calibre12"), so fall
// back to how the block is styled: clearly larger than the body text.
function ttsLooksLikeHeading(block: Element): boolean {
  const tag = block.tagName;
  if (tag === 'LI' || tag === 'TD' || tag === 'TH' || tag === 'DD' || tag === 'DT' || tag === 'PRE' || tag === 'BLOCKQUOTE') return false;
  const doc = block.ownerDocument;
  const view = doc.defaultView;
  if (!view || !doc.body) return false;
  const size = parseFloat(view.getComputedStyle(block).fontSize);
  const base = parseFloat(view.getComputedStyle(doc.body).fontSize);
  return size > 0 && base > 0 && size >= base * 1.3;
}

function ttsIsHeading(fw: FocusWord): boolean {
  const parent = fw.node.parentElement;
  if (!parent) return false;
  if (parent.closest(TTS_HEADING_SELECTOR)) return true;
  // Many ebooks mark titles with a class on a plain <p>/<div> instead of <hN>.
  const block = ttsBlockOf(fw);
  if (!block) return false;
  let isHeading = ttsHeadingCache.get(block);
  if (isHeading === undefined) {
    const cls = typeof block.className === 'string' ? block.className : '';
    const short = (block.textContent || '').trim().length < 140;
    isHeading = short && (TTS_HEADING_CLASS_RE.test(cls) || ttsLooksLikeHeading(block));
    ttsHeadingCache.set(block, isHeading);
  }
  return isHeading;
}

function ttsWordText(idx: number): string {
  const fw = focusWords[idx];
  return fw ? (fw.node.textContent || '').slice(fw.start, fw.end).trim() : '';
}

/* --- Parentheticals ---------------------------------------------------
   Text in (parentheses) or [brackets] is an aside. Read in the same flow as
   the sentence around it, it sounds like part of the main clause. So an aside
   becomes its own chunk: a short pause before and after, no spoken brackets,
   and a comma on the text before it so the voice hands over naturally.
   ----------------------------------------------------------------------- */
const TTS_PAUSE_ASIDE_MS = 220;
const TTS_PAUSE_LINE_MS = 260;          // <br> line breaks (verse, addresses)
const TTS_PAGE_SPILL_WORDS = 28;        // finish a sentence that runs off the page, up to this many words
const TTS_ASIDE_MAX_WORDS = 60;       // an opener with no closer this close is just a stray "("
const TTS_PAREN_OPEN_RE = /^["'“‘]*[([]/;

let ttsParenWordsRef: FocusWord[] | null = null;
let ttsParenMap: Uint8Array = new Uint8Array(0);

function ttsComputeParenMap(): void {
  const n = focusWords.length;
  const map = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!TTS_PAREN_OPEN_RE.test(ttsWordText(i))) continue;
    const block = ttsBlockOf(focusWords[i]);
    let depth = 0;
    let end = -1;
    for (let j = i; j < n && j < i + TTS_ASIDE_MAX_WORDS; j++) {
      if (ttsBlockOf(focusWords[j]) !== block) break;
      for (const ch of ttsWordText(j)) {
        if (ch === '(' || ch === '[') depth++;
        else if ((ch === ')' || ch === ']') && depth > 0) depth--;
      }
      if (depth === 0) { end = j; break; }
    }
    if (end >= 0) {
      for (let k = i; k <= end; k++) map[k] = 1;
      i = end;
    }
  }
  ttsParenWordsRef = focusWords;
  ttsParenMap = map;
}

// True when the word at idx is inside a parenthetical (including its brackets).
function ttsInParen(idx: number): boolean {
  if (ttsParenWordsRef !== focusWords || ttsParenMap.length !== focusWords.length) ttsComputeParenMap();
  return ttsParenMap[idx] === 1;
}

function ttsBlockEndsAfter(idx: number): boolean {
  const cur = focusWords[idx];
  const nxt = focusWords[idx + 1];
  return !!cur && !!nxt && ttsBlockOf(cur) !== ttsBlockOf(nxt);
}

// Silence to leave after the word at idx: 0 inside a block, a longer one
// when the block (heading > paragraph > list item) ends there.
function ttsPauseAfter(idx: number): number {
  const cur = focusWords[idx];
  const nxt = focusWords[idx + 1];
  if (!cur || !nxt) return 0;
  const block = ttsBlockOf(cur);
  if (block === ttsBlockOf(nxt)) {
    // Same block: a <br> line break or a parenthetical opening / closing earns a pause.
    if (ttsNodeGap(idx + 1) === 'br') return ttsScaledPause(TTS_PAUSE_LINE_MS);
    return ttsInParen(idx) !== ttsInParen(idx + 1) ? ttsScaledPause(TTS_PAUSE_ASIDE_MS) : 0;
  }
  if (ttsIsHeading(cur)) return ttsScaledPause(TTS_PAUSE_HEADING_MS);
  const tag = block?.tagName;
  if (tag === 'LI' || tag === 'DT' || tag === 'DD' || tag === 'TD' || tag === 'TH' || tag === 'TR') return ttsScaledPause(TTS_PAUSE_ITEM_MS);
  return ttsScaledPause(TTS_PAUSE_PARAGRAPH_MS);
}

// Tokens come from text nodes, so punctuation that sits outside an inline tag
// ("</a>, <em>" or "<em>.1</em>") arrives as its own token. Joined with plain
// spaces that becomes "Figure 8 .1" / "Chapter 1 ," — attach it to the word
// before it, and keep opening marks attached to the word after them.
const TTS_ATTACH_LEFT_RE = /^[,.;:!?)\]}…%]/;
const TTS_CLOSING_ONLY_RE = /^[”’»]+$/;
const TTS_OPENERS_ONLY_RE = /^[(\[{“‘«]+$/;
function ttsJoinTokens(words: ChunkWord[]): string {
  let out = '';
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (i > 0) {
      const glued = w.glue || TTS_ATTACH_LEFT_RE.test(w.text) || TTS_CLOSING_ONLY_RE.test(w.text) || TTS_OPENERS_ONLY_RE.test(words[i - 1].text);
      if (!glued) out += ' ';
    }
    out += w.text;
  }
  return out;
}

// Text actually sent to the engine. Headings, list items and other fragments
// usually lack closing punctuation; without it engines run them into the
// next line with no falling intonation, so close them with a full stop.
function ttsSpokenText(words: ChunkWord[]): string {
  const chunk = words as Chunk;
  let text = ttsJoinTokens(words);
  // Brackets aren't spoken; the pause and tone around the chunk carry the aside.
  if (chunk.aside) text = text.replace(/[()[\]]/g, '');
  const bare = text.replace(TRAILING_CLOSING_RE, '');
  if (/[.!?…:;,]$/.test(bare)) return text;
  // A chunk that stops mid-sentence (before/after an aside, or a long-sentence
  // cut) should sound unfinished, so it gets a comma instead of a full stop.
  return text + (chunk.softEnd ? ',' : '.');
}

const TTS_SOFT_BREAK_RE = /[,;:–—]$/;

// Collect a chunk of visible words starting at startIdx in focusWords.
//
// Rules:
//   - A chunk never crosses a block boundary (heading, paragraph, list item):
//     the pause after it is recorded in pauseAfterMs.
//   - Otherwise stop at the first real sentence end after MIN words (see
//     endsSentence — abbreviations, initials and dialogue tags don't count).
//   - Hard cap at MAX words; when a long sentence forces a cut, back up to the
//     last comma / semicolon / colon / dash so the break lands on a clause.
//   - Stop early if we hit an off-page word ('after' -> page turn needed).
//
// Doesn't mutate focusIndex — callers advance it when the chunk is committed.
// How the word at idx connects to the one before it when they live in
// different text nodes:
//   'glue'  – no whitespace between them (drop caps, "<em>8</em>.1", split words)
//   'br'    – a <br>/<hr> separates them (a line break even without whitespace)
//   'space' – ordinary word gap
function ttsNodeGap(idx: number): 'space' | 'glue' | 'br' {
  const cur = focusWords[idx];
  const prev = focusWords[idx - 1];
  if (!cur || !prev || prev.node === cur.node) return 'space';
  try {
    const r = cur.node.ownerDocument.createRange();
    r.setStart(prev.node, prev.end);
    r.setEnd(cur.node, cur.start);
    if (r.cloneContents().querySelector('br, hr')) return 'br';
    if (r.toString() === '' && ttsBlockOf(prev) === ttsBlockOf(cur)) return 'glue';
  } catch { /* detached nodes — treat as a normal gap */ }
  return 'space';
}

// When read-aloud is mid-sentence at the end of an EPUB page the chunk spills
// onto the next page; turn the page once the audio reaches those words.
// Scrolling documents (web articles, Markdown, text): speech keeps its own
// place whatever the view does. The view follows the spoken word only while the
// reader hasn't scrolled away; once they scroll, we leave it alone until the
// spoken word is on screen again.
let ttsUserScrolled = false;
let ttsAutoScrollUntil = 0;
// For choosing what to speak, every laid-out word counts as readable; only detached / zero-size ones are skipped.
function ttsSpeakable<T extends { pos: WordPos }>(c: T): { pos: WordPos } & Omit<T, "pos"> {
  return { ...c, pos: (c.pos === "gone" ? "gone" : "visible") as WordPos };
}

function speechDocAlive(): boolean {
  const doc = focusIframeDoc;
  if (!doc) return false;
  if (doc === document) return true;
  const fe = doc.defaultView?.frameElement;
  return !!fe && fe.isConnected && !!doc.body;
}

// EPUB: the section after the one being read. The reader may have paged or
// jumped elsewhere, so go by the speech's own section, then show it.
async function ttsAdvanceSection(cb: () => void): Promise<void> {
  if (advancingPage || !currentRendition || !currentBook) return;
  const mine = ((currentRendition as any).getContents?.() ?? []).find((c: any) => c.document === focusIframeDoc);
  const idx: number | undefined = mine?.sectionIndex;
  if (typeof idx !== 'number') { void turnPageAndContinue(cb); return; }   // section unknown: old behaviour
  const target: any = (currentBook as any).spine.get(idx + 1);
  if (!target) { toast('End of book'); stopTts(); return; }
  advancingPage = true;
  ttsAutoScrollUntil = performance.now() + 4000;
  const prevDoc = focusIframeDoc;
  try { await currentRendition.display(target.href); } catch (err) { console.warn('tts: advance failed:', err); }
  await raf();
  const deadline = performance.now() + 1500;
  while (performance.now() < deadline) {
    if (!ttsOn) { advancingPage = false; return; }
    const doc = getVisibleIframe()?.contentDocument ?? null;
    if (doc && doc !== prevDoc && doc.body && doc.body.childNodes.length > 0) { await raf(); break; }
    await wait(40);
  }
  advancingPage = false;
  if (!ttsOn) return;
  collectFocusWords();
  focusIndex = 0;
  ttsUserScrolled = false;
  cb();
}

function ttsFollow(pos: WordPos, rect: DOMRect | null): void {
  if (!currentTextElement) {
    // Paged / scrolled EPUB: turn when speech reaches the next page, unless the
    // reader has moved away from the spoken page; back on it, we follow again.
    if (pos === 'visible') ttsUserScrolled = false;
    else if (pos === 'after' && !ttsUserScrolled) ttsTurnForSpill();
    return;
  }
  const box = currentTextElement;
  if (!rect) return;
  const b = box.getBoundingClientRect();
  if (pos === 'visible' && ttsUserScrolled) { ttsUserScrolled = false; }   // reader is back on the spoken word
  if (ttsUserScrolled) return;
  const nearBottom = rect.top > b.bottom - b.height * 0.15;
  if (pos !== 'after' && !(pos === 'visible' && nearBottom)) return;
  ttsAutoScrollUntil = performance.now() + 700;
  box.scrollTop += rect.top - b.top - b.height * 0.3;
}

let ttsSpillTurnPending = false;
function ttsTurnForSpill(): void {
  if (ttsSpillTurnPending || !currentRendition) return;
  ttsSpillTurnPending = true;
  ttsAutoScrollUntil = performance.now() + 1500;   // our own turn, not the reader's
  Promise.resolve(currentRendition.next())
    .catch(() => {})
    .finally(() => { window.setTimeout(() => { ttsSpillTurnPending = false; }, 400); });
}

const TTS_URL_RE = /(?:https?:[/][/]|www[.])\S+/i;
const TTS_WORD_CHAR_RE = /[\p{L}\p{N}]/u;

function collectVisibleChunkFrom(startIdx: number): { words: Chunk; hitAfter: boolean } {
  let r = collectVisibleChunkRaw(startIdx);
  // A chunk of only brackets / punctuation (what's left of "(see https://…)")
  // has nothing to say — skip it and take the next one.
  while (r.words.length > 0 && !TTS_WORD_CHAR_RE.test(r.words.map(w => w.text).join(''))) {
    r = collectVisibleChunkRaw(r.words[r.words.length - 1].wordIdx + 1);
  }
  return r;
}

function collectVisibleChunkRaw(startIdx: number): { words: Chunk; hitAfter: boolean } {
  const words: Chunk = [];
  let spillWords = 0;
  let idx = startIdx;
  let hitAfter = false;
  let chunkBlock: Element | null | undefined;
  let heading = false;
  let chunkInParen = false;

  const finish = (): { words: Chunk; hitAfter: boolean } => {
    const last = words[words.length - 1];
    if (last) {
      const pause = ttsPauseAfter(last.wordIdx);
      const sentenceEnd = endsSentence(last.text, ttsWordText(last.wordIdx + 1));
      if (pause > 0) words.pauseAfterMs = pause;
      words.sentenceEnd = sentenceEnd;
      words.aside = ttsInParen(words[0].wordIdx);
      words.softEnd = !sentenceEnd && !ttsBlockEndsAfter(last.wordIdx);
    }
    return { words, hitAfter };
  };

  while (idx < focusWords.length) {
    const fw = focusWords[idx];
    // Read on from where speech is, wherever the view is (scrolled or paged away).
    const { pos } = ttsSpeakable(classifyWord(fw));
    // EPUB pages: finish a sentence that runs off the bottom of the page instead
    // of stopping mid-sentence and paying a page-turn gap in the middle of it.
    const spill = pos === 'after' && !currentTextElement && words.length > 0 && spillWords < TTS_PAGE_SPILL_WORDS
      && !endsSentence(words[words.length - 1].text, ttsWordText(idx));
    if (pos === 'visible' || spill) {
      const text = (fw.node.textContent || '').slice(fw.start, fw.end);
      const trimmed = text.trim();
      if (!trimmed) { idx++; continue; }
      if (TTS_URL_RE.test(trimmed)) { idx++; continue; }   // never spell a URL out

      const block = ttsBlockOf(fw);
      if (words.length === 0) {
        chunkBlock = block;
        heading = ttsIsHeading(fw);
        chunkInParen = ttsInParen(idx);
      } else if (block !== chunkBlock || ttsInParen(idx) !== chunkInParen || ttsNodeGap(idx) === 'br') {
        return finish();               // next block (or aside) starts here — end the chunk
      }

      if (words.length >= TTS_MAX_CHUNK_WORDS) {
        // Long sentence: cut at a clause break if there is one nearby.
        for (let k = words.length - 1; k >= Math.max(TTS_MIN_CHUNK_WORDS, words.length - 14); k--) {
          if (TTS_SOFT_BREAK_RE.test(words[k].text.replace(TRAILING_CLOSING_RE, ''))) {
            words.length = k + 1;
            break;
          }
        }
        return finish();
      }

      if (pos === 'after') spillWords++;
      words.push({ wordIdx: idx, text, glue: ttsNodeGap(idx) === 'glue' });
      idx++;
      // Headings are read whole (up to the cap); prose ends on a sentence.
      if (!heading && words.length >= TTS_MIN_CHUNK_WORDS && endsSentence(trimmed, ttsWordText(idx))) {
        return finish();
      }
    } else if (pos === 'before' || pos === 'gone') {
      idx++;
    } else {
      hitAfter = true;
      break;
    }
  }
  return finish();
}

// Speak the next chunk starting at (or after) focusIndex. Handles page
// turns transparently when there's nothing visible left to read. Dispatches
// to the currently-selected engine.
// How much of the current chapter / document has been read aloud, and how long
// the rest will take at the current speed (about 165 words a minute at 1×).
function updateTtsHeard(): void {
  const n = focusWords.length;
  if (n === 0) { el.ttsHeardFill.style.width = '0%'; el.ttsTimeLeft.textContent = ''; return; }
  const done = Math.max(0, Math.min(n, focusIndex));
  el.ttsHeardFill.style.width = (done / n * 100).toFixed(1) + '%';
  const minutes = Math.max(1, Math.round((n - done) / (165 * (ttsSettings.rate || 1))));
  el.ttsTimeLeft.textContent = minutes + ' min left';
}

function speakNextChunk(): void {
  if (!ttsOn) return;

  // Refresh word list if the visible iframe has swapped (page turn).
  // Only when the section being read has been unloaded (the reader navigated
  // far away) do we re-anchor, to the page they are now looking at.
  if (!currentTextElement && !speechDocAlive()) {
    collectFocusWords();
    const first = findFirstVisibleWordIndex();
    focusIndex = first >= 0 ? first : 0;
  }
  updateTtsHeard();

  // If we have a cached WAV for the current section+voice, prefer it —
  // audio playback is instant, no synth latency. Fires async but we
  // don't wait; if it succeeds it takes over playback, if it fails
  // (miss, IO error, etc.) it returns false and we fall through to the
  // pipelined synth path.
  if (!cachedPlayback && isAudioEngine()) {
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
    const { pos } = ttsSpeakable(classifyWord(focusWords[focusIndex]));   // never skip text just because the view is elsewhere
    if (pos === 'visible') { startIdx = focusIndex; break; }
    if (pos === 'before' || pos === 'gone') { focusIndex++; continue; }
    if (pos === 'after') break;
  }

  if (startIdx === -1) {
    if (currentTextElement) { toast('End of book'); stopTts(); return; }   // nothing left; never scroll the view for it
    void ttsAdvanceSection(() => speakNextChunk());
    return;
  }

  const { words } = collectVisibleChunkFrom(startIdx);
  if (words.length === 0) {
    if (currentTextElement) { toast('End of book'); stopTts(); return; }
    void ttsAdvanceSection(() => speakNextChunk());
    return;
  }

  if (isAudioEngine()) {
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

function buildSystemUtterance(chunkWords: Chunk, token: number): SpeechSynthesisUtterance {
  let text = '';
  const map: Array<{ wordIdx: number; charStart: number; charEnd: number }> = [];
  for (let i = 0; i < chunkWords.length; i++) {
    if (i > 0) text += ' ';
    const start = text.length;
    text += chunkWords[i].text;
    map.push({ wordIdx: chunkWords[i].wordIdx, charStart: start, charEnd: text.length });
  }
  // Close fragments (headings, list items) so the voice falls and pauses.
  const spoken = ttsSpokenText(chunkWords);
  if (spoken.length > text.length) text = spoken;

  const u = new SpeechSynthesisUtterance(text);
  u.rate = ttsSettings.rate;
  u.volume = ttsSettings.volume;
  u.pitch = Math.min(2, ttsSettings.pitch * (chunkWords.aside ? 0.9 : 1));
  const voice = getSelectedVoice();
  if (voice) { u.voice = voice; u.lang = voice.lang; }

  u.onstart = () => {
    if (token !== piperGenToken || !ttsOn) return;
    // Queue the next chunk RIGHT NOW so Chromium plays them back-to-back.
    // Only if there are more visible words on this page — page turns must
    // happen after playback ends, in onend/speakNextChunk.
    if (systemQueuedAhead) return;   // already have one queued
    // A heading / paragraph end needs a real pause, which natively queued
    // utterances can't give — onend schedules the next chunk after the gap.
    if (chunkWords.pauseAfterMs) return;
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
        ttsFollow(pos, rect);
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
    const gap = chunkWords.pauseAfterMs || 0;
    if (gap > 0) scheduleTtsGap(gap, () => { if (token === piperGenToken) speakNextChunk(); });
    else speakNextChunk();
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

function speakSystemChunk(chunkWords: Chunk): void {
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
  words: Chunk;
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

// Pending "pause before the next chunk" timer. If the user pauses during the
// gap, the continuation is held and runs on resume instead.
let ttsGapTimer = 0;
let ttsGapHeld: (() => void) | null = null;

function scheduleTtsGap(ms: number, fn: () => void): void {
  clearTtsGap();
  ttsGapTimer = window.setTimeout(() => {
    ttsGapTimer = 0;
    if (!ttsOn) return;
    if (ttsPaused) { ttsGapHeld = fn; return; }
    fn();
  }, ms);
}

function clearTtsGap(): void {
  if (ttsGapTimer) { clearTimeout(ttsGapTimer); ttsGapTimer = 0; }
  ttsGapHeld = null;
}

function stopPiperPlayback(): void {
  clearTtsGap();
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
        ttsFollow(pos, rect);
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
  chunkWords: Chunk,
  token: number,
): Promise<PreparedPiperChunk | null> {
  const voice = ttsSettings.piperVoicePath;
  const useVoca = ttsSettings.engine === 'voca';
  if (!useVoca && !voice) return null;
  const text = ttsSpokenText(chunkWords);
  let wavBytes: Uint8Array;
  try {
    if (useVoca) {
      // In natural-rate mode the model itself speaks faster/slower (pitch preserved).
      wavBytes = await vocaSynthesize(text, ttsSettings.vocaVoice, ttsSettings.piperNaturalRate ? ttsSettings.rate : 1);
    } else {
      const result = await invoke<number[] | Uint8Array>('piper_synthesize', {
        text,
        voicePath: voice,
        lengthScale: currentPiperLengthScale(),
        expressiveness: currentExpressiveness(),
      });
      wavBytes = result instanceof Uint8Array ? result : new Uint8Array(result);
    }
  } catch (err) {
    console.error(useVoca ? 'voca synth failed:' : 'piper_synthesize failed:', err);
    return null;
  }
  if (!ttsOn || token !== piperGenToken) return null;

  const blob = new Blob([wavBytes.buffer as ArrayBuffer], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.playbackRate = currentPiperPlaybackRate();
  audio.volume = ttsSettings.volume;
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

    const advance = () => {
      if (!ttsOn || prepared.token !== piperGenToken) return;
      // If we have a prefetched next chunk ready, play it directly. Otherwise
      // fall back to the standard flow (which handles page turns and
      // re-collecting words on the new page).
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

    // Heading / paragraph / sentence pause before the next chunk.
    const gap = prepared.words.pauseAfterMs ?? (prepared.words.sentenceEnd ? ttsScaledPause(TTS_PAUSE_SENTENCE_MS) : 0);
    if (gap > 0) scheduleTtsGap(gap, advance);
    else advance();
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

async function speakPiperChunk(chunkWords: Chunk): Promise<void> {
  const voice = ttsSettings.piperVoicePath;
  if (ttsSettings.engine === 'piper' && !voice) { toast('Pick a Piper voice first'); stopTts(); return; }

  const token = ++piperGenToken;
  // Any pre-existing prefetch is from a stale generation — drop it.
  if (piperPrefetched) {
    URL.revokeObjectURL(piperPrefetched.url);
    piperPrefetched = null;
  }

  const prepared = await synthesizePiperChunk(chunkWords, token);
  if (!prepared) {
    // A newer request (stepping, jumping, rate change) invalidates this one: that is not a failure.
    if (ttsOn && token === piperGenToken) { toast(ttsSettings.engine === 'voca' ? 'Tiny Voca synth failed' : 'Piper synth failed'); stopTts(); }
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
  if (ttsSettings.engine === 'voca') return `voca-${ttsSettings.vocaVoice}`;
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
function collectSectionSentences(): {
  texts: string[];
  ranges: Array<{ startWordIdx: number; endWordIdx: number }>;
  pausesMs: number[];
} {
  const texts: string[] = [];
  const ranges: Array<{ startWordIdx: number; endWordIdx: number }> = [];
  const pausesMs: number[] = [];
  let curWords: ChunkWord[] = [];
  let curStart = -1;
  let lastIdx = -1;
  const flush = (pauseMs: number, soft = false) => {
    if (curWords.length === 0 || curStart < 0) return;
    (curWords as Chunk).aside = ttsInParen(curWords[0].wordIdx);
    (curWords as Chunk).softEnd = soft;
    texts.push(ttsSpokenText(curWords));
    ranges.push({ startWordIdx: curStart, endWordIdx: curWords[curWords.length - 1].wordIdx });
    pausesMs.push(pauseMs);
    curWords = [];
    curStart = -1;
  };
  for (let i = 0; i < focusWords.length; i++) {
    const text = ttsWordText(i);
    if (!text) continue;
    if (curStart === -1) curStart = i;
    curWords.push({ wordIdx: i, text });
    lastIdx = i;
    // Block ends (heading, paragraph, list item) always close the sentence
    // and carry a longer pause; ordinary sentence ends get a short breath.
    const blockPause = ttsPauseAfter(i);
    if (blockPause > 0) {
      flush(blockPause, !ttsBlockEndsAfter(i) && !endsSentence(text, ttsWordText(i + 1)));
    } else if (curWords.length >= TTS_MIN_CHUNK_WORDS && endsSentence(text, ttsWordText(i + 1))) {
      flush(ttsScaledPause(TTS_PAUSE_SENTENCE_MS));
    }
  }
  // Flush trailing partial sentence (paragraph with no terminator, etc.).
  if (lastIdx >= 0) flush(0);
  return { texts, ranges, pausesMs };
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
          }
          ttsFollow(cls.pos, cls.rect);
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
  if (!isAudioEngine()) return false;
  if (!currentTextElement && focusIframeDoc && focusIframeDoc !== getVisibleIframe()?.contentDocument) return false;
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
  audio.volume = ttsSettings.volume;
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

function updateCacheButtonState(cached: boolean, progressLabel?: string): void {
  el.ttsCacheBtn.classList.toggle('cached', cached);
  el.ttsCacheBtn.classList.toggle('caching', cachingInFlight);
  el.ttsCacheBtn.title = cachingInFlight
    ? (progressLabel || 'Caching chapter…')
    : cached
      ? 'Chapter cached — playback is instant'
      : 'Cache this chapter for instant audiobook-style playback';
}

async function refreshCacheButtonForCurrentSection(): Promise<void> {
  const cacheable = ttsSettings.engine === 'voca' || (ttsSettings.engine === 'piper' && isPiperReady());
  if (!cacheable || !currentBookRecord) {
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
  if (ttsSettings.engine === 'piper' ? !isPiperReady() : ttsSettings.engine !== 'voca') {
    toast('Piper or Tiny Voca required to cache'); return;
  }
  const voice = currentVoiceId();
  const href = currentSectionHref();
  if (!voice || !href) { toast('No section to cache'); return; }
  const key = sectionKeyFromHref(href);

  // Ensure focusWords is populated for the current section, then extract
  // its sentences.
  collectFocusWords();
  const { texts, pausesMs } = collectSectionSentences();
  if (texts.length === 0) {
    toast('Nothing to cache in this section');
    return;
  }

  cachingInFlight = true;
  updateCacheButtonState(false);
  toast(`Caching ${texts.length} sentences… 0%`);

  // Sentences synthesize entirely in-memory (nothing on disk to size-poll
  // like the voice-model downloads), so progress comes from a small atomic
  // counter on the Rust side — poll it the same way downloadFileWithProgress
  // polls piper_file_size.
  const useVoca = ttsSettings.engine === 'voca';
  let vocaDone = 0;
  const progressPoll = window.setInterval(async () => {
    try {
      const [done, total] = useVoca ? [vocaDone, texts.length] : await invoke<[number, number]>('piper_batch_progress');
      if (total > 0) {
        const pct = Math.round((done / total) * 100);
        const label = `Caching… ${pct}% (${done}/${total})`;
        toast(label);
        updateCacheButtonState(false, label);
      }
    } catch { /* transient — ignore, next tick retries */ }
  }, 400);

  try {
    if (useVoca) {
      // Tiny Voca synthesizes in the worker; assemble the chapter WAV + sidecar
      // here and store them where piper_cache_lookup (and playback) expect them.
      const speed = ttsSettings.piperNaturalRate ? ttsSettings.rate : 1;
      const pieces: Float32Array[] = [];
      const starts: number[] = [];
      let rate = 24000;
      let samples = 0;
      for (let i = 0; i < texts.length; i++) {
        const r = await vocaSynthesizeSamples(texts[i], ttsSettings.vocaVoice, speed);
        rate = r.sampleRate;
        starts.push(samples / rate);
        pieces.push(r.audio);
        samples += r.audio.length;
        const gap = new Float32Array(Math.round(rate * Math.min(5000, pausesMs[i] ?? 0) / 1000));
        pieces.push(gap);
        samples += gap.length;
        vocaDone = i + 1;
      }
      const all = new Float32Array(samples);
      let at = 0;
      for (const p of pieces) { all.set(p, at); at += p.length; }
      const dir = `piper/cache/${currentBookRecord.id}`;
      const stem = `${dir}/${key}_${voice}`;
      await mkdir(dir, { baseDir: BaseDirectory.AppData, recursive: true });
      await writeFile(`${stem}.wav`, wavFromFloat32(all, rate), { baseDir: BaseDirectory.AppData });
      await writeFile(`${stem}.json`, new TextEncoder().encode(JSON.stringify({
        voice, section: key, sentence_starts: starts, total_duration: samples / rate, sample_rate: rate,
      })), { baseDir: BaseDirectory.AppData });
    } else {
    await invoke('piper_batch_synthesize', {
      bookId: currentBookRecord.id,
      sectionKey: key,
      voicePath: ttsSettings.piperVoicePath,
      sentences: texts,
      pausesMs,
      lengthScale: currentPiperLengthScale(),
      expressiveness: currentExpressiveness(),
    });
    }
    toast('Chapter cached — hit play for instant audio');
  } catch (err: any) {
    console.error('cache failed:', err);
    toast(`Cache failed: ${err?.message || err}`);
  } finally {
    clearInterval(progressPoll);
    cachingInFlight = false;
    await refreshCacheButtonForCurrentSection();
  }
}

function wire() {
  // Links inside Markdown / article / PDF text live in the main document (EPUB
  // pages are handled in their own frames, see the content hook).
  document.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('#viewer a[href]') as HTMLAnchorElement | null;
    const href = a?.getAttribute('href');
    if (!a || !href || !isExternalLink(href)) return;
    e.preventDefault();
    e.stopPropagation();
    openExternalLink(href);
  }, true);
  el.importBtn.addEventListener('click', importBook);
  el.importBtnEmpty.addEventListener('click', importBook);
  el.libraryThemeBtn.addEventListener('click', cycleTheme);
  el.markReadBtn.addEventListener('click', () => { if (currentBookRecord) toggleBookFinished(currentBookRecord); });
  el.aiExportBtn.addEventListener('click', () => { void copyForAi(); });
  el.popoverAi.addEventListener('click', async () => {
    await copyForAi();
    hideAllPopovers();
  });
  el.libraryVocabReviewBtn.addEventListener('click', () => openVocabReview('all'));

  // --- Library redesign: search, format filter, sort -----------------------
  el.librarySearch?.addEventListener('input', () => {
    libraryQuery = el.librarySearch.value;
    renderLibrary();
  });
  el.librarySearch?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      el.librarySearch.value = '';
      libraryQuery = '';
      renderLibrary();
      el.librarySearch.blur();
    }
  });

  document.querySelectorAll<HTMLButtonElement>('.format-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      libraryFilter = (tab.dataset.filter as LibraryFilter) || 'all';
      document.querySelectorAll<HTMLButtonElement>('.format-tab').forEach(t => {
        const on = t === tab;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      renderLibrary();
    });
  });

  el.librarySortBtn?.addEventListener('click', () => {
    const order: LibrarySort[] = ['recent', 'title', 'author'];
    librarySort = order[(order.indexOf(librarySort) + 1) % order.length];
    el.librarySortLabel.textContent = librarySort === 'recent'
      ? 'Recently opened'
      : librarySort === 'title' ? 'Title A–Z' : 'Author A–Z';
    renderLibrary();
  });

  document.querySelectorAll<HTMLButtonElement>('.sidebar-nav-item[data-library-nav]').forEach(item => {
    item.addEventListener('click', () => {
      const nav = item.dataset.libraryNav;
      if (nav === 'library') {
        el.librarySearch.value = '';
        libraryQuery = '';
        libraryFilter = 'all';
        document.querySelectorAll<HTMLButtonElement>('.format-tab').forEach(t => {
          const on = t.dataset.filter === 'all';
          t.classList.toggle('active', on);
          t.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        renderLibrary();
        document.querySelector('.library-main')?.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        toast(nav === 'highlights'
          ? 'Open a book to browse its highlights'
          : 'Open a book to browse its bookmarks');
      }
    });
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'
      && document.documentElement.dataset.screen === 'library') {
      e.preventDefault();
      el.librarySearch?.focus();
      el.librarySearch?.select();
    }
  });

  setupMinimalLayout();

  // --- Settings section navigation ----------------------------------------
  const settingsNavItems = document.querySelectorAll<HTMLButtonElement>('.settings-nav-item');
  const setSettingsSection = (target: string) => {
    settingsNavItems.forEach(n => n.classList.toggle('active', n.dataset.settingsTarget === target));
    const section = document.getElementById(target);
    section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  settingsNavItems.forEach(item => {
    item.addEventListener('click', () => {
      const target = item.dataset.settingsTarget || '';
      if (target === 'reading' || target === 'voices') {
        if (!currentBookRecord) { toast('Open a book to adjust reading style and voices'); return; }
        el.settingsModal.hidden = true;
        openDrawer('typography');
        return;
      }
      setSettingsSection(target);
    });
  });

  // Save Article (web page → reader mode)
  el.importUrlBtn.addEventListener('click', openUrlImportModal);
  el.closeUrlImportBtn.addEventListener('click', closeUrlImportModal);
  el.urlImportModal.addEventListener('click', (e) => {
    if (e.target === el.urlImportModal) closeUrlImportModal();
  });
  el.urlImportForm.addEventListener('submit', (e) => {
    e.preventDefault();
    saveArticleFromUrl(el.urlImportInput.value);
  });
  el.openOriginalBtn.addEventListener('click', () => {
    if (currentBookRecord?.sourceUrl) openUrl(currentBookRecord.sourceUrl);
  });

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
  el.pdfZoomOutBtn.addEventListener('click', () => setPdfZoom(currentPdfZoom - 10));
  el.pdfZoomInBtn.addEventListener('click', () => setPdfZoom(currentPdfZoom + 10));
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
  el.ttsPrevBtn.addEventListener('click', (e) => stepTts(-1, e.shiftKey ? 'paragraph' : 'sentence'));
  el.ttsNextBtn.addEventListener('click', (e) => stepTts(+1, e.shiftKey ? 'paragraph' : 'sentence'));
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

  // Extra speaking controls
  syncTtsTuneUi();
  el.ttsTuneBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleTtsTune(); });
  el.ttsTune.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', (e) => {
    if (el.ttsTune.hidden) return;
    if (!el.ttsTune.contains(e.target as Node) && !el.ttsTuneBtn.contains(e.target as Node)) closeTtsTune();
  });
  el.ttsVolume.addEventListener('input', () => setTtsVolume(parseFloat(el.ttsVolume.value), false));
  el.ttsVolume.addEventListener('change', () => setTtsVolume(parseFloat(el.ttsVolume.value), true));
  el.ttsPitch.addEventListener('input', () => setTtsPitch(parseFloat(el.ttsPitch.value), false));
  el.ttsPitch.addEventListener('change', () => setTtsPitch(parseFloat(el.ttsPitch.value), true));
  el.ttsPauses.addEventListener('input', () => setTtsPauseScale(parseFloat(el.ttsPauses.value)));
  el.ttsExpr.addEventListener('input', () => setTtsExpressiveness(parseFloat(el.ttsExpr.value)));
  el.ttsSleep.addEventListener('change', () => setTtsSleep(parseInt(el.ttsSleep.value, 10) || 0));

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

  // Local AI (Settings modal section)
  el.llmOpenFolderBtn.addEventListener('click', async () => {
    if (!llmStatus) return;
    const folder = llmStatus.models_dir.replace(/[\\/]models$/i, '');
    try {
      await openPath(folder);
    } catch (err) {
      console.warn('openPath failed:', err);
      try {
        await navigator.clipboard.writeText(folder);
        toast('Path copied to clipboard');
      } catch { toast(`Path: ${folder}`); }
    }
  });
  el.llmRefreshBtn.addEventListener('click', async () => {
    el.llmBinaryStatus.textContent = 'Checking…';
    el.llmModelsStatus.textContent = 'Checking…';
    await refreshLlmStatus();
    renderLlmSetupSection();
  });
  el.llmInstallBinaryBtn.addEventListener('click', installLlmBinary);
  el.llmCancelBinaryBtn.addEventListener('click', cancelLlmBinaryInstall);
  el.llmErrorDismiss.addEventListener('click', hideLlmError);
  el.llmCustomInstallBtn.addEventListener('click', () => { void installLlmCustomModel(); });
  el.llmCustomUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); void installLlmCustomModel(); }
  });

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
  el.vocabSkipBtn.addEventListener('click', skipReviewCard);
  el.vocabDeleteBtn.addEventListener('click', removeCurrentReviewCard);
  el.vocabRateActions.querySelectorAll<HTMLButtonElement>('.vocab-rate-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const rating = parseInt(btn.dataset.rating || '3', 10) as 1 | 3 | 5;
      rateReviewCard(rating);
    });
  });

  // PDF dictionary (clipboard-driven — see lookupWordFromPdfClipboard)
  el.pdfDictBtn.addEventListener('click', lookupWordFromPdfClipboard);

  // Chat
  el.chatBtn.addEventListener('click', openChat);
  el.closeChatBtn.addEventListener('click', closeChat);
  el.chatModal.addEventListener('click', (e) => {
    if (e.target === el.chatModal) closeChat();
  });
  el.chatResetBtn.addEventListener('click', resetChat);
  el.chatModelSelect.addEventListener('change', () => {
    llmModelPath = el.chatModelSelect.value;
    persistLlmModel();
  });
  el.chatSendBtn.addEventListener('click', () => { void sendChatMessage(); });
  el.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendChatMessage();
    }
  });
  // Auto-grow the textarea up to the CSS max-height (120px), then let it
  // scroll internally — matches .chat-input's `resize: none`.
  el.chatInput.addEventListener('input', () => {
    el.chatInput.style.height = 'auto';
    el.chatInput.style.height = `${Math.min(el.chatInput.scrollHeight, 120)}px`;
  });
  el.chatScopeToggle.querySelectorAll<HTMLButtonElement>('button').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.value as 'page' | 'chapter';
      if (chatScope === v) return;
      chatScope = v;
      el.chatScopeToggle.querySelectorAll<HTMLButtonElement>('button').forEach(b => {
        b.classList.toggle('active', b === btn);
      });
      el.chatTruncatedNote.hidden = true;
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
        if (control === 'measure' && v) settings.measure = v as MeasureKind;
        if (control === 'ruler' && v)   settings.readingRuler = v === 'on';
        if (control === 'focusTracker' && v) settings.focusTracker = v as FocusTracker;
        if (control === 'paragraph' && v) settings.paragraph = v as ParagraphKind;
        if (control === 'justify' && v) settings.justify = v === 'on';
        if (control === 'preset' && v && v in READING_PRESETS) {
          Object.assign(settings, READING_PRESETS[v as ReadingProfile]);
        }
        if (control === 'quicktheme' && v && QUICK_THEMES[v]) {
          settings.theme = QUICK_THEMES[v].theme;
          settings.appearance = QUICK_THEMES[v].appearance;
        }
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

  // Night-comfort sliders — warmth (amber tint) and brightness (dimming).
  el.warmthSlider.addEventListener('input', () => {
    settings.warmth = parseInt(el.warmthSlider.value, 10) || 0;
    persistSettings();
    applyComfortSettings();
    el.warmthValue.textContent = settings.warmth === 0 ? 'Off' : `${settings.warmth}%`;
  });
  el.brightnessSlider.addEventListener('input', () => {
    settings.brightness = parseInt(el.brightnessSlider.value, 10) || 100;
    persistSettings();
    applyComfortSettings();
    el.brightnessValue.textContent = `${settings.brightness}%`;
  });

  // Reading ruler follows the cursor. Content in the main document (text/MD
  // readers, the general window) is tracked here; epub content lives in
  // iframes and is tracked from installFocusTracker with translated coords.
  document.addEventListener('mousemove', (e) => moveRuler(e.clientY));
  document.addEventListener('mouseleave', () => { el.readingRuler.style.opacity = '0'; });

  el.returnPill.addEventListener('click', () => {
    const cfi = returnCfi;
    hideReturnPill();
    if (cfi && currentRendition) currentRendition.display(cfi);
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
    // progressFill's width is kept in sync with the real position for every
    // format (EPUB's relocated handler, text/md's scroll listener, PDF's
    // updatePdfProgressUi) — reuse it instead of re-deriving from an
    // EPUB-only API, so the thumb snaps back correctly everywhere.
    el.progressThumb.style.left = el.progressFill.style.width;
  });

  // Selection popover buttons
  el.selectionPopover.querySelectorAll<HTMLButtonElement>('.hl-swatch').forEach(sw => {
    sw.addEventListener('click', () => addHighlight(sw.dataset.color as HighlightColor));
  });
  el.popoverRemove.addEventListener('click', removePendingHighlight);
  el.popoverLookup.addEventListener('click', () => {
    const word = pendingSelectionText;
    if (!word) return;
    // Swap this popover for the dictionary card; keep the selection itself.
    el.selectionPopover.hidden = true;
    hideDictPopover();
    hideFootnotePopover();
    const id = ++dictionaryLookupId;
    void lookupWord(word, selAnchorX, selAnchorY, id);
  });
  el.popoverSay.addEventListener('click', () => sayWord(pendingSelectionText, el.popoverSay));

  // Explicit close buttons on info popovers
  el.dictClose.addEventListener('click', (e) => {
    e.stopPropagation();
    hideDictPopover();
  });
  el.dictAiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dictAi.explain();
  });
  el.dictAiRetry.addEventListener('click', (e) => {
    e.stopPropagation();
    dictAi.explain();
  });
  el.dictAiExamplesBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dictAi.examples();
  });
  el.vocabAiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    vocabAi.explain();
  });
  el.vocabAiRetry.addEventListener('click', (e) => {
    e.stopPropagation();
    vocabAi.explain();
  });
  el.vocabAiExamplesBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    vocabAi.examples();
  });
  el.dictVocabBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleVocabCandidate();
  });
  el.dictPronounceBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    pronounceWord(el.dictPronounceBtn.dataset.word || '', el.dictPronounceBtn);
  });
  el.vocabPronounceBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    pronounceWord(el.vocabPronounceBtn.dataset.word || '', el.vocabPronounceBtn);
  });
  el.footnoteClose.addEventListener('click', (e) => {
    e.stopPropagation();
    hideFootnotePopover();
  });

  // Dictionary lookup for the Text/Markdown reader (see onTextReaderMouseUp).
  // Registered once, globally — it no-ops whenever currentTextElement isn't
  // mounted, so it's safe regardless of which screen/format is active.
  document.addEventListener('mouseup', onTextReaderMouseUp);

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
      if (e.key === 'ArrowLeft')  { stepTts(-1, e.shiftKey ? 'paragraph' : 'sentence'); return; }
      if (e.key === 'ArrowRight') { stepTts(+1, e.shiftKey ? 'paragraph' : 'sentence'); return; }
    }

    if (e.key === 'ArrowLeft' || e.key === 'PageUp')  navGo('prev');
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') navGo('next');
    if (e.key === 'b' || e.key === 'B') toggleBookmark();
    if (e.key === 't' || e.key === 'T') cycleTheme();

    // Vim-style navigation: h/k step back a page, j/l step forward — this
    // way both the "left/right = back/forward" and "down = forward, up =
    // back" mental models work. gg jumps to the start of the book, G to
    // the end.
    if (e.key === 'h' || e.key === 'k') vimPageNav('prev');
    if (e.key === 'j' || e.key === 'l') vimPageNav('next');
    if (e.key === 'g') {
      const now = Date.now();
      if (now - lastGKeydownAt < GG_CHORD_WINDOW_MS) {
        lastGKeydownAt = 0;
        vimGoToStart();
      } else {
        lastGKeydownAt = now;
      }
    } else if (e.key === 'G') {
      lastGKeydownAt = 0;
      vimGoToEnd();
    }

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
  el.openSettingsBtn.addEventListener('click', openSettings);
  el.librarySettingsBtn.addEventListener('click', openSettings);

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
   Minimal layout — text-only reader driven by a "/" command bar
   ============================================================ */
interface CmdItem { label: string; key: string; run: () => void; show?: () => boolean; }

let cmdbarIndex = 0;

function isMinimalLayout(): boolean { return settings.uiLayout === 'minimal'; }

function setUiLayout(layout: 'standard' | 'minimal') {
  settings.uiLayout = layout;
  persistSettings();
  applyGlobalTheme();
  closeCmdbar();
  requestReflow();
}

function cmdbarItems(): CmdItem[] {
  const items: CmdItem[] = [
    { label: 'Listen', key: 'L', run: () => el.ttsBtn.click() },
    { label: 'Contents', key: 'C', run: () => openDrawer('toc', 'toc') },
    { label: 'Bookmark this page', key: 'B', run: () => toggleBookmark() },
    { label: 'Highlights and notes', key: 'H', run: () => openDrawer('toc', 'highlights') },
    { label: 'Focus reading', key: 'F', run: () => el.focusModeBtn.click() },
    { label: 'Ask about this book', key: 'Q', run: () => el.chatBtn.click(), show: () => !el.chatBtn.hidden },
    { label: 'Review vocabulary', key: 'V', run: () => el.libraryVocabReviewBtn.click() },
    { label: 'Back to library', key: 'Esc', run: () => el.backBtn.click() },
  ];
  return items.filter(i => !i.show || i.show());
}

function filteredCmdItems(): CmdItem[] {
  const q = el.cmdbarInput.value.trim().toLowerCase();
  const all = cmdbarItems();
  return q ? all.filter(i => i.label.toLowerCase().includes(q)) : all;
}

function renderCmdbar() {
  const items = filteredCmdItems();
  cmdbarIndex = Math.max(0, Math.min(cmdbarIndex, items.length - 1));
  el.cmdbarList.innerHTML = '';
  items.forEach((item, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'cmdbar-item' + (i === cmdbarIndex ? ' active' : '');
    const label = document.createElement('span');
    label.textContent = item.label;
    const key = document.createElement('kbd');
    key.textContent = item.key;
    row.append(label, key);
    row.addEventListener('mousemove', () => {
      if (cmdbarIndex === i) return;
      cmdbarIndex = i;
      el.cmdbarList.querySelectorAll('.cmdbar-item').forEach((n, j) => n.classList.toggle('active', j === i));
    });
    row.addEventListener('click', () => runCmd(item));
    el.cmdbarList.appendChild(row);
  });
  // Typeface / size / theme radios mirror the live settings.
  const mark = (attr: string, value: string, on: boolean) => {
    const b = el.cmdbar.querySelector<HTMLButtonElement>(`[data-cmd-${attr}="${value}"]`);
    if (!b) return;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  };
  mark('font', 'serif', settings.font !== 'sans');
  mark('font', 'sans', settings.font === 'sans');
  mark('size', 'small', settings.sizePct < 100);
  mark('size', 'large', settings.sizePct >= 100);
  mark('appearance', 'light', settings.appearance === 'light');
  mark('appearance', 'dark', settings.appearance === 'dark');
}

function openCmdbar() {
  if (!isMinimalLayout() || el.html.dataset.screen !== 'reader') return;
  const rec = currentBookRecord;
  el.cmdbarTitle.textContent = rec?.title || 'Untitled';
  const pct = Math.round((rec?.progress || 0) * 100);
  const parts = [el.progressChapter.textContent?.trim(), `${el.progressPercent.textContent?.trim() || pct + '%'}`, el.progressRemaining.textContent?.trim()]
    .filter(s => s && s !== '—');
  el.cmdbarSub.textContent = parts.join(' · ');
  el.cmdbarInput.value = '';
  cmdbarIndex = 0;
  el.cmdbar.hidden = false;
  renderCmdbar();
  el.cmdbarInput.focus();
}

function closeCmdbar() {
  if (el.cmdbar.hidden) return;
  el.cmdbar.hidden = true;
  el.cmdbarInput.blur();
}

function runCmd(item: CmdItem) {
  closeCmdbar();
  item.run();
}

function setupMinimalLayout() {
  // Settings toggle
  document.querySelectorAll<HTMLButtonElement>('[data-ui-layout]').forEach(b => {
    b.addEventListener('click', () => setUiLayout(b.dataset.uiLayout === 'minimal' ? 'minimal' : 'standard'));
  });

  // Library chrome
  el.minSettingsBtn.addEventListener('click', openSettings);
  el.minVocabLink.addEventListener('click', (e) => { e.preventDefault(); el.libraryVocabReviewBtn.click(); });
  el.minAddBook.addEventListener('click', (e) => { e.preventDefault(); el.importBtn.click(); });
  el.minSaveArticle.addEventListener('click', (e) => { e.preventDefault(); openUrlImportModal(); });
  // The "Reading" block resumes the current book when its title is clicked.
  el.continueHeading.parentElement?.addEventListener('click', () => el.continueResumeBtn.click());
  // Pasting a link into the minimal search field and pressing Enter saves it as an article.
  el.librarySearch.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !isMinimalLayout()) return;
    const v = el.librarySearch.value.trim();
    if (/^https?:\/\/\S+$/i.test(v)) {
      e.preventDefault();
      el.librarySearch.value = '';
      libraryQuery = '';
      renderLibrary();
      void saveArticleFromUrl(v);
    }
  });

  // Reader: hairline progress mirrors the regular progress fill.
  const syncProgress = () => {
    const w = el.progressFill.style.width || '0%';
    el.minProgressFill.style.width = w;
    el.minProgress.setAttribute('aria-valuenow', String(Math.round(parseFloat(w) || 0)));
  };
  new MutationObserver(syncProgress).observe(el.progressFill, { attributes: true, attributeFilter: ['style'] });
  syncProgress();

  // Command bar
  el.minMenuBtn.addEventListener('click', openCmdbar);
  el.cmdbar.addEventListener('mousedown', (e) => { if (e.target === el.cmdbar) closeCmdbar(); });
  el.cmdbarInput.addEventListener('input', () => { cmdbarIndex = 0; renderCmdbar(); });
  el.cmdbarMore.addEventListener('click', (e) => { e.preventDefault(); closeCmdbar(); openDrawer('typography'); });
  el.cmdbar.querySelectorAll<HTMLButtonElement>('[data-cmd-font]').forEach(b => b.addEventListener('click', () => {
    settings.font = b.dataset.cmdFont === 'sans' ? 'sans' : 'serif';
    persistSettings(); applyReaderSettings(); renderCmdbar();
  }));
  el.cmdbar.querySelectorAll<HTMLButtonElement>('[data-cmd-size]').forEach(b => b.addEventListener('click', () => {
    settings.sizePct = b.dataset.cmdSize === 'small' ? 90 : 115;
    persistSettings(); applyReaderSettings(); renderCmdbar();
  }));
  el.cmdbar.querySelectorAll<HTMLButtonElement>('[data-cmd-appearance]').forEach(b => b.addEventListener('click', () => {
    settings.appearance = b.dataset.cmdAppearance === 'dark' ? 'dark' : 'light';
    persistSettings(); applyGlobalTheme(); applyReaderSettings(); renderCmdbar();
  }));

  el.cmdbarInput.addEventListener('keydown', (e) => {
    const items = filteredCmdItems();
    if (e.key === 'ArrowDown') { e.preventDefault(); cmdbarIndex = (cmdbarIndex + 1) % Math.max(1, items.length); renderCmdbar(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cmdbarIndex = (cmdbarIndex - 1 + items.length) % Math.max(1, items.length); renderCmdbar(); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = items[cmdbarIndex]; if (it) runCmd(it); }
    else if (!el.cmdbarInput.value && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Single-letter shortcuts work while the bar is open and the field is empty.
      const hit = items.find(i => i.key.toLowerCase() === e.key.toLowerCase());
      if (hit) {
        e.preventDefault();
        // The reader also listens for this letter on keyup — swallow it so F/B/R don't fire twice.
        window.addEventListener('keyup', (ke) => ke.stopPropagation(), { capture: true, once: true });
        runCmd(hit);
      }
    }
  });

  // "/" opens the bar from the reader; Esc closes it (capture so it beats the reader's own handlers).
  document.addEventListener('keydown', (e) => {
    if (!isMinimalLayout()) return;
    if (e.key === 'Escape' && !el.cmdbar.hidden) {
      e.preventDefault(); e.stopPropagation(); closeCmdbar(); return;
    }
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && el.cmdbar.hidden
        && el.html.dataset.screen === 'reader') {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault(); openCmdbar();
    }
  }, true);
}

/* ============================================================
   Boot
   ============================================================ */
function boot() {
  applyGlobalTheme();
  applyComfortSettings();
  refreshTypographyUI();
  wire();
  // Text/md content renders straight into the main document (no per-section
  // iframe like epub gets), so this installs once for the app's lifetime —
  // it scopes itself to the live currentTextElement internally and is inert
  // whenever no text/md book is open (see installFocusTracker's isMainDoc gate).
  installFocusTracker(document, null);
  goToScreen('library');
  updateStatsUI();
  document.querySelectorAll<HTMLElement>('.theme-card').forEach(c => {
    c.classList.toggle('active', c.dataset.themeVal === settings.theme);
  });
  // Probe for a local LLM in the background — never block startup on it.
  // If nothing's installed, isLlmReady() stays false and the AI button
  // simply never appears. The chat toolbar button (unlike the per-lookup
  // AI buttons) is persistent chrome, so it needs an explicit refresh once
  // the probe resolves.
  refreshLlmStatus().then(() => refreshChatButtonVisibility());
}

boot();
