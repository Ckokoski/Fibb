/**
 * Tool shelf safety checker.
 *
 * Fibb can write an author a tiny helper tool (a bookmarklet, a small unpacked
 * Chrome extension, or a Google Apps Script). That code runs in the author's
 * browser or Google account, so before it is ever shown it must pass this
 * static check. The check is pure (no I/O) and fails closed: anything it does
 * not understand is refused.
 *
 * How it works:
 *  1. Normalize: control characters, bidi and zero-width characters, `\u` and
 *     `\x` escapes and very long lines are refused outright.
 *  2. Raw scan: distinctive API names and secret-ish words are refused
 *     anywhere in the text, comments and strings included, so a tokenizer
 *     mistake can never hide them. The scan also runs on a copy with block
 *     comments removed and adjacent string pieces joined ('fe' + 'tch').
 *  3. Token scan: a small comment, string, template and regex aware tokenizer
 *     feeds structural rules (what may follow `window`, `document`,
 *     `navigator`, `chrome`; which elements may be created; no computed
 *     property access; no string timers; and so on).
 *  4. Kind rules: manifest, HTML and CSS for extensions; services for Apps
 *     Script.
 *
 * It is not a parser and not a sandbox. See the notes at the bottom of the
 * file for what it cannot see.
 */

export type ToolKind = 'bookmarklet' | 'extension' | 'apps-script';
export const TOOL_KINDS: ToolKind[] = ['bookmarklet', 'extension', 'apps-script'];

export interface ToolFile { path: string; content: string }
export interface CheckOptions {
  /** The author explicitly asked for a tool that runs on every page. */
  allowAllPages?: boolean;
}
export interface CheckResult {
  ok: boolean;
  /** Short, plain reasons for the author. Empty when ok. */
  reasons: string[];
  /** What the tool can touch, in plain words. Always ends with "Sends nothing anywhere". */
  access: string[];
  /** Allowed but worth knowing. */
  warnings: string[];
  /** Exact findings, for telling the model what to fix. Not shown to the author. */
  details: string[];
}

// ── The allowed surface. The prompt in tool-shelf.ts is built from these. ──

export const LIMITS: Record<ToolKind, { files: number; fileBytes: number; totalBytes: number }> = {
  bookmarklet: { files: 1, fileBytes: 6 * 1024, totalBytes: 6 * 1024 },
  extension: { files: 6, fileBytes: 20 * 1024, totalBytes: 60 * 1024 },
  'apps-script': { files: 1, fileBytes: 20 * 1024, totalBytes: 20 * 1024 },
};
export const MAX_LINE_CHARS = 2000;

export const ALLOWED_ELEMENTS = [
  'mark', 'div', 'span', 'p', 'ul', 'ol', 'li', 'b', 'i', 'em', 'strong', 'style', 'button',
  'table', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'pre', 'small', 'br', 'hr',
];
export const ALLOWED_STYLE_PROPS = [
  'color', 'backgroundColor', 'display', 'position', 'top', 'left', 'right', 'bottom', 'width', 'height',
  'maxWidth', 'maxHeight', 'minWidth', 'minHeight', 'padding', 'paddingTop', 'paddingRight', 'paddingBottom',
  'paddingLeft', 'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'border', 'borderTop',
  'borderRight', 'borderBottom', 'borderLeft', 'borderRadius', 'borderColor', 'borderWidth', 'borderStyle',
  'borderCollapse', 'font', 'fontSize', 'fontWeight', 'fontFamily', 'fontStyle', 'lineHeight', 'textAlign',
  'textDecoration', 'textTransform', 'letterSpacing', 'whiteSpace', 'wordBreak', 'overflowWrap', 'zIndex',
  'opacity', 'overflow', 'overflowX', 'overflowY', 'boxShadow', 'boxSizing', 'outline', 'pointerEvents',
  'transition', 'transform', 'visibility', 'gap', 'flex', 'flexDirection', 'flexWrap', 'alignItems',
  'justifyContent', 'userSelect', 'verticalAlign',
];
export const ALLOWED_SET_ATTRIBUTES = ['class', 'id', 'title', 'role', 'tabindex', 'lang', 'dir', 'hidden'];
export const ALLOWED_WINDOW_MEMBERS = [
  'document', 'getSelection', 'innerWidth', 'innerHeight', 'scrollX', 'scrollY', 'pageXOffset', 'pageYOffset',
  'scrollTo', 'scrollBy', 'getComputedStyle', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'addEventListener', 'removeEventListener', 'alert',
  'confirm', 'prompt', 'navigator', 'console', 'matchMedia', 'devicePixelRatio',
];
export const ALLOWED_DOCUMENT_MEMBERS = [
  'body', 'head', 'documentElement', 'title', 'getElementById', 'getElementsByClassName', 'getElementsByTagName',
  'querySelector', 'querySelectorAll', 'createElement', 'createTextNode', 'createDocumentFragment',
  'createTreeWalker', 'createRange', 'getSelection', 'addEventListener', 'removeEventListener',
  'activeElement', 'readyState', 'hasFocus', 'scrollingElement',
];
export const ALLOWED_CHROME_CALLS = ['chrome.tabs.query', 'chrome.scripting.executeScript'];
export const ALLOWED_MANIFEST_KEYS = ['manifest_version', 'name', 'version', 'description', 'action', 'permissions', 'content_scripts', 'icons'];
export const ALLOWED_PERMISSIONS = ['activeTab', 'scripting'];
export const ALLOWED_APPS_SCRIPT_SERVICES = ['DocumentApp', 'SpreadsheetApp', 'SlidesApp', 'Utilities', 'Logger', 'console', 'HtmlService'];
export const ALLOWED_UTILITIES = ['formatDate', 'formatString'];
export const EXTENSION_FILE_TYPES = ['.json', '.js', '.html', '.css'];

/** Words refused anywhere in the code, comments and text included (case-sensitive). */
export const FORBIDDEN_NAMES = {
  network: [
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'importScripts', 'WebTransport',
    'RTCPeerConnection', 'RTCDataChannel', 'Worker', 'SharedWorker', 'serviceWorker', 'ServiceWorker',
    'BroadcastChannel', 'MessageChannel', 'postMessage', 'FormData', 'Blob', 'FileReader', 'createObjectURL',
    'Notification', 'UrlFetchApp', 'fetchLater', 'WebSocketStream', 'webkitRTCPeerConnection', 'speechSynthesis',
    'SpeechSynthesisUtterance', 'SpeechRecognition', 'webkitSpeechRecognition', 'PaymentRequest',
    'PresentationRequest', 'documentPictureInPicture',
    'insertRule', 'replaceSync', 'adoptedStyleSheets', 'styleSheets', 'CSSStyleSheet', 'cssText',
  ],
  html: [
    'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'setHTML', 'setHTMLUnsafe', 'parseHTMLUnsafe', 'srcdoc',
    'DOMParser', 'createContextualFragment', 'XSLTProcessor', 'createHTMLDocument', 'importNode', 'adoptNode',
    'createElementNS', 'execCommand', 'trustedTypes',
  ],
  dynamic: [
    'eval', 'execScript', 'atob', 'btoa', 'fromCharCode', 'fromCodePoint', 'unescape', 'decodeURIComponent',
    'decodeURI', 'constructor', 'Reflect', 'Proxy', '__proto__', 'WebAssembly', 'globalThis', 'setImmediate',
    '__lookupGetter__', '__lookupSetter__', '__defineGetter__', '__defineSetter__',
  ],
  secrets: ['localStorage', 'sessionStorage', 'indexedDB', 'openDatabase'],
  escape: ['contentWindow', 'contentDocument', 'defaultView', 'opener', 'frameElement', 'clientInformation'],
  acting: ['dispatchEvent', 'requestSubmit'],
};
/** Refused anywhere, in any letter case, even inside longer words. */
export const FORBIDDEN_SECRET_WORDS = ['password', 'passwd', 'token', 'secret', 'apikey', 'api_key', 'api-key', 'authorization', 'cookie', 'credential'];

