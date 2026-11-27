/**
 * Manuscript text extraction and chapter splitting (pure functions).
 *
 * Turns the bytes of a .docx / .md / .txt / .rtf file into a list of
 * paragraphs with heading levels, and turns a set of such files into an
 * ordered chapter list. Nothing here touches the filesystem: the caller
 * (ManuscriptLibrary) reads the author's files, read-only, and hands the
 * bytes in.
 */
import AdmZip from 'adm-zip';
import { inflateRawSync } from 'zlib';

/** One paragraph. `h` is a heading level: 0 = document title, 1..9 = Heading N. */
export interface Para { t: string; h?: number }

/** Hard cap on the uncompressed size of word/document.xml (zip bomb guard). */
export const MAX_DOCUMENT_XML_BYTES = 40 * 1024 * 1024;

/** Thrown for a file Fibb cannot read. The message is safe to show the author. */
export class UnreadableFileError extends Error {}

export const READABLE_EXTENSIONS = ['.docx', '.md', '.markdown', '.txt', '.rtf'];
/** Formats an author may well have that Fibb cannot read yet. */
export const KNOWN_UNREADABLE_EXTENSIONS = ['.doc', '.scriv', '.scrivx', '.pages', '.odt', '.pdf', '.wpd', '.wps', '.epub'];

export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}

export function countWords(text: string): number {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}

// ── docx ──

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,5});/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
      try { return String.fromCodePoint(code); } catch { return ''; }
    }
    return XML_ENTITIES[body] ?? whole;
  });
}

function attr(attrs: string, name: string): string | undefined {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  return m ? (m[1] ?? m[2]) : undefined;
}

function headingLevel(style: string | undefined, outline: number | undefined): number | undefined {
  if (style) {
    const s = style.toLowerCase().replace(/[\s_-]/g, '');
    if (s === 'title') return 0;
    const m = s.match(/^heading([1-9])$/);
    if (m) return Number(m[1]);
  }
  if (outline !== undefined && outline >= 0 && outline <= 8) return outline + 1;
  return undefined;
}

/** Elements whose whole content is ignored: tracked deletions, moved-away text, images, fallbacks. */
const DOCX_SKIP = new Set(['w:del', 'w:moveFrom', 'w:drawing', 'w:pict', 'w:object', 'mc:Fallback']);
const XML_TOKEN = /<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g;

/** Paragraphs of a WordprocessingML body. Exported for tests. */
export function parseDocumentXml(xml: string): Para[] {
  const out: Para[] = [];
  let skipDepth = 0;
  let pDepth = 0;
  let inPPr = false;
  let inText = false;
  let text = '';
  let style: string | undefined;
  let outline: number | undefined;
  XML_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = XML_TOKEN.exec(xml)) !== null) {
    if (m[5] !== undefined) {
      if (inText && skipDepth === 0 && pDepth > 0) text += decodeXml(m[5]);
      continue;
    }
    const closing = m[1] === '/';
    const name = m[2];
    const selfClosing = m[4] === '/';
    if (skipDepth > 0) {
      if (selfClosing) continue;
      skipDepth += closing ? -1 : 1;
      continue;
    }
    if (!closing && !selfClosing && DOCX_SKIP.has(name)) { skipDepth = 1; continue; }
    switch (name) {
      case 'w:p':
        if (selfClosing) break;
        if (!closing) {
          pDepth++;
          if (pDepth === 1) { text = ''; style = undefined; outline = undefined; inPPr = false; inText = false; }
        } else if (pDepth > 0) {
          pDepth--;
          if (pDepth === 0) {
            const t = text.replace(/[ \t]+\n/g, '\n').trim();
            if (t) {
              const h = headingLevel(style, outline);
              out.push(h === undefined ? { t } : { t, h });
            }
          } else {
            text += '\n';
          }
        }
        break;
      case 'w:pPr':
        if (!selfClosing && pDepth === 1) inPPr = !closing;
        break;
      case 'w:pStyle':
        if (pDepth === 1 && inPPr) style = attr(m[3], 'w:val');
        break;
      case 'w:outlineLvl':
        if (pDepth === 1 && inPPr) {
          const n = Number(attr(m[3], 'w:val'));
          if (Number.isInteger(n)) outline = n;
        }
        break;
      case 'w:t':
        if (!selfClosing) inText = !closing;
        break;
      case 'w:tab':
        if (pDepth > 0 && !inPPr && !closing) text += '\t';
        break;
      case 'w:br':
      case 'w:cr':
        if (pDepth > 0 && !closing) text += '\n';
        break;
      case 'w:noBreakHyphen':
        if (pDepth > 0 && !closing) text += '-';
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Paragraphs of a .docx. Comments, footnote references, images and tracked
 * deletions are left out. Throws UnreadableFileError for anything that is not
 * a plain, unencrypted Word file of a sane size.
 */
export function extractDocx(buf: Buffer, maxXmlBytes = MAX_DOCUMENT_XML_BYTES): Para[] {
  let xml: string;
  try {
    const zip = new AdmZip(buf);
    const entry = zip.getEntry('word/document.xml');
    if (!entry) throw new UnreadableFileError('This is not a Word document Fibb can read.');
    const header: any = entry.header;
    if (header.encrypted || (Number(header.flags) & 1) === 1) throw new UnreadableFileError('This Word file is password protected.');
    if (Number(header.size) > maxXmlBytes) throw new UnreadableFileError('This Word file is too large to read.');
    const method = Number(header.method);
    const compressed = entry.getCompressedData();
    let raw: Buffer;
    if (method === 0) {
      raw = compressed;
    } else if (method === 8) {
      // Inflate ourselves so the cap holds even when the zip header lies about the size.
      raw = inflateRawSync(compressed, { maxOutputLength: maxXmlBytes });
    } else {
      throw new UnreadableFileError('This Word file uses a compression Fibb cannot read.');
    }
    if (raw.length > maxXmlBytes) throw new UnreadableFileError('This Word file is too large to read.');
    xml = raw.toString('utf8');
  } catch (err) {
    if (err instanceof UnreadableFileError) throw err;
    const code = String((err as any)?.code || '');
    if (code === 'ERR_BUFFER_TOO_LARGE') throw new UnreadableFileError('This Word file is too large to read.');
    throw new UnreadableFileError('This Word file is damaged or is not a real .docx.');
  }
  const bodyAt = xml.indexOf('<w:body');
  if (bodyAt < 0) throw new UnreadableFileError('This Word file has no text Fibb can read.');
  return parseDocumentXml(xml.slice(bodyAt));
}

// ── plain text, Markdown ──

/** Windows-1252 differs from Latin-1 only in 0x80..0x9f (curly quotes, dashes, the euro sign). */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];
function decodeCp1252(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : b);
  return out;
}

