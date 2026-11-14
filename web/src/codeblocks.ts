/* ==========================================================================
   Code blocks — syntax highlighting + a generic code-block frame.

   Used by the Markdown / text reader (which also renders saved web articles,
   since those are stored as Markdown). Two halves:

   1. Import side (web pages):
        prepareCodeForImport(doc)   run on the parsed page BEFORE Readability
        addCodeFenceRule(turndown)  makes Turndown emit ```lang fences
      Readability strips class names, so the language is captured up front into
      a data-lang attribute and the code text is flattened (no per-line <div>s,
      gutters or highlight spans) so it survives as plain, correct text.

   2. Render side:
        enhanceCodeBlocks(root)     wraps every <pre> in a frame (language
      label, copy button, wrap toggle) and, where it can, colours the code
      with highlight.js. Languages load lazily, one small chunk each, so none
      of this costs anything until a page actually contains code.

   The frame deliberately has no visible text nodes of its own (label comes
   from a CSS ::before, buttons are icon-only) so read-aloud and focus mode
   never pick up "Copy" or the language name.
   ========================================================================== */

type HljsCore = typeof import('highlight.js/lib/core').default;

/* ------------------------------ languages ------------------------------ */

const ALIASES: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', node: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', python3: 'python',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', terminal: 'bash', shellsession: 'bash',
  ps1: 'powershell', pwsh: 'powershell',
  yml: 'yaml',
  html: 'xml', htm: 'xml', svg: 'xml', vue: 'xml', xhtml: 'xml', rss: 'xml',
  'c++': 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', h: 'c',
  'c#': 'csharp', cs: 'csharp',
  rs: 'rust', golang: 'go', kt: 'kotlin', rb: 'ruby',
  md: 'markdown', toml: 'ini', conf: 'ini',
  docker: 'dockerfile', patch: 'diff',
  postgres: 'sql', postgresql: 'sql', mysql: 'sql', sqlite: 'sql',
  jsonc: 'json', json5: 'json',
};

// Plain-text style labels: show the frame, skip colouring.
const NO_HIGHLIGHT = new Set(['text', 'txt', 'plain', 'plaintext', 'none', 'output', 'log', 'nohighlight']);

