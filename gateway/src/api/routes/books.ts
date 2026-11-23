/**
 * Books: the author's manuscript folders (see services/manuscripts.ts).
 * Everything here is read-only towards the author's files.
 *
 *   GET    /api/fs/folders?path=            -> { path, parent, folders: [{ name, path, manuscriptFiles }], manuscriptFiles, home }
 *                                              Folder picker. Starts at the home folder; only folders inside it.
 *                                              Never returns file names or contents. 400 { error } otherwise.
 *   GET    /api/books                       -> { books: [Book] }
 *   POST   /api/books { folder, title? }    -> 201 { book } after a first scan; 400 { error } in plain words.
 *   PATCH  /api/books/:id { title }         -> { book }
 *   POST   /api/books/:id/scan              -> { book }
 *   DELETE /api/books/:id                   -> { ok: true }   (forgets the book; the folder is never touched)
 *   GET    /api/books/:id/chapters/:chapterId -> { title, n, words, text }   (text capped at 200,000 characters)
 *
 *   Book = { id, title, folder, words, chapterCount, notesCount, unreadableCount, lastScanAt?, digestReady,
 *            error?, chapters: [{ id, n, title, words, file, modifiedAt, kind }] }
 *
 * 404 for an unknown book or chapter, 503 when the service is missing.
 */
import type { Request, Response } from 'express';
import type { ApiContext } from '../context.js';
import { ManuscriptError } from '../../services/manuscripts.js';

export const CHAPTER_TEXT_MAX_CHARS = 200_000;

export function registerBookRoutes(ctx: ApiContext): void {
  const { app, services } = ctx;
  const missing = (res: Response) => res.status(503).json({ error: 'Books are not ready yet.' });
  const notFound = (res: Response) => res.status(404).json({ error: 'Book not found' });
  const fail = (res: Response, err: unknown) => {
    if (err instanceof ManuscriptError) return res.status(400).json({ error: err.message });
    return res.status(500).json({ error: 'Fibb could not do that just now. Try again in a moment.' });
  };

  app.get('/api/fs/folders', async (req: Request, res: Response) => {
    if (!services.manuscripts) return missing(res);
    const path = req.query?.path;
    if (path !== undefined && typeof path !== 'string') return res.status(400).json({ error: 'Choose a folder on this computer.' });
    try {
      res.json(await services.manuscripts.browseFolders(path || undefined));
    } catch (err) {
      fail(res, err);
    }
  });

  app.get('/api/books', (_req: Request, res: Response) => {
    if (!services.manuscripts) return missing(res);
    res.json({ books: services.manuscripts.list() });
  });

  app.post('/api/books', async (req: Request, res: Response) => {
    if (!services.manuscripts) return missing(res);
    const { folder, title } = req.body || {};
    if (typeof folder !== 'string' || !folder.trim()) return res.status(400).json({ error: 'Choose the folder your book is in.' });
    if (title !== undefined && typeof title !== 'string') return res.status(400).json({ error: 'title must be a string' });
    try {
      res.status(201).json({ book: await services.manuscripts.add(folder, title) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.patch('/api/books/:id', async (req: Request, res: Response) => {
    if (!services.manuscripts) return missing(res);
    const title = req.body?.title;
    if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'Give the book a title.' });
    try {
      const book = await services.manuscripts.rename(String(req.params.id), title);
      if (!book) return notFound(res);
      res.json({ book });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post('/api/books/:id/scan', async (req: Request, res: Response) => {
    if (!services.manuscripts) return missing(res);
    const id = String(req.params.id);
    if (!services.manuscripts.get(id)) return notFound(res);
    try {
      await services.manuscripts.scan(id);
      const book = services.manuscripts.get(id);
      if (!book) return notFound(res);
      res.json({ book });
    } catch (err) {
      fail(res, err);
    }
  });

  app.delete('/api/books/:id', async (req: Request, res: Response) => {
    if (!services.manuscripts) return missing(res);
    try {
      if (!(await services.manuscripts.remove(String(req.params.id)))) return notFound(res);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  app.get('/api/books/:id/chapters/:chapterId', async (req: Request, res: Response) => {
    if (!services.manuscripts) return missing(res);
    try {
      if (!services.manuscripts.get(String(req.params.id))) return notFound(res);
      const c = await services.manuscripts.chapter(String(req.params.id), String(req.params.chapterId));
      if (!c) return res.status(404).json({ error: 'Chapter not found' });
      res.json({ title: c.title, n: c.n, words: c.words, text: c.text.slice(0, CHAPTER_TEXT_MAX_CHARS) });
    } catch (err) {
      fail(res, err);
    }
  });
}