/** Decode a text file: UTF-8 (with or without BOM), UTF-16 with a BOM, else Windows-1252. */
export function decodeText(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  const start = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
  const utf8 = buf.subarray(start).toString('utf8');
  return utf8.includes('�') ? decodeCp1252(buf.subarray(start)) : utf8;
}

const NUM_WORD = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)';
const NUMBERED_HEADING = new RegExp(`^(?:chapter|part)\\s+(?:\\d{1,4}|[ivxlcdm]{1,8}|${NUM_WORD}(?:[\\s-]${NUM_WORD})*)(?![\\w'’])`, 'i');
const NAMED_HEADING = /^(?:prologue|epilogue|interlude)(?![\w'’])/i;
const BARE_HEADING = /^(?:chapter|part)$/i;

const WORD_VALUES: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** The chapter number a title states: "Chapter 7", "7. The Storm", "Chapter Twenty-One". null when it has none. */
export function chapterNumberOfTitle(title: string): number | null {
  const t = String(title ?? '').trim().toLowerCase();
  const digits = t.match(/^(?:chapter\s+)?(\d{1,4})(?!\d)/);
  if (digits) return Number(digits[1]);
  const m = t.match(/^chapter\s+([a-z]+(?:[\s-][a-z]+)?)/);
  if (!m) return null;
  const [first, second] = m[1].split(/[\s-]/);
  const a = WORD_VALUES[first];
  if (a === undefined) return null;
  const b = second !== undefined ? WORD_VALUES[second] : undefined;
  return a >= 20 && b !== undefined && b < 10 ? a + b : a;
}

/** Remove Markdown emphasis and heading marks around a line. */
function unmark(line: string): string {
  return line.trim().replace(/^#{1,6}\s+/, '').replace(/^[*_]{1,3}/, '').replace(/[*_]{1,3}$/, '').trim();
}

/**
 * Does this line look like a chapter heading? "Chapter 12", "Chapter Twelve:
 * The Storm", "PART II", "Prologue", "Epilogue", "Interlude", or a line that
 * is only a number ("7" or "7.").
 */
export function isChapterLine(raw: string): boolean {
  const t = unmark(String(raw ?? ''));
  if (!t || t.length > 90 || t.includes('\n')) return false;
  if (/^\d{1,4}\.?$/.test(t)) return true;
  const words = countWords(t);
  if (BARE_HEADING.test(t)) return true;
  if (NUMBERED_HEADING.test(t)) return words <= 14;
  if (NAMED_HEADING.test(t)) return words <= 8 && !/[.!?,;]$/.test(t);
  return false;
}

/**
 * Paragraphs of a plain-text or Markdown file. Blank lines separate
 * paragraphs; a chapter line or a Markdown heading is always its own
 * paragraph.
 */
export function textToParas(text: string, markdown: boolean): Para[] {
  let src = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (markdown) {
    const fm = src.match(/^---\n[\s\S]*?\n(?:---|\.\.\.)\n/);
    if (fm) src = src.slice(fm[0].length);
  }
  const out: Para[] = [];
  let cur: string[] = [];
  const flush = () => {
    if (!cur.length) return;
    const t = cur.join('\n').trim();
    if (t) out.push({ t });
    cur = [];
  };
  for (const line of src.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) { flush(); continue; }
    if (markdown) {
      const h = trimmed.match(/^(#{1,6})\s+(.+?)\s*#*$/);
      if (h) { flush(); out.push({ t: h[2].trim(), h: h[1].length }); continue; }
    }
    if (isChapterLine(trimmed)) { flush(); out.push({ t: unmark(trimmed) }); continue; }
    cur.push(line.replace(/\s+$/, ''));
  }
  flush();
  return out;
}

// ── RTF ──

const RTF_SKIP_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'headerl', 'headerr', 'headerf',
  'footer', 'footerl', 'footerr', 'footerf', 'footnote', 'object', 'themedata', 'colorschememapping',
  'datastore', 'latentstyles', 'generator', 'listtable', 'listoverridetable', 'rsidtbl', 'xmlnstbl',
  'fldinst', 'annotation', 'atnid', 'atnauthor', 'atndate', 'bkmkstart', 'bkmkend', 'nonshppict', 'shppict',
]);
const RTF_CHARS: Record<string, string> = {
  tab: '\t', emdash: '—', endash: '–', lquote: '‘', rquote: '’',
  ldblquote: '“', rdblquote: '”', bullet: '•', emspace: ' ', enspace: ' ',
};

/** Plain text of an RTF file (simple, tolerant reader; formatting is dropped). */
export function rtfToText(buf: Buffer): string {
  const s = buf.toString('latin1');
  if (!s.startsWith('{\\rtf')) throw new UnreadableFileError('This is not an RTF file Fibb can read.');
  const out: string[] = [];
  const stack: Array<{ skip: boolean; uc: number }> = [];
  let state = { skip: false, uc: 1 };
  let pendingSkip = 0;
  const emit = (text: string) => {
    if (state.skip) return;
    if (pendingSkip > 0) { pendingSkip--; return; }
    out.push(text);
  };
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === '{') { stack.push(state); state = { ...state }; i++; continue; }
    if (c === '}') { state = stack.pop() ?? { skip: false, uc: 1 }; pendingSkip = 0; i++; continue; }
    if (c === '\r' || c === '\n') { i++; continue; }
    if (c !== '\\') { emit(c); i++; continue; }
    const next = s[i + 1];
    if (next === undefined) break;
    if (next === '\\' || next === '{' || next === '}') { emit(next); i += 2; continue; }
    if (next === '*') { state.skip = true; i += 2; continue; }
    if (next === '~') { emit(' '); i += 2; continue; }
    if (next === '_') { emit('-'); i += 2; continue; }
    if (next === '-' || next === '|' || next === ':') { i += 2; continue; }
    if (next === '\n' || next === '\r') { if (!state.skip) out.push('\n\n'); i += 2; continue; }
    if (next === "'") {
      const code = parseInt(s.slice(i + 2, i + 4), 16);
      if (Number.isFinite(code)) emit(decodeCp1252(Uint8Array.of(code)));
      i += 4;
      continue;
    }
    const m = /^([a-zA-Z]+)(-?\d+)? ?/.exec(s.slice(i + 1, i + 48));
    if (!m) { i += 2; continue; }
    i += 1 + m[0].length;
    const word = m[1];
    const num = m[2] !== undefined ? Number(m[2]) : undefined;
    if (RTF_SKIP_DESTINATIONS.has(word)) { state.skip = true; continue; }
    if (word === 'bin') { i += Math.max(0, num ?? 0); continue; }
    if (state.skip) continue;
    if (word === 'par' || word === 'sect' || word === 'page') { out.push('\n\n'); continue; }
    if (word === 'line') { out.push('\n'); continue; }
    if (word === 'uc') { state.uc = Math.max(0, num ?? 1); continue; }
    if (word === 'u' && num !== undefined) {
      const code = num < 0 ? num + 65536 : num;
      try { out.push(String.fromCharCode(code)); } catch { /* skip a bad code */ }
      pendingSkip = state.uc;
      continue;
    }
    if (RTF_CHARS[word] !== undefined) emit(RTF_CHARS[word]);
  }
  return out.join('');
}

