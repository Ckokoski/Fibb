import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, existsSync, appendFileSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { registerBookRoutes, CHAPTER_TEXT_MAX_CHARS } from './books.js';
import { ManuscriptLibrary } from '../../services/manuscripts.js';

type Handler = (req: any, res: any) => any;

function harness(services: any) {
  const routes = new Map<string, Handler>();
  const reg = (m: string) => (path: string, h: Handler) => { routes.set(`${m} ${path}`, h); };
  const app: any = { get: reg('GET'), post: reg('POST'), patch: reg('PATCH'), delete: reg('DELETE') };
  registerBookRoutes({ app, gateway: {}, services, baseDir: '' });
  const call = async (key: string, opts: { params?: any; body?: any; query?: any } = {}) => {
    const res: any = { code: 200, body: undefined };
    res.status = (c: number) => { res.code = c; return res; };
    res.json = (b: any) => { res.body = b; return res; };
    await routes.get(key)!({ params: opts.params || {}, body: opts.body, query: opts.query || {} }, res);
    return res as { code: number; body: any };
  };
  return { call, routes };
}

const prose = (words: number, seed = 'reed'): string => Array.from({ length: words }, (_, i) => `${seed}${i}`).join(' ');

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d).sort()) {
      const abs = join(d, name);
      const st = lstatSync(abs);
      const r = rel ? `${rel}/${name}` : name;
      if (st.isDirectory()) { out.push(`${r}/`); walk(abs, r); }
      else out.push(`${r} ${st.size} ${Math.round(st.mtimeMs)} ${createHash('sha256').update(readFileSync(abs)).digest('hex')}`);
    }
  };
  walk(dir, '');
  return out;
}