// ── Reasons (short and plain) ──

export const REASONS = {
  net: 'It tries to contact the internet.',
  element: 'It tries to add something to the page that can load from the internet.',
  html: 'It tries to insert raw HTML into the page.',
  dyn: 'It tries to build and run hidden code.',
  secret: 'It tries to reach passwords, cookies or saved data.',
  escape: 'It tries to reach outside the page it runs on.',
  act: 'It tries to click or submit things on the page for you.',
  browser: 'It tries to use parts of your browser Fibb does not allow.',
  access: 'It tries to get more access than Fibb allows.',
  allPages: 'It tries to run on every page you visit.',
  service: 'It tries to use a Google service Fibb does not allow.',
  obf: 'It is written in a way that hides what it does.',
  unclear: 'It uses code Fibb cannot check.',
  size: 'It is too big.',
  shape: 'It is not put together the way Fibb expects.',
} as const;

class Report {
  reasons: string[] = [];
  details: string[] = [];
  fail(reason: string, detail: string): void {
    if (!this.reasons.includes(reason)) this.reasons.push(reason);
    const d = detail.replace(/\s+/g, ' ').trim().slice(0, 160);
    if (d && !this.details.includes(d) && this.details.length < 20) this.details.push(d);
  }
}

// ── 1. Normalization ──

const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/;
// Soft hyphen, bidi marks and overrides, zero-width and invisible characters,
// line and paragraph separators, variation selectors, BOM, tag characters.
const HIDDEN_CHARS = /[\u00AD\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB]|[\u{E0000}-\u{E0FFF}]/u;
const CODE_ESCAPES = /\\[ux]/;

function checkNormalized(path: string, text: string, rep: Report): void {
  if (CONTROL_CHARS.test(text)) rep.fail(REASONS.obf, `${path}: contains control characters`);
  if (HIDDEN_CHARS.test(text)) rep.fail(REASONS.obf, `${path}: contains invisible or text-direction characters`);
  if (CODE_ESCAPES.test(text)) rep.fail(REASONS.obf, `${path}: contains \\u or \\x escapes, write plain characters instead`);
  if (text.split(/\r\n|\r|\n/).some(line => line.length > MAX_LINE_CHARS)) {
    rep.fail(REASONS.obf, `${path}: has a line longer than ${MAX_LINE_CHARS} characters (minified code is refused)`);
  }
}

// ── 2. Raw scan ──

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (w: string) => new RegExp(`(?<![\\w$])${escapeRe(w)}(?![\\w$])`);