// ── One entry point ──

/** Paragraphs of a readable manuscript file, chosen by extension. */
export function extractParas(name: string, buf: Buffer): Para[] {
  const ext = extensionOf(name);
  if (ext === '.docx') return extractDocx(buf);
  if (ext === '.md' || ext === '.markdown') return textToParas(decodeText(buf), true);
  if (ext === '.txt') return textToParas(decodeText(buf), false);
  if (ext === '.rtf') return textToParas(rtfToText(buf), false);
  throw new UnreadableFileError('Fibb cannot read this kind of file yet.');
}

// ── Chapters ──

export interface ExtractedFile {
  /** Path relative to the book folder, with forward slashes. */
  rel: string;
  paras: Para[];
  words: number;
  modifiedAt: string;
}

export interface ChapterDraft {
  file: string;
  /** Position of this chapter inside its file (0-based; -1 for front matter). */
  ordinal: number;
  title: string;
  text: string;
  words: number;
  kind: 'chapter' | 'notes';
  modifiedAt: string;
}

const baseName = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1);
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export function titleFromFileName(rel: string): string {
  const t = baseName(rel).replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.slice(0, 120) || 'Untitled';
}

/**
 * Where a file sits in chapter order, judged by its name: a leading number
 * ("03 - The Storm"), "chapter 12", "ch-03", "prologue" (first) or
 * "epilogue" (last). null when the name does not look like a chapter.
 */