const LOADERS: Record<string, () => Promise<{ default: any }>> = {
  javascript: () => import('highlight.js/lib/languages/javascript'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  json: () => import('highlight.js/lib/languages/json'),
  xml: () => import('highlight.js/lib/languages/xml'),
  css: () => import('highlight.js/lib/languages/css'),
  scss: () => import('highlight.js/lib/languages/scss'),
  python: () => import('highlight.js/lib/languages/python'),
  bash: () => import('highlight.js/lib/languages/bash'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  rust: () => import('highlight.js/lib/languages/rust'),
  go: () => import('highlight.js/lib/languages/go'),
  java: () => import('highlight.js/lib/languages/java'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  php: () => import('highlight.js/lib/languages/php'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  swift: () => import('highlight.js/lib/languages/swift'),
  sql: () => import('highlight.js/lib/languages/sql'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  diff: () => import('highlight.js/lib/languages/diff'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  ini: () => import('highlight.js/lib/languages/ini'),
  lua: () => import('highlight.js/lib/languages/lua'),
};

// Cheap structural checks that beat the generic detector for two common cases.
function sniffLang(text: string): string {
  const t = text.trim();
  if (/^[{[]/.test(t)) {
    try { JSON.parse(t); return 'json'; } catch { /* not JSON */ }
  }
  const lines = t.split('\n').filter(l => l.trim());
  if (lines.length > 0 && lines.filter(l => /^\s*[$>]\s+\S/.test(l)).length >= Math.ceil(lines.length / 2)) return 'bash';
  return '';
}

// Candidate set for blocks that don't say what language they are.
const AUTO_CANDIDATES = ['javascript', 'typescript', 'python', 'bash', 'json', 'xml', 'css', 'java', 'c', 'cpp', 'go', 'rust', 'sql', 'yaml'];
const AUTO_MIN_RELEVANCE = 4;      // below this the guess is noise — leave it uncoloured
const MAX_HIGHLIGHT_CHARS = 30_000;

export function normalizeLang(raw: string | null | undefined): string {
  if (!raw) return '';
  let l = raw.toLowerCase().trim().split(/[\s,{]/)[0];
  l = l.replace(/^(language|lang|highlight-source|brush:?)[-_:]?/, '').replace(/^[-_:]+/, '');
  return ALIASES[l] ?? l;
}

/** Language hint from class names / data attributes on the given elements. */
function detectLang(...els: Array<Element | null | undefined>): string {
  for (const el of els) {
    if (!el) continue;
    const data = el.getAttribute('data-lang') || el.getAttribute('data-language');
    if (data) return normalizeLang(data);
    const cls = typeof el.className === 'string' ? el.className : '';
    // language-js · lang-js · highlight-source-js · brush: js · sourceCode js
    const m = cls.match(/(?:^|\s)(?:language|lang|highlight-source|brush:?)[-_:\s]?([\w+#.-]+)/i)
      || cls.match(/(?:^|\s)sourceCode\s+([\w+#-]+)/i);
    if (m) return normalizeLang(m[1]);
  }
  return '';
}

let corePromise: Promise<HljsCore> | null = null;
function getHljs(): Promise<HljsCore> {
  corePromise ??= import('highlight.js/lib/core').then(m => m.default);
  return corePromise;
}

async function ensureLanguage(hljs: HljsCore, name: string): Promise<boolean> {
  if (hljs.getLanguage(name)) return true;
  const load = LOADERS[name];
  if (!load) return false;
  try {
    const mod = await load();
    hljs.registerLanguage(name, mod.default);
    return true;
  } catch (err) {
    console.warn(`highlight.js: could not load "${name}"`, err);
    return false;
  }
}

/* -------------------------- import (web pages) -------------------------- */

const GUTTER_SELECTOR =
  '.line-numbers-rows, .linenumber, .line-number, .line-numbers, .lineno, .gutter, td.hljs-ln-numbers, [class*="line-num"], [data-line-number]';

// Plain text of a <pre>, whatever highlighter or line wrapper the site used.
function extractPreText(pre: Element): string {
  const clone = pre.cloneNode(true) as Element;
  clone.querySelectorAll(GUTTER_SELECTOR).forEach(n => n.remove());
  clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
  let text = clone.textContent ?? '';
  // Line-per-element markup (GitHub, Prism line-numbers, tables): the newlines
  // live between elements, so rebuild them.
  if (!text.includes('\n')) {
    const lines = clone.querySelectorAll('.line, .code-line, [class*="CodeLine"], tr, li');
    if (lines.length > 1) text = Array.from(lines, l => l.textContent ?? '').join('\n');
  }
  return text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
}

/**
 * Run on the parsed page before Readability: record each block's language and
 * flatten it to <pre data-lang><code>plain text</code></pre>.
 */
export function prepareCodeForImport(doc: Document): void {
  doc.querySelectorAll('pre').forEach(pre => {
    const code = pre.querySelector('code');
    // Sites often put the language on a wrapper (GitHub: div.highlight-source-js).
    const wrapper = pre.parentElement;
    const lang = detectLang(pre, code, wrapper, wrapper?.parentElement);
    const text = extractPreText(pre);
    if (!text.trim()) return;
    const flat = doc.createElement('code');
    flat.textContent = text;
    pre.replaceChildren(flat);
    pre.removeAttribute('class');
    if (lang) pre.setAttribute('data-lang', lang);
  });
}

type TurndownLike = {
  addRule: (key: string, rule: {
    filter: (node: any) => boolean;
    replacement: (content: string, node: any) => string;
  }) => unknown;
};

/** Make Turndown emit ```lang fences (and use a fence longer than any backticks inside). */
export function addCodeFenceRule(turndown: TurndownLike): void {
  turndown.addRule('fencedCodeWithLang', {
    filter: node => node.nodeName === 'PRE',
    replacement: (_content, node) => {
      const text = ((node.textContent as string) ?? '').replace(/\n+$/, '');
      const lang = normalizeLang(node.getAttribute?.('data-lang')) || detectLang(node.querySelector?.('code'));
      const runs = text.match(/`+/g) ?? [];
      const fence = '`'.repeat(Math.max(3, ...runs.map(r => r.length + 1)));
      return `\n\n${fence}${lang}\n${text}\n${fence}\n\n`;
    },
  });
}

/* ------------------------------- rendering ------------------------------ */

const ICON_COPY =
  '<svg class="icon-copy" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>' +
  '<svg class="icon-done" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const ICON_WRAP =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M3 12h14a3 3 0 0 1 0 6h-4m0 0 2-2m-2 2 2 2M3 18h5"/></svg>';

function buildFrame(pre: HTMLElement, label: string): HTMLElement {
  const frame = document.createElement('div');
  frame.className = 'code-block';

  const head = document.createElement('div');
  head.className = 'code-block-head';

  const lang = document.createElement('span');
  lang.className = 'code-block-lang';
  lang.setAttribute('data-lang', label || 'code');

  const tools = document.createElement('div');
  tools.className = 'code-block-tools';

  const wrap = document.createElement('button');
  wrap.type = 'button';
  wrap.className = 'code-btn';
  wrap.dataset.act = 'wrap';
  wrap.title = 'Wrap long lines';
  wrap.setAttribute('aria-label', 'Wrap long lines');
  wrap.innerHTML = ICON_WRAP;

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'code-btn';
  copy.dataset.act = 'copy';
  copy.title = 'Copy code';
  copy.setAttribute('aria-label', 'Copy code');
  copy.innerHTML = ICON_COPY;

  tools.append(wrap, copy);
  head.append(lang, tools);

  pre.replaceWith(frame);
  frame.append(head, pre);
  return frame;
}

const boundRoots = new WeakSet<HTMLElement>();

function bindFrameActions(root: HTMLElement): void {
  if (boundRoots.has(root)) return;
  boundRoots.add(root);
  root.addEventListener('click', async (e) => {
    const btn = (e.target as Element | null)?.closest<HTMLButtonElement>('.code-btn');
    if (!btn || !root.contains(btn)) return;
    const frame = btn.closest<HTMLElement>('.code-block');
    if (!frame) return;
    e.stopPropagation();
    if (btn.dataset.act === 'wrap') {
      btn.classList.toggle('active', frame.classList.toggle('wrap'));
      return;
    }
    const code = frame.querySelector('pre')?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(code);
      btn.classList.add('copied');
      btn.title = 'Copied!';
      window.setTimeout(() => { btn.classList.remove('copied'); btn.title = 'Copy code'; }, 1500);
    } catch (err) {
      console.warn('copy failed', err);
    }
  });
}

/**
 * Wrap every code block under `root` in the frame, then colour it. The frame is
 * added synchronously (stable layout); colouring follows asynchronously and
 * only changes markup inside the block, never its text.
 */
export async function enhanceCodeBlocks(root: HTMLElement): Promise<void> {
  bindFrameActions(root);
  const pres = Array.from(root.querySelectorAll<HTMLElement>('pre')).filter(p => !p.closest('.code-block'));
  if (pres.length === 0) return;

  const jobs: Array<{ code: HTMLElement; label: HTMLElement; lang: string; text: string }> = [];
  for (const pre of pres) {
    const code = pre.querySelector<HTMLElement>('code') ?? pre;
    const lang = detectLang(code, pre) || sniffLang(code.textContent ?? '');
    const frame = buildFrame(pre, lang);
    jobs.push({
      code,
      label: frame.querySelector<HTMLElement>('.code-block-lang')!,
      lang,
      text: code.textContent ?? '',
    });
  }

  let hljs: HljsCore;
  try { hljs = await getHljs(); } catch (err) { console.warn('highlight.js unavailable', err); return; }

  for (const job of jobs) {
    if (!job.code.isConnected) continue;      // the page was re-rendered meanwhile
    const { text } = job;
    if (!text.trim() || text.length > MAX_HIGHLIGHT_CHARS || NO_HIGHLIGHT.has(job.lang)) continue;
    try {
      let result: { value: string; language?: string } | null = null;
      if (job.lang) {
        if (await ensureLanguage(hljs, job.lang)) {
          result = hljs.highlight(text, { language: job.lang, ignoreIllegals: true });
        }
      } else if (text.length >= 30 && text.includes('\n') || text.length >= 80) {
        await Promise.all(AUTO_CANDIDATES.map(l => ensureLanguage(hljs, l)));
        const guess = hljs.highlightAuto(text, AUTO_CANDIDATES.filter(l => hljs.getLanguage(l)));
        if (guess.language && guess.relevance >= AUTO_MIN_RELEVANCE) {
          result = guess;
          job.label.setAttribute('data-lang', guess.language);
        }
      }
      if (result) {
        job.code.innerHTML = result.value;      // hljs output is HTML-escaped
        job.code.classList.add('hljs');
      }
    } catch (err) {
      console.warn('highlight failed', err);
    }
  }
}