let root: string;
let home: string;
let ws: string;
let book: string;
let words: number[];
let lib: ManuscriptLibrary;
let h: ReturnType<typeof harness>;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'fibb-book-routes-'));
  home = join(root, 'home');
  ws = join(root, 'ws');
  book = join(home, 'Writing', 'The Lantern Marsh');
  put(join(book, 'ch1.md'), `# Chapter One\n\nMara Venn rowed out at dawn.\n\n${prose(20)}`);
  put(join(book, 'ch2.md'), `# Chapter Two\n\nTobin Ashgrove waited on the jetty.\n\n${prose(30)}`);
  put(join(book, 'notes.txt'), 'Loose notes about the marsh.');
  put(join(book, 'old.doc'), 'legacy');
  words = [];
  lib = new ManuscriptLibrary(ws, {
    homeDir: home,
    addWords: n => { words.push(n); },
    complete: async () => JSON.stringify({ summary: 'Something happens.', characters: [{ name: 'Mara Venn', facts: ['rows a ferry'] }] }),
  });
  await lib.initialize();
  h = harness({ manuscripts: lib });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('book routes', () => {
  it('503 on every route when the service is missing', async () => {
    const bare = harness({});
    expect([...bare.routes.keys()].sort()).toEqual([
      'DELETE /api/books/:id', 'GET /api/books', 'GET /api/books/:id/chapters/:chapterId', 'GET /api/fs/folders',
      'PATCH /api/books/:id', 'POST /api/books', 'POST /api/books/:id/scan',
    ]);
    for (const key of bare.routes.keys()) {
      const r = await bare.call(key, { params: { id: 'x', chapterId: 'y' }, body: {} });
      expect(r.code, key).toBe(503);
      expect(typeof r.body.error).toBe('string');
    }
  });

  it('GET /api/fs/folders: starts at home, lists folders only, 400 outside home', async () => {
    put(join(home, 'top.docx'), 'x');
    mkdirSync(join(home, '.ssh'));
    mkdirSync(join(home, 'AppData'));
    const top = await h.call('GET /api/fs/folders');
    expect(top.code).toBe(200);
    expect(Object.keys(top.body).sort()).toEqual(['folders', 'home', 'manuscriptFiles', 'parent', 'path']);
    expect(top.body.path).toBe(top.body.home);
    expect(top.body.parent).toBeNull();
    expect(top.body.manuscriptFiles).toBe(1);
    expect(top.body.folders.map((f: any) => [f.name, f.manuscriptFiles])).toEqual([['Writing', 0]]);

    const inner = await h.call('GET /api/fs/folders', { query: { path: join(home, 'Writing') } });
    expect(inner.body.parent).toBe(top.body.home);
    expect(inner.body.folders).toEqual([{ name: 'The Lantern Marsh', path: join(inner.body.path, 'The Lantern Marsh'), manuscriptFiles: 3 }]);
    expect((await h.call('GET /api/fs/folders', { query: { path: '' } })).body.path).toBe(top.body.home);

    for (const path of [root, join(home, '..'), join(home, '.ssh'), join(home, 'AppData'), join(home, 'nope'), 'relative', ['a', 'b'], join(book, 'ch1.md')]) {
      const r = await h.call('GET /api/fs/folders', { query: { path } });
      expect(r.code, String(path)).toBe(400);
      expect(typeof r.body.error).toBe('string');
    }
    expect((await h.call('GET /api/fs/folders', { query: { path: root } })).body).toEqual({ error: 'That folder is outside your home folder.' });
  });

  it('POST /api/books: 201 with the scanned book; plain 400s', async () => {
    expect((await h.call('GET /api/books')).body).toEqual({ books: [] });

    const r = await h.call('POST /api/books', { body: { folder: book } });
    expect(r.code).toBe(201);
    const b = r.body.book;
    expect(Object.keys(b).sort()).toEqual(['chapterCount', 'chapters', 'digestReady', 'folder', 'id', 'lastScanAt', 'notesCount', 'title', 'unreadableCount', 'words']);
    expect(b).toMatchObject({ title: 'The Lantern Marsh', chapterCount: 2, notesCount: 1, unreadableCount: 1, digestReady: 0 });
    expect(b.words).toBe(b.chapters.filter((c: any) => c.kind === 'chapter').reduce((n: number, c: any) => n + c.words, 0));
    expect(b.chapters.map((c: any) => [c.n, c.title, c.kind, c.file])).toEqual([[1, 'Chapter One', 'chapter', 'ch1.md'], [2, 'Chapter Two', 'chapter', 'ch2.md'], [0, 'notes', 'notes', 'notes.txt']]);
    for (const c of b.chapters) expect(Object.keys(c).sort()).toEqual(['file', 'id', 'kind', 'modifiedAt', 'n', 'title', 'words']);
    expect((await h.call('GET /api/books')).body).toEqual({ books: [b] });

    const bad: Array<[any, number, string | RegExp]> = [
      [{}, 400, 'Choose the folder your book is in.'],
      [{ folder: '   ' }, 400, 'Choose the folder your book is in.'],
      [{ folder: 7 }, 400, 'Choose the folder your book is in.'],
      [{ folder: book, title: 5 }, 400, 'title must be a string'],
      [{ folder: root }, 400, 'That folder is outside your home folder.'],
      [{ folder: join(home, '..', 'elsewhere') }, 400, 'That folder is outside your home folder.'],
      [{ folder: home }, 400, /not your whole home folder/],
      [{ folder: book }, 400, /already one of your books/],
      [{ folder: join(home, 'Writing', 'missing') }, 400, /could not find that folder/],
    ];
    mkdirSync(join(home, 'Empty'));
    put(join(home, 'Empty', 'picture.png'), 'x');
    bad.push([{ folder: join(home, 'Empty') }, 400, 'Fibb did not find any Word, Markdown or text files there.']);
    for (const [body, code, error] of bad) {
      const res = await h.call('POST /api/books', { body });
      expect(res.code, JSON.stringify(body)).toBe(code);
      if (typeof error === 'string') expect(res.body).toEqual({ error });
      else expect(res.body.error).toMatch(error);
    }
    expect((await h.call('GET /api/books')).body.books).toHaveLength(1);

    const titled = await h.call('POST /api/books', { body: { folder: (put(join(home, 'Side', 'draft.md'), prose(9)), join(home, 'Side')), title: ' Salt and Reed ' } });
    expect(titled.code).toBe(201);
    expect(titled.body.book.title).toBe('Salt and Reed');
  });

  it('PATCH renames; POST scan rescans and reports new words; unknown ids are 404', async () => {
    const id = (await h.call('POST /api/books', { body: { folder: book } })).body.book.id;
    const renamed = await h.call('PATCH /api/books/:id', { params: { id }, body: { title: '  Marsh Light ' } });
    expect(renamed.code).toBe(200);
    expect(renamed.body.book).toMatchObject({ id, title: 'Marsh Light', chapterCount: 2 });
    expect((await h.call('PATCH /api/books/:id', { params: { id }, body: {} })).code).toBe(400);
    expect((await h.call('PATCH /api/books/:id', { params: { id }, body: { title: '  ' } })).code).toBe(400);
    expect((await h.call('PATCH /api/books/:id', { params: { id }, body: { title: 9 } })).code).toBe(400);
    expect((await h.call('PATCH /api/books/:id', { params: { id: 'nope' }, body: { title: 'x' } })).code).toBe(404);

    appendFileSync(join(book, 'ch2.md'), ` ${prose(25, 'new')}`);
    const before = lib.get(id)!.words;
    const scanned = await h.call('POST /api/books/:id/scan', { params: { id } });
    expect(scanned.code).toBe(200);
    expect(scanned.body.book.words).toBe(before + 25);
    expect(scanned.body.book.title).toBe('Marsh Light');
    expect(words).toEqual([25]);
    expect((await h.call('POST /api/books/:id/scan', { params: { id: 'nope' } })).code).toBe(404);

    // digestReady counts chapters with story notes.
    await lib.ensureDigest(id);
    expect((await h.call('GET /api/books')).body.books[0].digestReady).toBe(2);
  });

  it('GET a chapter: title, number, words and text, capped at 200,000 characters', async () => {
    put(join(book, 'ch3.md'), `# Chapter Three\n\n${'marsh '.repeat(50_000)}`);
    const b = (await h.call('POST /api/books', { body: { folder: book } })).body.book;
    const r = await h.call('GET /api/books/:id/chapters/:chapterId', { params: { id: b.id, chapterId: b.chapters[1].id } });
    expect(r.code).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['n', 'text', 'title', 'words']);
    expect(r.body).toMatchObject({ title: 'Chapter Two', n: 2, words: b.chapters[1].words });
    expect(r.body.text.startsWith('Tobin Ashgrove waited on the jetty.')).toBe(true);

    const long = await h.call('GET /api/books/:id/chapters/:chapterId', { params: { id: b.id, chapterId: b.chapters[2].id } });
    expect(long.body.words).toBe(50_000);
    expect(long.body.text.length).toBe(CHAPTER_TEXT_MAX_CHARS);
    expect(CHAPTER_TEXT_MAX_CHARS).toBe(200_000);

    for (const params of [{ id: b.id, chapterId: 'nope' }, { id: b.id, chapterId: '../index' }, { id: 'nope', chapterId: b.chapters[0].id }]) {
      expect((await h.call('GET /api/books/:id/chapters/:chapterId', { params })).code, JSON.stringify(params)).toBe(404);
    }
  });

  it('DELETE forgets the book and leaves the folder byte-identical', async () => {
    const before = snapshot(book);
    const id = (await h.call('POST /api/books', { body: { folder: book } })).body.book.id;
    await h.call('POST /api/books/:id/scan', { params: { id } });
    await lib.ensureDigest(id);
    expect(existsSync(join(ws, 'manuscripts', id, 'index.json'))).toBe(true);
    expect(existsSync(join(ws, 'manuscripts', id, 'digest.json'))).toBe(true);

    const r = await h.call('DELETE /api/books/:id', { params: { id } });
    expect(r.code).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(snapshot(book)).toEqual(before);
    expect(before).toHaveLength(4);
    expect(existsSync(join(ws, 'manuscripts', id))).toBe(false);
    expect((await h.call('GET /api/books')).body).toEqual({ books: [] });
    expect((await h.call('DELETE /api/books/:id', { params: { id } })).code).toBe(404);
    expect((await h.call('DELETE /api/books/:id', { params: { id: '../..' } })).code).toBe(404);
    // The folder can be added again afterwards.
    expect((await h.call('POST /api/books', { body: { folder: book } })).code).toBe(201);
  });

  it('an unexpected failure is a plain 500, never a stack trace', async () => {
    const broken = harness({ manuscripts: {
      add: async () => { throw new Error('EPERM: secret path C:/x'); },
      browseFolders: async () => { throw new Error('boom'); },
      get: () => ({}), list: () => [],
      scan: async () => { throw new Error('boom'); },
      remove: async () => { throw new Error('boom'); },
      rename: async () => { throw new Error('boom'); },
      chapter: async () => { throw new Error('boom'); },
    } });
    const calls: Array<[string, any]> = [
      ['POST /api/books', { body: { folder: 'C:/x' } }], ['GET /api/fs/folders', {}],
      ['POST /api/books/:id/scan', { params: { id: 'a' } }], ['DELETE /api/books/:id', { params: { id: 'a' } }],
      ['PATCH /api/books/:id', { params: { id: 'a' }, body: { title: 't' } }],
      ['GET /api/books/:id/chapters/:chapterId', { params: { id: 'a', chapterId: 'b' } }],
    ];
    for (const [key, opts] of calls) {
      const r = await broken.call(key, opts);
      expect(r.code, key).toBe(500);
      expect(r.body).toEqual({ error: 'Fibb could not do that just now. Try again in a moment.' });
    }
  });
});