export function chapterFileOrder(rel: string): number | null {
  const base = baseName(rel).replace(/\.[^.]+$/, '').toLowerCase().trim();
  if (/^prologue(?![a-z])/.test(base)) return -1;
  if (/^epilogue(?![a-z])/.test(base)) return 1_000_000;
  const m = base.match(/^(?:chapter|chap|ch)[\s._-]*(\d{1,3})(?!\d)/)
    || base.match(/^(\d{1,3})(?!\d)/)
    || base.match(/(?:^|[^a-z])(?:chapter|chap|ch)[\s._-]*(\d{1,3})(?!\d)/);
  return m ? Number(m[1]) : null;
}

/** Natural order for chapter files: by chapter number, then by name ("ch2" before "ch10"). */
export function compareChapterFiles(a: string, b: string): number {
  const oa = chapterFileOrder(a);
  const ob = chapterFileOrder(b);
  if (oa !== null && ob !== null && oa !== ob) return oa - ob;
  if (oa !== null && ob === null) return -1;
  if (oa === null && ob !== null) return 1;
  return collator.compare(a, b);
}

const joinParas = (paras: Para[]): string => paras.map(p => p.t).join('\n\n');
const cleanTitle = (t: string): string => {
  const s = unmark(t).replace(/\s+/g, ' ').trim().slice(0, 120);
  return /^\d{1,4}\.?$/.test(s) ? `Chapter ${parseInt(s, 10)}` : s;
};

/** The whole file as one entry. A leading heading becomes the title. */
function wholeFile(f: ExtractedFile, kind: 'chapter' | 'notes'): ChapterDraft[] {
  let paras = f.paras;
  let title = titleFromFileName(f.rel);
  const first = paras[0];
  if (first && paras.length > 1 && (first.h !== undefined || isChapterLine(first.t))) {
    title = cleanTitle(first.t);
    paras = paras.slice(1);
    const sub = paras[0];
    if (sub && sub.h !== undefined && paras.length > 1 && isChapterLine(first.t) && !isChapterLine(sub.t)) {
      title = `${title}: ${cleanTitle(sub.t)}`.slice(0, 120);
      paras = paras.slice(1);
    }
  }
  const text = joinParas(paras);
  const words = countWords(text);
  if (!words) return [];
  return [{ file: f.rel, ordinal: 0, title, text, words, kind, modifiedAt: f.modifiedAt }];
}

/**
 * Split one manuscript file at its chapter headings. With no headings the
 * whole file is one chapter. Text before the first heading (title page,
 * dedication, a foreword) is kept as searchable "Front matter" notes when it
 * is more than a few lines (40 words or more).
 */