const RAW_RULES: Array<{ re: RegExp; reason: string; label: string }> = [
  ...FORBIDDEN_NAMES.network.map(w => ({ re: wordRe(w), reason: REASONS.net, label: w })),
  ...FORBIDDEN_NAMES.html.map(w => ({ re: wordRe(w), reason: REASONS.html, label: w })),
  ...FORBIDDEN_NAMES.dynamic.map(w => ({ re: wordRe(w), reason: REASONS.dyn, label: w })),
  ...FORBIDDEN_NAMES.secrets.map(w => ({ re: wordRe(w), reason: REASONS.secret, label: w })),
  ...FORBIDDEN_NAMES.escape.map(w => ({ re: wordRe(w), reason: REASONS.escape, label: w })),
  ...FORBIDDEN_NAMES.acting.map(w => ({ re: wordRe(w), reason: REASONS.act, label: w })),
  ...FORBIDDEN_SECRET_WORDS.map(w => ({ re: new RegExp(escapeRe(w), 'i'), reason: REASONS.secret, label: `the word "${w}"` })),
  { re: /document\s*\.\s*write(ln)?(?![\w$])/, reason: REASONS.html, label: 'document.write' },
  { re: /(?<![\w$])Function\s*\(/, reason: REASONS.dyn, label: 'Function(' },
  { re: /(?<![\w$])new\s+Function(?![\w$])/, reason: REASONS.dyn, label: 'new Function' },
  { re: /(?<![\w$.])import\s*\(/, reason: REASONS.dyn, label: 'import(' },
  { re: /url\s*\(/i, reason: REASONS.net, label: 'url(' },
  { re: /@import/i, reason: REASONS.net, label: '@import' },
  { re: /expression\s*\(/i, reason: REASONS.dyn, label: 'expression(' },
];
const URL_RULES: Array<{ re: RegExp; label: string }> = [
  { re: /(?<![a-z])(?:https?|wss?|ftp|file):\/\//i, label: 'a web address' },
  { re: /(?<![a-z])(?:javascript|vbscript|blob):/i, label: 'a javascript: or blob: address' },
  { re: /(?<![a-z])data:[a-z]+\/[a-z0-9+.-]+[;,]/i, label: 'a data: address' },
];

/** The text with block comments removed and adjacent string pieces joined. */
function collapse(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(['"`])\s*\+\s*(['"`])/g, '');
}

function rawScan(path: string, text: string, rep: Report, opts: { urls: boolean }): void {
  for (const variant of [text, collapse(text)]) {
    for (const rule of RAW_RULES) {
      if (rule.re.test(variant)) rep.fail(rule.reason, `${path}: uses ${rule.label}`);
    }
    if (opts.urls) {
      for (const rule of URL_RULES) {
        if (rule.re.test(variant)) rep.fail(REASONS.net, `${path}: contains ${rule.label}`);
      }
    }
  }
}

// ── 3. Tokenizer ──

interface Tok {
  t: 'id' | 'str' | 'num' | 'p' | 're';
  v: string;
  /** Template literal. */
  tpl?: boolean;
  /** Template literal with `${}` parts. */
  dyn?: boolean;
  /** On `)`: 'yes' when it closes an if/while/for/with head, 'maybe' after `await`. */
  ctl?: 'yes' | 'maybe';
}

class LexError extends Error {}

const PUNCTUATORS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
  '{', '}', '(', ')', '[', ']', ';', ',', '.', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^', '!', '~', '?', ':', '=',
];
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=']);
/** Reserved words after which a `/` starts a regular expression. */
const REGEX_AFTER = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'void', 'delete', 'throw', 'new', 'instanceof']);
/** Words that are sometimes keywords and sometimes names: a `/` after them is ambiguous. */
const SOFT_KEYWORDS = new Set(['of', 'yield', 'await', 'extends', 'default', 'async', 'let', 'static', 'break', 'continue', 'debugger', 'try', 'finally']);
const STRING_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', "'": "'", '"': '"', '\\': '\\', '`': '`', $: '$', '/': '/' };
const NUMBER_RE = /(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)n?/y;
const IDENT_RE = /[A-Za-z_$][\w$]*/y;

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  const n = src.length;
  let i = 0;
  const parens: Array<Tok['ctl']> = [];
  const fail = (m: string): never => { throw new LexError(m); };
  const isDot = (t: Tok | undefined) => !!t && t.t === 'p' && (t.v === '.' || t.v === '?.');

  /** Index of the `/` that would close a regex starting at `from`, or -1. */
  const regexEnd = (from: number): number => {
    let inClass = false;
    for (let j = from + 1; j < n; j++) {
      const c = src[j];
      if (c === '\n' || c === '\r') return -1;
      if (c === '\\') { j++; continue; }
      if (inClass) { if (c === ']') inClass = false; continue; }
      if (c === '[') inClass = true;
      else if (c === '/') return j;
    }
    return -1;
  };
  const ambiguous = (): void => {
    const e = regexEnd(i);
    if (e >= 0 && /['"`[\\]/.test(src.slice(i + 1, e))) fail('a "/" that could be read two ways');
  };

  const readString = (q: string): void => {
    let v = '';
    let j = i + 1;
    for (;;) {
      if (j >= n) fail('a string that never ends');
      const c = src[j];
      if (c === '\n' || c === '\r') fail('a string that never ends');
      if (c === '\\') {
        const e = STRING_ESCAPES[src[j + 1]];
        if (e === undefined) fail('an unusual escape in a string');
        v += e;
        j += 2;
        continue;
      }
      if (c === q) break;
      v += c;
      j++;
    }
    i = j + 1;
    out.push({ t: 'str', v });
  };

  const readTemplate = (): void => {
    const tok: Tok = { t: 'str', v: '', tpl: true };
    out.push(tok);
    let v = '';
    i++;
    for (;;) {
      if (i >= n) fail('a template that never ends');
      const c = src[i];
      if (c === '\\') {
        const e = STRING_ESCAPES[src[i + 1]];
        if (e === undefined) fail('an unusual escape in a string');
        v += e;
        i += 2;
        continue;
      }
      if (c === '`') { i++; break; }
      if (c === '$' && src[i + 1] === '{') {
        tok.dyn = true;
        v += ' ';
        i += 2;
        out.push({ t: 'p', v: '${' });
        code(true);
        out.push({ t: 'p', v: '}$' });
        continue;
      }
      v += c;
      i++;
    }
    tok.v = v;
  };

  function code(inTemplate: boolean): void {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      if (c === '/' && src[i + 1] === '/') {
        while (i < n && src[i] !== '\n' && src[i] !== '\r') i++;
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        const e = src.indexOf('*/', i + 2);
        if (e < 0) fail('a comment that never ends');
        i = e + 2;
        continue;
      }
      if (c === '/') {
        const p = out[out.length - 1];
        let regex = false;
        if (!p) regex = true;
        else if (p.t === 'p') {
          if (p.v === ')') {
            if (p.ctl === 'maybe') fail('a "/" that could be read two ways');
            regex = p.ctl === 'yes';
          } else if (p.v === ']' || p.v === '++' || p.v === '--' || p.v === '}$') regex = false;
          else if (p.v === '}') ambiguous();
          else regex = true;
        } else if (p.t === 'id' && !isDot(out[out.length - 2])) {
          if (REGEX_AFTER.has(p.v)) regex = true;
          else if (SOFT_KEYWORDS.has(p.v)) ambiguous();
        }
        if (regex) {
          const e = regexEnd(i);
          if (e < 0) fail('a pattern that never ends');
          let j = e + 1;
          while (j < n && /[a-z]/.test(src[j])) j++;
          out.push({ t: 're', v: src.slice(i, j) });
          i = j;
        } else if (src[i + 1] === '=') { out.push({ t: 'p', v: '/=' }); i += 2; }
        else { out.push({ t: 'p', v: '/' }); i++; }
        continue;
      }
      if (c === '"' || c === "'") { readString(c); continue; }
      if (c === '`') { readTemplate(); continue; }
      if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
        NUMBER_RE.lastIndex = i;
        const m = NUMBER_RE.exec(src);
        if (!m) fail('a number Fibb cannot read');
        out.push({ t: 'num', v: m![0] });
        i += m![0].length;
        continue;
      }
      IDENT_RE.lastIndex = i;
      const id = IDENT_RE.exec(src);
      if (id) { out.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
      if (c === '{') depth++;
      if (c === '}') {
        if (inTemplate && depth === 0) { i++; return; }
        depth--;
      }
      const punct = PUNCTUATORS.find(p => src.startsWith(p, i));
      if (!punct) fail(`an unexpected character (${JSON.stringify(c)})`);
      // "?." followed by a digit is a conditional and a number, not optional chaining.
      const v = punct === '?.' && /\d/.test(src[i + 2] || '') ? '?' : punct!;
      const tok: Tok = { t: 'p', v };
      if (v === '(') {
        const p = out[out.length - 1];
        const keyword = p && p.t === 'id' && !isDot(out[out.length - 2]) ? p.v : '';
        parens.push(['if', 'while', 'for', 'with'].includes(keyword) ? 'yes' : keyword === 'await' ? 'maybe' : undefined);
      } else if (v === ')') {
        tok.ctl = parens.pop();
      }
      out.push(tok);
      i += v.length;
    }
    if (inTemplate) fail('a template that never ends');
  }

  code(false);
  return out;
}

// ── 4. JavaScript rules ──

interface Usage {
  ids: Set<string>;
  assignsText: boolean;
  usesStyle: boolean;
  declaredFunctions: Set<string>;
}
const newUsage = (): Usage => ({ ids: new Set(), assignsText: false, usesStyle: false, declaredFunctions: new Set() });

/** Words after which `[` starts an array, not a property lookup. */
const ARRAY_AFTER = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'else', 'do', 'yield', 'await', 'instanceof', 'default', 'const', 'let', 'var']);
const CONTROL_WORDS = new Set(['if', 'for', 'while', 'switch', 'with', 'return', 'typeof', 'await', 'do', 'else']);
const DECLARATORS = new Set(['const', 'let', 'var']);

/** Names refused wherever they appear as a name (not inside text). */
const BARE_OR_PROP: Record<string, [string, string]> = {
  location: [REASONS.net, 'location (it can send the page somewhere else)'],
  history: [REASONS.net, 'history (pick another variable name)'],
  navigation: [REASONS.net, 'navigation (pick another variable name)'],
  open: [REASONS.net, 'open (it can open windows and other files)'],
  CSS: [REASONS.net, 'CSS'],
  KeyframeEffect: [REASONS.net, 'KeyframeEffect'],
  Animation: [REASONS.net, 'Animation'],
  Image: [REASONS.net, 'Image'],
  Audio: [REASONS.net, 'Audio'],
  FontFace: [REASONS.net, 'FontFace'],
  Request: [REASONS.net, 'Request'],
  Response: [REASONS.net, 'Response'],
  Headers: [REASONS.net, 'Headers'],
  customElements: [REASONS.unclear, 'customElements'],
  caches: [REASONS.secret, 'caches'],
  parent: [REASONS.escape, 'the name "parent" (pick another variable name)'],
  self: [REASONS.escape, 'the name "self" (pick another variable name)'],
  frames: [REASONS.escape, 'the name "frames" (pick another variable name)'],
  Function: [REASONS.dyn, 'Function'],
  prototype: [REASONS.dyn, 'prototype'],
  this: [REASONS.unclear, '"this" (use named variables instead)'],
};
/** Refused as a bare name only. */
const BARE_ONLY: Record<string, [string, string]> = {
  top: [REASONS.escape, 'the name "top" (pick another variable name)'],
  with: [REASONS.dyn, 'with'],
  import: [REASONS.dyn, 'import'],
  export: [REASONS.dyn, 'export'],
  require: [REASONS.dyn, 'require'],
  process: [REASONS.escape, 'process'],
  browser: [REASONS.escape, 'browser'],
};
/** Refused as a property (after a dot). */
const PROP_ONLY: Record<string, [string, string]> = Object.fromEntries([
  ...['src', 'href', 'srcset', 'action', 'formAction', 'poster', 'ping', 'background', 'backgroundImage',
    'borderImage', 'borderImageSource', 'listStyle', 'listStyleImage', 'maskImage', 'lowsrc', 'codeBase',
    'httpEquiv', 'setProperty', 'attributeStyleMap', 'addModule', 'fonts', 'navigate', 'animate',
    'showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']
    .map(w => [w, [REASONS.net, `.${w}`]]),
  ...['forms', 'scripts', 'embeds', 'plugins', 'images', 'links', 'implementation', 'attributes',
    'getAttributeNode', 'getAttributeNodeNS', 'setAttributeNode', 'setAttributeNodeNS', 'setAttributeNS',
    'setNamedItem', 'getNamedItem', 'createAttribute', 'evaluate', 'createExpression', 'cloneNode',
    'attachShadow', 'domain']
    .map(w => [w, [REASONS.unclear, `.${w}`]]),
  ...['write', 'writeln'].map(w => [w, [REASONS.html, `.${w}`]]),
  ['view', [REASONS.escape, '.view']],
  ['submit', [REASONS.act, '.submit']],
  ['click', [REASONS.act, '.click']],
]);
/** Properties that rewrite where a link goes; refused when assigned. */
const LINK_PROPS = new Set(['host', 'hostname', 'pathname', 'search', 'hash', 'protocol', 'port', 'username', 'download', 'data', 'content', 'referrerPolicy']);

const CSS_DANGER = /url\s*\(|@import|expression\s*\(|image-set\s*\(|@font-face|@namespace|-moz-binding|behavior\s*:/i;
const HTML_IN_TEXT = /<\s*[a-zA-Z!/?]/;

const APPS_SCRIPT_GLOBALS = new Set([
  ...ALLOWED_APPS_SCRIPT_SERVICES,
  'Math', 'JSON', 'Date', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Map', 'Set', 'RegExp', 'Error', 'Infinity', 'NaN',
]);
const APPS_SCRIPT_BANNED_CALLS = new Set([
  'openById', 'openByUrl', 'getBlob', 'getAs', 'makeCopy', 'setLinkUrl', 'insertImage', 'insertInlineImage',
  'appendImage', 'appendInlineImage', 'addPositionedImage', 'addImage', 'insertVideo', 'replaceWithImage',
  'replaceAllShapesWithImage', 'insertSheetsChart', 'insertSheetsChartAsImage', 'setFormula', 'setFormulas',
  'setFormulaR1C1', 'setFormulasR1C1', 'setValue', 'setValues', 'appendRow', 'setRichTextValue',
  'setRichTextValues', 'setDataValidation', 'setDataValidations', 'newDataValidation',
  'newConditionalFormatRule', 'insertChart', 'newChart', 'addEditor', 'addEditors', 'addViewer', 'addViewers',
  'addCommenter', 'addCommenters', 'setSharing', 'newTrigger', 'getImages', 'asImage', 'setPictureFill',
  'newCellImage', 'setSourceUrl', 'createTextFinder', 'replaceAllWith', 'setConditionalFormatRules',
]);

interface JsEnv { kind: ToolKind; path: string; bundle: Set<string> }

function checkJs(src: string, env: JsEnv, rep: Report, usage: Usage): void {
  const { path, kind } = env;
  let T: Tok[];
  try {
    T = lex(src);
  } catch (err) {
    rep.fail(REASONS.unclear, `${path}: has ${(err as Error).message}`);
    return;
  }
  const N = T.length;
  const isP = (i: number, v: string) => i >= 0 && i < N && T[i].t === 'p' && T[i].v === v;
  const isId = (i: number, v?: string) => i >= 0 && i < N && T[i].t === 'id' && (v === undefined || T[i].v === v);
  const isProp = (i: number) => isP(i - 1, '.') || isP(i - 1, '?.');
  const isAssign = (i: number) => i < N && T[i].t === 'p' && ASSIGN_OPS.has(T[i].v);
  const plainStr = (i: number) => i >= 0 && i < N && T[i].t === 'str' && !T[i].dyn;

  // Bracket matching.
  const match = new Array<number>(N).fill(-1);
  {
    const stack: number[] = [];
    const closes: Record<string, string> = { ')': '(', ']': '[', '}': '{', '}$': '${' };
    for (let i = 0; i < N; i++) {
      if (T[i].t !== 'p') continue;
      const v = T[i].v;
      if (v === '(' || v === '[' || v === '{' || v === '${') stack.push(i);
      else if (closes[v]) {
        const o = stack.pop();
        if (o === undefined || T[o].v !== closes[v]) { rep.fail(REASONS.unclear, `${path}: has brackets that do not match`); return; }
        match[o] = i;
        match[i] = o;
      }
    }
    if (stack.length) { rep.fail(REASONS.unclear, `${path}: has brackets that do not match`); return; }
  }

  // Names bound as parameters or by destructuring (index sets).
  const bound = new Set<number>();
  // Taking properties apart ({ a, b } = thing) can rename a property, which would hide it from the rules below.
  let objectPattern = false;
  for (let i = 0; i < N; i++) {
    if (isP(i, '(')) {
      const c = match[i];
      const params = isId(i - 1, 'function') || (isId(i - 1) && isId(i - 2, 'function')) || isId(i - 1, 'catch')
        || isP(c + 1, '=>') || (isP(c + 1, '{') && isId(i - 1) && !CONTROL_WORDS.has(T[i - 1].v));
      if (params) {
        for (let k = i + 1; k < c; k++) {
          if (T[k].t === 'id') bound.add(k);
          if (isP(k, '{') && (isP(k - 1, '(') || isP(k - 1, ',') || isP(k - 1, '['))) objectPattern = true;
        }
      }
    } else if ((isP(i, ']') || isP(i, '}')) && (isP(i + 1, '=') || isId(i + 1, 'of') || isId(i + 1, 'in'))) {
      if (isP(i, '}')) objectPattern = true;
      for (let k = match[i] + 1; k < i; k++) {
        if (T[k].t === 'id') bound.add(k);
        if (isP(k, '{')) objectPattern = true;
      }
    }
  }

  if (objectPattern) rep.fail(REASONS.unclear, `${path}: takes an object apart with { } (object destructuring). Read each property with a dot instead`);

  // Loop counters: `for (let i = 0; ...)` whose name is never bound or assigned any other way.
  const counterDecl = new Map<string, Set<number>>();
  for (let i = 0; i + 6 < N; i++) {
    if (isId(i, 'for') && !isProp(i) && isP(i + 1, '(') && (isId(i + 2, 'let') || isId(i + 2, 'var'))
      && isId(i + 3) && isP(i + 4, '=') && T[i + 5].t === 'num' && isP(i + 6, ';')) {
      const name = T[i + 3].v;
      if (!counterDecl.has(name)) counterDecl.set(name, new Set());
      counterDecl.get(name)!.add(i + 3);
    }
  }
  const counters = new Set(counterDecl.keys());
  const functionNames = new Map<string, number>();
  const reassigned = new Set<string>();
  for (let i = 0; i < N; i++) {
    if (T[i].t !== 'id' || isProp(i)) continue;
    const name = T[i].v;
    if (isId(i - 1, 'function')) functionNames.set(name, (functionNames.get(name) || 0) + 1);
    const stepOk = (isP(i + 1, '+=') || isP(i + 1, '-=')) && i + 3 < N && T[i + 2].t === 'num' && (isP(i + 3, ')') || isP(i + 3, ';'));
    const changed = bound.has(i) || (isId(i - 1) && DECLARATORS.has(T[i - 1].v)) || isId(i - 1, 'class')
      || (isAssign(i + 1) && !stepOk) || isP(i + 1, '=>') || isId(i + 1, 'of') || isId(i + 1, 'in');
    if (counters.has(name)) {
      if (counterDecl.get(name)!.has(i)) continue;
      if (changed || isId(i - 1, 'function')) counters.delete(name);
    }
    if (changed || isP(i + 1, '++') || isP(i + 1, '--') || isP(i - 1, '++') || isP(i - 1, '--')) reassigned.add(name);
  }
  const stableFunction = (name: string) => functionNames.get(name) === 1 && !reassigned.has(name);
  for (const [name, count] of functionNames) if (count === 1 && !reassigned.has(name)) usage.declaredFunctions.add(name);

  const declared = new Set<string>();
  for (let i = 1; i < N; i++) {
    if (T[i].t === 'id' && isId(i - 1) && (DECLARATORS.has(T[i - 1].v) || T[i - 1].v === 'function' || T[i - 1].v === 'class')) declared.add(T[i].v);
  }

  const htmlExempt = new Set<number>();
  let bareStyle = false;
  const styleVars = new Map<string, number>();

  /** End index of a function expression starting at `i` (`function` keyword), or -1. */
  const functionEnd = (i: number): number => {
    let k = i + 1;
    if (isP(k, '*')) k++;
    if (isId(k)) k++;
    if (!isP(k, '(')) return -1;
    k = match[k] + 1;
    if (!isP(k, '{')) return -1;
    return match[k];
  };

  for (let i = 0; i < N; i++) {
    const tok = T[i];

    // ── Text ──
    if (tok.t === 'str') {
      if (tok.tpl && i > 0 && (T[i - 1].t === 'id' && !ARRAY_AFTER.has(T[i - 1].v) || isP(i - 1, ')') || isP(i - 1, ']'))) {
        rep.fail(REASONS.unclear, `${path}: uses a tagged template`);
      }
      const v = tok.v;
      if (v.includes('//')) rep.fail(REASONS.net, `${path}: has text containing "//" (looks like a web address)`);
      for (const rule of URL_RULES) if (rule.re.test(v)) rep.fail(REASONS.net, `${path}: has text containing ${rule.label}`);
      if (CSS_DANGER.test(v)) rep.fail(REASONS.net, `${path}: has style text that can load from the internet`);
      continue;
    }

    // ── Square brackets ──
    if (tok.t === 'p' && tok.v === '[') {
      const p = T[i - 1];
      const lookup = !!p && ((p.t === 'id' && !ARRAY_AFTER.has(p.v)) || p.t === 'str' || p.t === 're'
        || (p.t === 'p' && [')', ']', '}', '?.', '}$'].includes(p.v)));
      const end = match[i];
      if (lookup) {
        const inner = T.slice(i + 1, end);
        const ok = inner.length > 0 && inner.every(t =>
          t.t === 'num' || (t.t === 'p' && (t.v === '+' || t.v === '-')) || (t.t === 'id' && counters.has(t.v)));
        if (!ok) {
          rep.fail(REASONS.unclear, `${path}: uses square brackets to reach a property. Only a number or a plain "for (let i = 0; ...)" counter may go inside [ ]. Use .at(), for...of or a Map instead`);
        }
      } else if ((isP(i - 1, '{') || isP(i - 1, ',')) && (isP(end + 1, ':') || isP(end + 1, '('))) {
        rep.fail(REASONS.unclear, `${path}: uses a computed property name ({ [name]: ... })`);
      }
      continue;
    }

    if (tok.t !== 'id') continue;
    const name = tok.v;
    const prop = isProp(i);
    usage.ids.add(name);

    const both = Object.hasOwn(BARE_OR_PROP, name) ? BARE_OR_PROP[name] : undefined;
    if (both) rep.fail(both[0], `${path}: uses ${both[1]}`);
    const bare = !prop && Object.hasOwn(BARE_ONLY, name) ? BARE_ONLY[name] : undefined;
    if (bare) rep.fail(bare[0], `${path}: uses ${bare[1]}`);
    const asProp = prop && Object.hasOwn(PROP_ONLY, name) ? PROP_ONLY[name] : undefined;
    if (asProp) rep.fail(asProp[0], `${path}: uses ${asProp[1]}`);
    if (prop && LINK_PROPS.has(name) && isAssign(i + 1)) rep.fail(REASONS.net, `${path}: changes .${name}`);
    if ((name === 'textContent' || name === 'innerText') && prop && isAssign(i + 1)) usage.assignsText = true;

    switch (name) {
      case 'window': {
        if (prop) { rep.fail(REASONS.escape, `${path}: reaches another window`); break; }
        if (isP(i + 1, '[')) rep.fail(REASONS.dyn, `${path}: uses window[...]`);
        else if (!(isP(i + 1, '.') && isId(i + 2) && ALLOWED_WINDOW_MEMBERS.includes(T[i + 2].v))) {
          rep.fail(REASONS.escape, `${path}: uses window in a way Fibb does not allow (${isId(i + 2) ? 'window.' + T[i + 2].v : 'window on its own'})`);
        }
        break;
      }
      case 'document': {
        if (prop && !isId(i - 2, 'window')) { rep.fail(REASONS.escape, `${path}: reaches another document`); break; }
        if (isP(i + 1, '[')) rep.fail(REASONS.dyn, `${path}: uses document[...]`);
        else if (!(isP(i + 1, '.') && isId(i + 2) && ALLOWED_DOCUMENT_MEMBERS.includes(T[i + 2].v))) {
          rep.fail(REASONS.unclear, `${path}: uses document in a way Fibb does not allow (${isId(i + 2) ? 'document.' + T[i + 2].v : 'document on its own'})`);
        }
        break;
      }
      case 'navigator': {
        const ok = isP(i + 1, '.') && isId(i + 2, 'clipboard') && isP(i + 3, '.') && isId(i + 4, 'writeText') && isP(i + 5, '(');
        if (!ok) rep.fail(REASONS.browser, `${path}: uses navigator for something other than navigator.clipboard.writeText(...)`);
        break;
      }
      case 'clipboard': {
        const ok = prop && isId(i - 2, 'navigator') && isP(i + 1, '.') && isId(i + 2, 'writeText') && isP(i + 3, '(');
        if (!ok) rep.fail(REASONS.secret, `${path}: uses the clipboard for something other than navigator.clipboard.writeText(...)`);
        break;
      }
      case 'Object': {
        if (prop) break;
        const ok = isP(i + 1, '.') && (isId(i + 2, 'keys') || isId(i + 2, 'freeze')) && isP(i + 3, '(');
        if (!ok) rep.fail(REASONS.unclear, `${path}: uses Object.${isId(i + 2) ? T[i + 2].v : ''}. Only Object.keys and Object.freeze are allowed. Use a Map for tallies`);
        break;
      }
      case 'setTimeout':
      case 'setInterval': {
        let ok = false;
        if (isP(i + 1, '(')) {
          const a = i + 2;
          const argEnd = (k: number) => isP(k, ',') || isP(k, ')');
          if (isId(a, 'function')) { const e = functionEnd(a); ok = e >= 0 && argEnd(e + 1); }
          else if (isId(a, 'async') && isId(a + 1, 'function')) { const e = functionEnd(a + 1); ok = e >= 0 && argEnd(e + 1); }
          else if (isP(a, '(') && isP(match[a] + 1, '=>')) ok = true;
          else if (isId(a) && isP(a + 1, '=>')) ok = true;
          else if (isId(a) && !isProp(a) && stableFunction(T[a].v) && argEnd(a + 1)) ok = true;
        }
        if (!ok) rep.fail(REASONS.dyn, `${path}: calls ${name} with something other than a function written in place`);
        break;
      }
      case 'createElement': {
        const lit = isP(i + 1, '(') && plainStr(i + 2) && isP(i + 3, ')');
        if (!lit || !ALLOWED_ELEMENTS.includes(T[i + 2].v)) {
          rep.fail(REASONS.element, `${path}: creates ${lit ? `a <${T[i + 2].v.slice(0, 20)}> element` : 'an element whose kind is not written in place'}`);
          break;
        }
        if (T[i + 2].v === 'style') {
          usage.usesStyle = true;
          const ok = isProp(i) && isId(i - 2, 'document') && !isProp(i - 2) && isP(i - 3, '=') && isId(i - 4) && isId(i - 5) && DECLARATORS.has(T[i - 5].v);
          if (ok) styleVars.set(T[i - 4].v, i - 4);
          else rep.fail(REASONS.unclear, `${path}: creates a style element in a way Fibb cannot follow. Write: const sheet = document.createElement('style');`);
        }
        break;
      }
      case 'setAttribute': {
        const lit = isP(i + 1, '(') && plainStr(i + 2) && isP(i + 3, ',');
        const attr = lit ? T[i + 2].v : '';
        const ok = lit && (ALLOWED_SET_ATTRIBUTES.includes(attr) || /^(aria|data)-[a-z0-9-]+$/.test(attr));
        if (!ok) rep.fail(REASONS.net, `${path}: sets the attribute ${lit ? `"${attr.slice(0, 20)}"` : 'whose name is not written in place'}`);
        break;
      }
      case 'style': {
        if (!prop) { bareStyle = true; break; }
        usage.usesStyle = true;
        if (!(isP(i + 1, '.') && isId(i + 2) && ALLOWED_STYLE_PROPS.includes(T[i + 2].v))) {
          rep.fail(REASONS.unclear, `${path}: uses .style${isId(i + 2) ? '.' + T[i + 2].v : ''}. Set one allowed style property at a time, for example el.style.color = "..."`);
        }
        break;
      }
      case 'chrome': {
        if (prop || kind !== 'extension') { rep.fail(REASONS.escape, `${path}: uses chrome.* outside an extension`); break; }
        const call = isP(i + 1, '.') && isId(i + 2) && isP(i + 3, '.') && isId(i + 4) && isP(i + 5, '(') ? `chrome.${T[i + 2].v}.${T[i + 4].v}` : '';
        if (!ALLOWED_CHROME_CALLS.includes(call)) {
          rep.fail(REASONS.browser, `${path}: uses ${call || 'chrome'} (only ${ALLOWED_CHROME_CALLS.join(' and ')} are allowed)`);
        }
        break;
      }
      case 'files': {
        if (kind !== 'extension' || !isP(i + 1, ':')) break;
        let ok = isP(i + 2, '[');
        if (ok) {
          const end = match[i + 2];
          const inner = T.slice(i + 3, end);
          ok = inner.length > 0 && inner.every((t, k) => (k % 2 === 0
            ? t.t === 'str' && !t.dyn && t.v.endsWith('.js') && env.bundle.has(t.v)
            : t.t === 'p' && t.v === ','));
        }
        if (!ok) rep.fail(REASONS.unclear, `${path}: injects script files that are not part of the tool`);
        break;
      }
      default:
        break;
    }

    if (kind === 'apps-script') {
      if (!prop && /^[A-Z]/.test(name) && !APPS_SCRIPT_GLOBALS.has(name) && !declared.has(name)) {
        rep.fail(REASONS.service, `${path}: uses ${name}`);
      }
      if (APPS_SCRIPT_BANNED_CALLS.has(name) || /DataSource/.test(name)) rep.fail(REASONS.service, `${path}: uses ${name}`);
      if (prop && name === 'create' && isId(i - 2) && /App$/.test(T[i - 2].v)) rep.fail(REASONS.service, `${path}: creates a new file`);
      if (isId(i - 1, 'function') && (name === 'doGet' || name === 'doPost')) rep.fail(REASONS.net, `${path}: defines a web app (${name})`);
      if (name === 'Utilities' && !prop) {
        if (!(isP(i + 1, '.') && isId(i + 2) && ALLOWED_UTILITIES.includes(T[i + 2].v) && isP(i + 3, '('))) {
          rep.fail(REASONS.service, `${path}: uses Utilities.${isId(i + 2) ? T[i + 2].v : ''} (only ${ALLOWED_UTILITIES.join(' and ')} are allowed)`);
        }
      }
      if (name === 'HtmlService' && !prop) {
        const ok = isP(i + 1, '.') && isId(i + 2, 'createHtmlOutput') && isP(i + 3, '(') && plainStr(i + 4) && isP(i + 5, ')');
        if (!ok) rep.fail(REASONS.service, `${path}: uses HtmlService with anything other than createHtmlOutput("plain text written in place")`);
        else {
          htmlExempt.add(i + 4);
          checkHtml(T[i + 4].v, { path, bundle: new Set(), fragment: true }, rep);
        }
      }
    }
  }

  // Text that looks like HTML (the one literal handed to HtmlService is checked separately).
  for (let i = 0; i < N; i++) {
    if (T[i].t === 'str' && !htmlExempt.has(i) && HTML_IN_TEXT.test(T[i].v)) {
      rep.fail(REASONS.html, `${path}: has text that looks like HTML. Build elements with createElement and textContent`);
    }
  }

  // The bare name "style" may only be the style element itself (so .style cannot be pulled out under another name).
  if (bareStyle && !styleVars.has('style')) rep.fail(REASONS.unclear, `${path}: uses "style" as a name. Write el.style.color = "..." instead`);

  // A style element may only be given fixed text.
  for (const [name, declIndex] of styleVars) {
    for (let i = 0; i < N; i++) {
      if (i === declIndex || !isId(i, name) || isProp(i)) continue;
      const setsText = isP(i + 1, '.') && isId(i + 2, 'textContent') && isP(i + 3, '=') && plainStr(i + 4)
        && (i + 5 >= N || isP(i + 5, ';') || isP(i + 5, '}'));
      const setsId = isP(i + 1, '.') && isId(i + 2, 'id') && isP(i + 3, '=') && plainStr(i + 4);
      const removes = isP(i + 1, '.') && isId(i + 2, 'remove') && isP(i + 3, '(');
      const added = isP(i - 1, '(') && isP(i + 1, ')') && isId(i - 2) && ['appendChild', 'append', 'prepend'].includes(T[i - 2].v);
      if (!(setsText || setsId || removes || added)) {
        rep.fail(REASONS.unclear, `${path}: uses the style element "${name}" in a way Fibb cannot follow. Only ${name}.textContent = "fixed text"; and appendChild(${name}) are allowed`);
        break;
      }
    }
  }
}

// ── 5. CSS and HTML ──

function checkCss(text: string, path: string, rep: Report): void {
  for (const variant of [text, text.replace(/\/\*[\s\S]*?\*\//g, '')]) {
    if (CSS_DANGER.test(variant) || /src\s*:/i.test(variant)) rep.fail(REASONS.net, `${path}: has style rules that can load from the internet`);
    if (variant.includes('\\')) rep.fail(REASONS.obf, `${path}: has backslash escapes in style rules`);
    if (variant.includes('//') || /[<>]\s*\/?\s*(style|script)/i.test(variant)) rep.fail(REASONS.unclear, `${path}: has style rules Fibb cannot check`);
  }
}

const HTML_TAGS = new Set([
  'html', 'head', 'body', 'meta', 'title', 'link', 'script', 'style', 'main', 'section', 'header', 'footer',
  'label', 'input', 'textarea', 'select', 'option', 'thead', 'tbody',
  ...ALLOWED_ELEMENTS,
]);
const FRAGMENT_TAGS = new Set(ALLOWED_ELEMENTS.filter(t => t !== 'style' && t !== 'button'));
const HTML_ATTRS = new Set([
  'id', 'class', 'type', 'title', 'lang', 'dir', 'role', 'for', 'placeholder', 'rows', 'cols', 'value',
  'checked', 'disabled', 'hidden', 'min', 'max', 'step', 'colspan', 'rowspan', 'tabindex', 'charset',
  'name', 'content', 'rel', 'defer', 'style', 'src', 'href',
]);
const TAG_RE = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"<>]*"|'[^'<>]*'|[^"'<>])*)>/g;
const ATTR_RE = /([^\s"'=<>/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

function checkHtml(source: string, env: { path: string; bundle: Set<string>; fragment?: boolean }, rep: Report): void {
  const { path } = env;
  let text = source.replace(/<!--[\s\S]*?-->/g, '');
  if (text.includes('<!--')) { rep.fail(REASONS.unclear, `${path}: has an HTML comment that never ends`); return; }
  text = text.replace(/^\s*<!doctype html>/i, '');
  if (text.includes('&#')) rep.fail(REASONS.obf, `${path}: uses numeric character codes (&#...)`);

  const tags: Array<{ close: boolean; name: string; attrs: string; start: number; end: number }> = [];
  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(text); m; m = TAG_RE.exec(text)) {
    tags.push({ close: m[1] === '/', name: m[2].toLowerCase(), attrs: m[3] || '', start: m.index, end: m.index + m[0].length });
  }
  if (/[<>]/.test(text.replace(TAG_RE, ' '))) { rep.fail(REASONS.unclear, `${path}: has HTML Fibb cannot read`); return; }

  const allowed = env.fragment ? FRAGMENT_TAGS : HTML_TAGS;
  for (let t = 0; t < tags.length; t++) {
    const tag = tags[t];
    if (!allowed.has(tag.name)) { rep.fail(REASONS.element, `${path}: has a <${tag.name.slice(0, 20)}> tag`); continue; }
    if (tag.close) continue;

    const attrs = new Map<string, string>();
    const body = tag.attrs.replace(/\/\s*$/, '');
    ATTR_RE.lastIndex = 0;
    for (let m = ATTR_RE.exec(body); m; m = ATTR_RE.exec(body)) {
      const raw = m[2] ?? '';
      attrs.set(m[1].toLowerCase(), /^["']/.test(raw) ? raw.slice(1, -1) : raw);
    }
    for (const [attr, value] of attrs) {
      if (/^on/.test(attr)) { rep.fail(REASONS.dyn, `${path}: has an inline event handler (${attr.slice(0, 20)})`); continue; }
      const known = HTML_ATTRS.has(attr) || /^(aria|data)-[a-z0-9-]+$/.test(attr);
      if (!known || env.fragment) { rep.fail(REASONS.unclear, `${path}: has the attribute "${attr.slice(0, 20)}" on <${tag.name}>`); continue; }
      if (attr === 'style') checkCss(value, path, rep);
      if (attr === 'src') {
        if (!(tag.name === 'script' && value.endsWith('.js') && env.bundle.has(value))) rep.fail(REASONS.net, `${path}: loads "${value.slice(0, 40)}", which is not a script file in the tool`);
      }
      if (attr === 'href') {
        const ok = tag.name === 'link' && (attrs.get('rel') || '').toLowerCase() === 'stylesheet' && value.endsWith('.css') && env.bundle.has(value);
        if (!ok) rep.fail(REASONS.net, `${path}: links to "${value.slice(0, 40)}", which is not a style file in the tool`);
      }
    }
    if (tag.name === 'meta' && !(attrs.size === 1 && attrs.has('charset')) && !((attrs.get('name') || '').toLowerCase() === 'viewport' && attrs.size === 2 && attrs.has('content'))) {
      rep.fail(REASONS.unclear, `${path}: has a <meta> tag other than charset or viewport`);
    }
    if (tag.name === 'link' && !attrs.has('href')) rep.fail(REASONS.unclear, `${path}: has a <link> tag without a local style file`);
    if (tag.name === 'input' && !['', 'text', 'number', 'checkbox', 'search', 'range'].includes((attrs.get('type') || '').toLowerCase())) {
      rep.fail(REASONS.unclear, `${path}: has an <input> of a kind Fibb does not allow`);
    }
    if (tag.name === 'script' || tag.name === 'style') {
      const next = tags[t + 1];
      const inner = text.slice(tag.end, next ? next.start : text.length);
      if (!next || !next.close || next.name !== tag.name) { rep.fail(REASONS.unclear, `${path}: has a <${tag.name}> tag that is not closed`); continue; }
      if (tag.name === 'script') {
        if (inner.trim()) rep.fail(REASONS.dyn, `${path}: has script written inside the page. Put it in a .js file`);
        if (!attrs.has('src')) rep.fail(REASONS.dyn, `${path}: has a <script> tag without a local file`);
        const type = (attrs.get('type') || '').toLowerCase();
        if (type && type !== 'text/javascript') rep.fail(REASONS.unclear, `${path}: has a <script> tag with a type`);
      } else {
        checkCss(inner, path, rep);
      }
    }
  }
}

// ── 6. Extension manifest ──

const MATCH_RE = /^(\*|https?):\/\/(\*|(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*)\/.*$/;
const BROAD_HOST = /^(\*|\*\.[a-z0-9-]+)$/;

interface ManifestInfo { popup: boolean; patterns: string[] }

function checkManifest(text: string, bundle: Set<string>, opts: CheckOptions, rep: Report): ManifestInfo {
  const info: ManifestInfo = { popup: false, patterns: [] };
  const path = 'manifest.json';
  let m: any;
  try { m = JSON.parse(text); } catch { rep.fail(REASONS.shape, `${path}: is not valid JSON`); return info; }
  if (typeof m !== 'object' || m === null || Array.isArray(m)) { rep.fail(REASONS.shape, `${path}: is not an object`); return info; }

  const keysOk = (obj: any, allowed: string[], where: string): boolean => {
    let ok = true;
    for (const k of Object.keys(obj)) {
      if (!allowed.includes(k)) { rep.fail(REASONS.access, `${path}: has the key "${k.slice(0, 40)}"${where}`); ok = false; }
    }
    return ok;
  };
  const text1 = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max
    && !v.includes('//') && !URL_RULES.some(r => r.re.test(v)) && !HTML_IN_TEXT.test(v);
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const fileList = (v: unknown, ext: string) => Array.isArray(v) && v.length > 0 && v.every(f => typeof f === 'string' && f.endsWith(ext) && bundle.has(f));

  keysOk(m, ALLOWED_MANIFEST_KEYS, '');
  if (m.manifest_version !== 3) rep.fail(REASONS.shape, `${path}: manifest_version must be 3`);
  if (!text1(m.name, 60)) rep.fail(REASONS.shape, `${path}: needs a short plain name`);
  if (typeof m.version !== 'string' || !/^\d{1,5}(\.\d{1,5}){0,3}$/.test(m.version)) rep.fail(REASONS.shape, `${path}: needs a version like "1.0"`);
  if (m.description !== undefined && !text1(m.description, 200)) rep.fail(REASONS.shape, `${path}: description must be short plain text`);

  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions) || !m.permissions.every((p: unknown) => typeof p === 'string' && ALLOWED_PERMISSIONS.includes(p))) {
      rep.fail(REASONS.access, `${path}: asks for permissions other than ${ALLOWED_PERMISSIONS.join(' and ')}`);
    }
  }
  if (m.icons !== undefined && !(isObj(m.icons) && Object.values(m.icons).every(f => typeof f === 'string' && bundle.has(f)))) {
    rep.fail(REASONS.shape, `${path}: icons must be files in the tool (leave icons out)`);
  }
  if (m.action !== undefined) {
    if (!isObj(m.action)) rep.fail(REASONS.shape, `${path}: action must be an object`);
    else if (keysOk(m.action, ['default_popup', 'default_title'], ' in action')) {
      if (m.action.default_title !== undefined && !text1(m.action.default_title, 60)) rep.fail(REASONS.shape, `${path}: default_title must be short plain text`);
      const popup = m.action.default_popup;
      if (popup !== undefined) {
        if (typeof popup === 'string' && popup.endsWith('.html') && bundle.has(popup)) info.popup = true;
        else rep.fail(REASONS.shape, `${path}: default_popup must be an .html file in the tool`);
      }
    }
  }
  if (m.content_scripts !== undefined) {
    if (!Array.isArray(m.content_scripts) || m.content_scripts.length === 0 || m.content_scripts.length > 3) {
      rep.fail(REASONS.shape, `${path}: content_scripts must be a short list`);
    } else {
      for (const cs of m.content_scripts) {
        if (!isObj(cs)) { rep.fail(REASONS.shape, `${path}: a content script entry is not an object`); continue; }
        if (!keysOk(cs, ['matches', 'js', 'css', 'run_at'], ' in content_scripts')) continue;
        if (cs.run_at !== undefined && !['document_idle', 'document_end', 'document_start'].includes(cs.run_at as string)) rep.fail(REASONS.shape, `${path}: run_at is not valid`);
        if (cs.js === undefined && cs.css === undefined) rep.fail(REASONS.shape, `${path}: a content script has no files`);
        if (cs.js !== undefined && !fileList(cs.js, '.js')) rep.fail(REASONS.shape, `${path}: content script js must be .js files in the tool`);
        if (cs.css !== undefined && !fileList(cs.css, '.css')) rep.fail(REASONS.shape, `${path}: content script css must be .css files in the tool`);
        if (!Array.isArray(cs.matches) || cs.matches.length === 0 || cs.matches.length > 10) { rep.fail(REASONS.shape, `${path}: matches must be a short list of page patterns`); continue; }
        for (const pattern of cs.matches) {
          if (typeof pattern !== 'string' || pattern.length > 200) { rep.fail(REASONS.shape, `${path}: a match pattern is not text`); continue; }
          const parts = pattern === '<all_urls>' ? null : MATCH_RE.exec(pattern);
          const broad = pattern === '<all_urls>' || (!!parts && BROAD_HOST.test(parts[2]));
          if (pattern !== '<all_urls>' && !parts) { rep.fail(REASONS.shape, `${path}: the match pattern "${pattern.slice(0, 40)}" is not valid`); continue; }
          if (broad && !(opts.allowAllPages === true && (pattern === '<all_urls>' || parts![2] === '*'))) {
            rep.fail(REASONS.allPages, `${path}: the match pattern "${pattern.slice(0, 40)}" covers every page. Name the site instead`);
            continue;
          }
          info.patterns.push(pattern);
        }
      }
    }
  }
  if (!info.popup && m.content_scripts === undefined) rep.fail(REASONS.shape, `${path}: needs an action popup or content_scripts`);
  return info;
}

// ── 7. Entry point ──

const PATH_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const extOf = (p: string) => { const i = p.lastIndexOf('.'); return i < 0 ? '' : p.slice(i); };
const SINGLE_FILE_TYPES: Record<string, string[]> = { bookmarklet: ['.js'], 'apps-script': ['.gs', '.js'] };

const CHANGE_IDS = ['appendChild', 'append', 'prepend', 'insertBefore', 'replaceWith', 'replaceChild', 'replaceChildren', 'after', 'before',
  'insertAdjacentElement', 'insertAdjacentText', 'remove', 'removeChild', 'classList', 'className', 'splitText', 'surroundContents', 'insertNode'];
const READ_IDS = ['innerText', 'textContent', 'nodeValue', 'querySelector', 'querySelectorAll', 'getElementById',
  'getElementsByClassName', 'getElementsByTagName', 'createTreeWalker'];
const DOC_WRITE_RE = /^(set[A-Z]\w*|append[A-Z]\w*|insert[A-Z]\w*|remove[A-Z]\w*|replaceText|replaceAllText|deleteText|clear|merge|editAsText)$/;

export function checkTool(kind: ToolKind, files: ToolFile[], opts: CheckOptions = {}): CheckResult {
  const rep = new Report();
  const done = (access: string[] = [], warnings: string[] = []): CheckResult => {
    const ok = rep.reasons.length === 0;
    return { ok, reasons: rep.reasons, access: ok ? access : [], warnings: ok ? warnings : [], details: rep.details };
  };

  if (!TOOL_KINDS.includes(kind)) { rep.fail(REASONS.shape, 'unknown kind of tool'); return done(); }
  if (!Array.isArray(files) || files.length === 0
    || !files.every(f => f && typeof f === 'object' && typeof f.path === 'string' && typeof f.content === 'string')) {
    rep.fail(REASONS.shape, 'files must be a list of { path, content }');
    return done();
  }
  const limit = LIMITS[kind];
  if (files.length > limit.files) rep.fail(REASONS.size, `${files.length} files (at most ${limit.files})`);
  let total = 0;
  const bundle = new Set<string>();
  for (const f of files) {
    const bytes = Buffer.byteLength(f.content, 'utf8');
    total += bytes;
    if (bytes > limit.fileBytes) rep.fail(REASONS.size, `${f.path.slice(0, 40)} is ${bytes} bytes (at most ${limit.fileBytes})`);
    if (!f.content.trim()) rep.fail(REASONS.shape, `${f.path.slice(0, 40)} is empty`);
    const types = kind === 'extension' ? EXTENSION_FILE_TYPES : SINGLE_FILE_TYPES[kind];
    if (!PATH_RE.test(f.path) || f.path.includes('..') || !types.includes(extOf(f.path))) {
      rep.fail(REASONS.shape, `the file name "${f.path.slice(0, 40)}" is not allowed (lowercase letters, digits, dots and dashes; ${types.join(' ')})`);
    }
    if (bundle.has(f.path)) rep.fail(REASONS.shape, `two files are named "${f.path.slice(0, 40)}"`);
    bundle.add(f.path);
  }
  if (total > limit.totalBytes) rep.fail(REASONS.size, `${total} bytes in total (at most ${limit.totalBytes})`);
  if (rep.reasons.length) return done();

  const usage = newUsage();
  let manifest: ManifestInfo = { popup: false, patterns: [] };
  if (kind === 'extension') {
    const manifests = files.filter(f => f.path === 'manifest.json');
    if (manifests.length !== 1 || files.some(f => extOf(f.path) === '.json' && f.path !== 'manifest.json')) {
      rep.fail(REASONS.shape, 'an extension needs exactly one manifest.json and no other .json files');
      return done();
    }
  }

  for (const f of files) {
    const ext = extOf(f.path);
    const isManifest = kind === 'extension' && f.path === 'manifest.json';
    checkNormalized(f.path, f.content, rep);
    // Match patterns in the manifest are web addresses by design; its text is checked field by field.
    rawScan(f.path, f.content, rep, { urls: !isManifest });
    if (isManifest) manifest = checkManifest(f.content, bundle, opts, rep);
    else if (ext === '.html') checkHtml(f.content, { path: f.path, bundle }, rep);
    else if (ext === '.css') checkCss(f.content, f.path, rep);
    else checkJs(f.content, { kind, path: f.path, bundle }, rep, usage);
  }
  if (rep.reasons.length) return done();

  // ── What it can touch ──
  const access: string[] = [];
  const warnings: string[] = [];
  const has = (...names: string[]) => names.some(n => usage.ids.has(n));
  if (kind === 'apps-script') {
    const writes = [...usage.ids].some(n => DOC_WRITE_RE.test(n));
    if (has('DocumentApp')) access.push('Reads and changes the Google Doc it is attached to');
    if (has('SpreadsheetApp')) access.push('Reads the Google Sheet it is attached to and can change its formatting');
    if (has('SlidesApp')) access.push('Reads and changes the Google Slides file it is attached to');
    if (has('createMenu', 'createAddonMenu', 'addToUi')) access.push(has('DocumentApp') ? 'Adds a menu to your Google Doc' : 'Adds a menu to your Google file');
    if (writes) warnings.push('It can change your document. Use Undo or the version history to go back.');
    const auto = ['onOpen', 'onEdit', 'onSelectionChange', 'onInstall'].filter(n => usage.declaredFunctions.has(n) || usage.ids.has(n));
    if (auto.length) warnings.push('Part of it runs by itself when you open or edit the document.');
    if (has('createMenu', 'createAddonMenu')) access.push('Runs when you pick it from that menu');
    else if (!auto.length) access.push('Runs when you run it from the script editor');
  } else {
    if (has(...READ_IDS)) access.push('Reads the text on the page you are on');
    if (has('getSelection')) access.push('Reads the text you selected');
    if (has(...CHANGE_IDS) || usage.assignsText || usage.usesStyle || files.some(f => extOf(f.path) === '.css')) {
      access.push('Changes how the page looks');
      warnings.push('It changes what you see on the page. Reload the page to put it back.');
    }
    if (has('clipboard')) access.push('Writes to your clipboard');
    if (kind === 'bookmarklet' || manifest.popup) access.push('Runs when you click it');
    for (const pattern of manifest.patterns) access.push(`Runs automatically on pages matching ${pattern}`);
    if (manifest.patterns.length) warnings.push('It runs by itself on those pages, without you clicking anything.');
  }
  access.push('Sends nothing anywhere');
  return done(access, warnings);
}

/*
 * What this cannot see (kept honest on purpose):
 *  - It reads names, not values. Anything reachable only through names that
 *    are not on a deny list, in a way no rule above anticipates, passes.
 *  - Text written into an element that happens to be a <style> tag already on
 *    the page (reached by a selector) is not followed.
 *  - It does not know which element a variable holds.
 * The tool is still only ever shown to the author as code; Fibb never runs it.
 */
