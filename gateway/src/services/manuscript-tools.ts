/**
 * Tools that let the model read the author's connected manuscript:
 * book_overview, book_read, book_search, book_facts.
 *
 * All four are read tools and exist only while at least one book folder is
 * connected. They take book titles, chapter numbers and search words, never
 * a file path. Their results are the author's own text (source
 * 'manuscript'): still scanned and wrapped like any tool result, but not
 * counted as content from outside.
 */
import type { Tool } from './tools/registry.js';
import { splitIntoParts, type ManuscriptLibrary, type BookView } from './manuscripts.js';

export const BOOK_READ_PART_CHARS = 5500;
const OVERVIEW_MAX_CHARS = 5800;
const TOOL_TIMEOUT_MS = 90_000;

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');
const str = (v: unknown, max = 200): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '').trim().slice(0, max);

export function manuscriptTools(lib: ManuscriptLibrary): Tool[] {
  const available = () => lib.hasBooks();

  /** The book a call is about. Throws a plain message the model can relay. */
  const pick = async (wanted: unknown): Promise<BookView> => {
    const name = str(wanted);
    const found = name ? lib.findBook(name) : lib.defaultBook();
    if (!found) {
      const titles = lib.list().map(b => `"${b.title}"`).join(', ');
      throw new Error(name ? `No connected book matches "${name}". Connected books: ${titles || 'none'}.` : 'No book folder is connected yet.');
    }
    await lib.refreshIfStale(found.id);
    return lib.get(found.id) ?? found;
  };

  const others = (book: BookView): string => {
    const rest = lib.list().filter(b => b.id !== book.id).map(b => `"${b.title}"`);
    return rest.length ? `\nOther connected books: ${rest.join(', ')}.` : '';
  };

  const overview: Tool = {
    name: 'book_overview',
    description: "The author's connected manuscript at a glance: title, word count and the chapter list with a short summary of each chapter where notes are ready. Start here for any question about the whole book.",
    args: '{"book": "optional book title"}',
    risk: 'read',
    source: 'manuscript',
    summary: 'Looking at your book…',
    timeoutMs: TOOL_TIMEOUT_MS,
    available,
    run: async (args) => {
      const book = await pick(args.book);
      const chapters = book.chapters.filter(c => c.kind === 'chapter');
      const notes = book.chapters.filter(c => c.kind === 'notes');
      const head =
        `${book.title}: ${chapters.length} chapter${chapters.length === 1 ? '' : 's'}, ${fmt(book.words)} words.` +
        (book.digestReady < chapters.length ? ` Story notes are ready for ${book.digestReady} of ${chapters.length} chapters.` : '') +
        (book.error ? `\nNote: ${book.error}` : '');
      const tail =
        (notes.length ? `\nNotes files (searchable with book_search, readable with book_read by title): ${notes.slice(0, 12).map(n => `"${n.title}"`).join(', ')}${notes.length > 12 ? ` and ${notes.length - 12} more` : ''}.` : '') +
        (book.unreadableCount ? `\n${book.unreadableCount} file${book.unreadableCount === 1 ? '' : 's'} in the folder could not be read (a format Fibb cannot read yet, too large, or damaged).` : '') +
        others(book);
      const line = (c: BookView['chapters'][number], summaryChars: number): string => {
        const summary = summaryChars > 0 ? lib.chapterSummary(book.id, c.id) : '';
        const cut = summary.length > summaryChars ? summary.slice(0, summaryChars - 1) + '…' : summary;
        return `${c.n}. ${c.title} (${fmt(c.words)} words, changed ${c.modifiedAt.slice(0, 10)})${cut ? `: ${cut}` : ''}`;
      };
      const room = OVERVIEW_MAX_CHARS - head.length - tail.length - 60;
      // Full summaries when they fit, then shorter ones, then none, then a shorter list.
      for (const summaryChars of [600, 160, 0]) {
        const lines = chapters.map(c => line(c, summaryChars));
        if (lines.join('\n').length <= room) return `${head}\n\nChapters:\n${lines.join('\n')}${tail}`;
      }
      const lines: string[] = [];
      let used = 0;
      for (const c of chapters) {
        const l = line(c, 0);
        if (used + l.length + 1 > room) break;
        lines.push(l);
        used += l.length + 1;
      }
      return `${head}\n\nChapters:\n${lines.join('\n')}\n…and ${chapters.length - lines.length} more chapters${tail}`;
    },
  };

  const read: Tool = {
    name: 'book_read',
    description: 'Read the text of one chapter of the connected manuscript, by chapter number or title. Long chapters come in parts: the result says "part N of M", so ask for the next part to keep reading.',
    args: '{"chapter": "number or title", "part": "optional part number, default 1", "book": "optional book title"}',
    risk: 'read',
    source: 'manuscript',
    summary: (args) => {
      const m = str(args?.chapter, 40).match(/^(?:chapter|ch\.?)?\s*(\d{1,4})$/i);
      return m ? `Reading chapter ${Number(m[1])}…` : 'Reading your manuscript…';
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    available,
    run: async (args) => {
      const book = await pick(args.book);
      const wanted = str(args.chapter);
      if (!wanted) throw new Error('Say which chapter: a number or a title.');
      const chapter = lib.findChapter(book.id, wanted);
      if (!chapter) throw new Error(`"${book.title}" has no chapter matching "${wanted}". Use book_overview to see the chapter list.`);
      const text = await lib.chapterText(book.id, chapter.id);
      if (text === null) throw new Error('That chapter could not be read just now.');
      const parts = splitIntoParts(text, BOOK_READ_PART_CHARS);
      const asked = Math.floor(Number(args.part) || 1);
      const part = Math.max(1, Math.min(parts.length, asked));
      const label = chapter.kind === 'chapter' ? `Chapter ${chapter.n}: "${chapter.title}"` : `Notes: "${chapter.title}"`;
      const more = part < parts.length ? `\n\n(Ask for part ${part + 1} to continue.)` : '\n\n(End of this chapter.)';
      return `${book.title}. ${label} (${fmt(chapter.words)} words), part ${part} of ${parts.length}.\n\n${parts[part - 1]}${more}`;
    },
  };

  const search: Tool = {
    name: 'book_search',
    description: 'Find a word or phrase in the connected manuscript and notes files. Returns passages with their chapter numbers, plus how many times it appears in each chapter. Good for checking a name, an eye color, a date or a place across the whole book.',
    args: '{"query": "word or phrase", "book": "optional book title"}',
    risk: 'read',
    source: 'manuscript',
    summary: 'Searching your manuscript…',
    timeoutMs: TOOL_TIMEOUT_MS,
    available,
    run: async (args) => {
      const query = str(args.query, 400).replace(/\s+/g, ' ');
      if (query.length < 2) throw new Error('Give a word or phrase to search for.');
      const book = await pick(args.book);
      const r = await lib.search(book.id, query, { limit: 10 });
      if (r.mode === 'none') return `Nothing in "${book.title}" matches "${r.query}". Try a shorter phrase or a single word.${others(book)}`;
      const where = (c: { n: number; title: string; kind: string }) => (c.kind === 'chapter' ? `ch ${c.n}` : `notes "${c.title}"`);
      const head = r.mode === 'phrase'
        ? `"${r.query}" appears ${r.total} time${r.total === 1 ? '' : 's'} in "${book.title}".`
        : `The exact phrase "${r.query}" is not in "${book.title}". ${r.total} paragraph${r.total === 1 ? '' : 's'} contain all of those words.`;
      const counts = r.counts.slice(0, 40).map(c => `${where(c)} (${c.count})`).join(', ');
      const hits = r.hits.map(h => `[${h.kind === 'chapter' ? `Chapter ${h.n}: ${h.title}` : `Notes: ${h.title}`}] ${h.text}`);
      let out = `${head}\nWhere: ${counts}${r.counts.length > 40 ? ` and ${r.counts.length - 40} more` : ''}\n\nPassages:`;
      for (const h of hits) {
        if (out.length + h.length + 2 > OVERVIEW_MAX_CHARS) break;
        out += `\n\n${h}`;
      }
      return out;
    },
  };

  const facts: Tool = {
    name: 'book_facts',
    description: "Fibb's story notes on the connected manuscript: the cast with what each chapter says about them, places, the timeline and open threads, each with chapter numbers. Give \"about\" to see only entries that mention a name or word.",
    args: '{"about": "optional name or word", "book": "optional book title"}',
    risk: 'read',
    source: 'manuscript',
    summary: 'Checking the story notes…',
    timeoutMs: TOOL_TIMEOUT_MS,
    available,
    run: async (args) => {
      const book = await pick(args.book);
      return lib.renderFacts(book.id, str(args.about, 80) || undefined);
    },
  };

  return [overview, read, search, facts];
}