export function splitFileIntoChapters(f: ExtractedFile): ChapterDraft[] {
  const paras = f.paras;
  const counts: Record<number, number> = {};
  for (const p of paras) if (p.h !== undefined && p.h >= 1 && p.h <= 3) counts[p.h] = (counts[p.h] || 0) + 1;
  const level = [1, 2, 3].find(l => (counts[l] || 0) >= 2);
  const isPoint = (p: Para): boolean => {
    if (p.h === 0) return false;
    if (level !== undefined) return p.h === level || (p.h !== undefined && isChapterLine(p.t));
    return isChapterLine(p.t);
  };
  const points: number[] = [];
  paras.forEach((p, i) => { if (isPoint(p)) points.push(i); });
  if (points.length === 0) return wholeFile(f, 'chapter');

  const out: ChapterDraft[] = [];
  const front = joinParas(paras.slice(0, points[0]));
  const frontWords = countWords(front);
  let ordinal = 0;
  points.forEach((at, k) => {
    const end = k + 1 < points.length ? points[k + 1] : paras.length;
    let title = cleanTitle(paras[at].t);
    let from = at + 1;
    const sub = paras[from];
    if (sub && from < end - 1 && sub.h !== undefined && isChapterLine(paras[at].t) && !isPoint(sub)) {
      title = `${title}: ${cleanTitle(sub.t)}`.slice(0, 120);
      from++;
    }
    const text = joinParas(paras.slice(from, end));
    const words = countWords(text);
    // A heading with nothing under it (a "Part Two" divider) is not a chapter.
    if (!words) return;
    out.push({ file: f.rel, ordinal: ordinal++, title: title || `Chapter ${ordinal}`, text, words, kind: 'chapter', modifiedAt: f.modifiedAt });
  });
  if (out.length === 0) return wholeFile(f, 'chapter');
  if (frontWords >= 40) {
    out.push({ file: f.rel, ordinal: -1, title: 'Front matter', text: front, words: frontWords, kind: 'notes', modifiedAt: f.modifiedAt });
  }
  return out;
}

/**
 * The ordered chapter list for a book folder. Chapters first (in reading
 * order), then notes.
 *
 *  a. Two or more files named like chapters: one chapter per file, in
 *     natural order; every other file is notes. (Unless another, larger
 *     file is itself a whole manuscript with three or more chapters.)
 *  b. Otherwise the largest file is the manuscript and is split at its
 *     chapter headings; the other files are notes.
 *  c. A file with no chapter headings is one chapter.
 *
 * One addition: four or more files with no chapter-style names and no file
 * that clearly dominates (the largest holds under 35% of the words) are
 * treated as one chapter per file, in name order.
 */
export function buildChapters(files: ExtractedFile[]): ChapterDraft[] {
  const readable = files.filter(f => f.words > 0);
  if (readable.length === 0) return [];
  if (readable.length === 1) return splitFileIntoChapters(readable[0]);

  const sum = (list: ExtractedFile[]) => list.reduce((n, f) => n + f.words, 0);
  const chapterLike = readable.filter(f => chapterFileOrder(f.rel) !== null);
  const others = readable.filter(f => chapterFileOrder(f.rel) === null);
  const biggestOther = others.reduce((n, f) => Math.max(n, f.words), 0);

  // A whole manuscript in one file beside a few numbered scraps: the big file wins.
  const bigOther = others.find(f => f.words === biggestOther);
  const wholeBookElsewhere = !!bigOther && biggestOther > sum(chapterLike)
    && splitFileIntoChapters(bigOther).filter(c => c.kind === 'chapter').length >= 3;

  let chapterFiles: ExtractedFile[] | null = null;
  let noteFiles: ExtractedFile[] = [];
  if (chapterLike.length >= 2 && !wholeBookElsewhere) {
    chapterFiles = chapterLike;
    noteFiles = others;
  } else {
    const bySize = [...readable].sort((a, b) => b.words - a.words || collator.compare(a.rel, b.rel));
    if (readable.length >= 4 && bySize[0].words < 0.35 * sum(readable)) {
      chapterFiles = readable;
    } else {
      const notes = bySize.slice(1).sort((a, b) => collator.compare(a.rel, b.rel));
      return [...splitFileIntoChapters(bySize[0]), ...notes.flatMap(f => wholeFile(f, 'notes'))];
    }
  }
  const ordered = [...chapterFiles].sort((a, b) => compareChapterFiles(a.rel, b.rel));
  const sortedNotes = [...noteFiles].sort((a, b) => collator.compare(a.rel, b.rel));
  return [...ordered.flatMap(f => wholeFile(f, 'chapter')), ...sortedNotes.flatMap(f => wholeFile(f, 'notes'))];
}
