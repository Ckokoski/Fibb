import { useCallback, useEffect, useState } from 'react';
import { runPlay } from '../lib/tasks';
import { Ico } from './icons';

interface Chapter { id: string; n: number; title: string; words: number; file: string; modifiedAt: string; kind: 'chapter' | 'notes' }
interface Book {
  id: string; title: string; folder: string; words: number; chapterCount: number; notesCount: number; unreadableCount: number;
  lastScanAt?: string; digestReady: number; error?: string; chapters: Chapter[];
}
interface Listing { path: string; parent: string | null; folders: Array<{ name: string; path: string; manuscriptFiles: number }>; manuscriptFiles: number; home: string }

async function api<T>(url: string, init: RequestInit | undefined, fallback: T): Promise<T & { error?: string }> {
  try {
    const r = await fetch(url, init);
    const body = await r.json().catch(() => ({}));
    return r.ok ? body : { ...fallback, error: body.error || `HTTP ${r.status}` };
  } catch { return { ...fallback, error: 'Fibb is not reachable.' }; }
}
const send = (method: string, body?: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const ago = (iso?: string) => {
  if (!iso) return 'not yet';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 2 ? 'just now' : m < 60 ? `${m} minutes ago` : m < 1440 ? `${Math.round(m / 60)} hours ago` : `${Math.round(m / 1440)} days ago`;
};

/** Walks the folders inside the author's home folder so they can point Fibb at their manuscript. */
function FolderPicker({ onPick, onCancel }: { onPick: (folder: string) => Promise<string | null>; onCancel: () => void }) {
  const [at, setAt] = useState<Listing | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = useCallback(async (path?: string) => {
    setErr('');
    const r = await api<Listing | null>(`/api/fs/folders${path ? `?path=${encodeURIComponent(path)}` : ''}`, undefined, null);
    if (r && 'path' in r && r.path) setAt(r as Listing); else setErr((r as any)?.error || 'Fibb could not open that folder.');
  }, []);
  useEffect(() => { void go(); }, [go]);
  const name = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;
  return (
    <section className="card picker-card" role="dialog" aria-label="Choose your manuscript folder">
      <div className="t">Where does your book live?</div>
      <div className="s">Open the folder that holds your manuscript, then choose it. Fibb reads Word, Markdown and plain text files.</div>
      {at && (
        <>
          <div className="crumbs">
            <button className="btn quiet" disabled={!at.parent} onClick={() => at.parent && go(at.parent)} aria-label="Up one folder">↑ Up</button>
            <span className="crumb" title={at.path}>{at.path === at.home ? 'Your home folder' : name(at.path)}</span>
            {at.manuscriptFiles > 0 && <span className="badge on-badge">{at.manuscriptFiles} readable {at.manuscriptFiles === 1 ? 'file' : 'files'} here</span>}
          </div>
          <div className="folders">
            {at.folders.map(f => (
              <button key={f.path} className="folder" onClick={() => go(f.path)}>
                <span className="fi">{Ico.book}</span><span className="grow">{f.name}</span>
                {f.manuscriptFiles > 0 && <span className="badge">{f.manuscriptFiles}</span>}
              </button>
            ))}
            {at.folders.length === 0 && <div className="s">No folders inside this one.</div>}
          </div>
        </>
      )}
      {err && <div className="s" role="alert" style={{ color: 'var(--red)' }}>{err}</div>}
      <div className="act">
        <button className="btn pri" disabled={!at || busy || at.path === at.home} onClick={async () => { if (!at) return; setBusy(true); const e = await onPick(at.path); setBusy(false); if (e) setErr(e); }}>
          {busy ? 'Reading your book…' : 'Use this folder'}
        </button>
        <button className="btn quiet" onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}

function Reader({ book, chapter, onClose }: { book: Book; chapter: Chapter; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => { void api<{ text?: string }>(`/api/books/${book.id}/chapters/${chapter.id}`, undefined, {}).then(r => setText(r.text ?? 'Fibb could not open this chapter.')); }, [book.id, chapter.id]);
  return (
    <div className="reader">
      <div className="keyhead"><b>{chapter.title}</b><span className="hint">{chapter.words.toLocaleString()} words</span><button className="btn quiet" onClick={onClose}>Close</button></div>
      <div className="reader-text">{text ?? 'Opening…'}</div>
    </div>
  );
}

const QUICK: Array<[string, string]> = [['consistency-check', 'Check for contradictions'], ['plot-hole-pass', 'Look for plot holes'], ['chapter-summaries', 'Summarize every chapter'], ['book-dashboard', 'Build a dashboard']];

function BookCard({ book, reload }: { book: Book; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [reading, setReading] = useState<Chapter | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const chapters = book.chapters.filter(c => c.kind === 'chapter');
  const notes = book.chapters.filter(c => c.kind === 'notes');
  return (
    <section className="card book">
      <div className="keyhead"><div className="t book-title">{book.title}</div><span className="hint">Checked {ago(book.lastScanAt)}</span></div>
      <div className="bookstats">
        <div><b>{book.words.toLocaleString()}</b><span>words</span></div>
        <div><b>{book.chapterCount}</b><span>{book.chapterCount === 1 ? 'chapter' : 'chapters'}</span></div>
        <div><b>{Math.min(book.digestReady, book.chapterCount)}/{book.chapterCount}</b><span>read by Fibb</span></div>
      </div>
      {book.error && <div className="s" role="alert" style={{ color: 'var(--red)' }}>{book.error}</div>}
      {book.unreadableCount > 0 && <div className="s">{book.unreadableCount} {book.unreadableCount === 1 ? 'file is' : 'files are'} in a format Fibb cannot read yet.</div>}
      <div className="act" style={{ flexWrap: 'wrap' }}>
        {QUICK.map(([id, label]) => (
          <button key={id} className="btn" disabled={busy} onClick={async () => { setBusy(true); const r = await runPlay(id); setBusy(false); setNote(r.ok ? 'On it. I will leave the result under Tasks for your review.' : (r.error || 'That did not work.')); }}>{label}</button>
        ))}
      </div>
      {note && <div className="s" role="status">{note}</div>}
      <div className="act">
        <button className="btn quiet" onClick={() => setOpen(o => !o)} aria-expanded={open}>{open ? 'Hide chapters' : 'Show chapters'}</button>
        <button className="btn quiet" disabled={busy} onClick={async () => { setBusy(true); await api(`/api/books/${book.id}/scan`, send('POST'), {}); setBusy(false); reload(); }}>Check for changes</button>
        <button className="btn quiet" onClick={async () => { if (!window.confirm(`Stop reading ${book.title}? Fibb forgets the folder. Your files are not touched.`)) return; await api(`/api/books/${book.id}`, { method: 'DELETE' }, {}); reload(); }}>Remove</button>
      </div>
      {reading && <Reader book={book} chapter={reading} onClose={() => setReading(null)} />}
      {open && (
        <div className="tasks">
          {chapters.map(c => (
            <button key={c.id} className="task" onClick={() => setReading(c)}>
              <span className="chno">{c.n}</span>
              <div className="grow"><div className="tt">{c.title}</div><div className="ts">{c.words.toLocaleString()} words · changed {ago(c.modifiedAt)}</div></div>
            </button>
          ))}
          {notes.length > 0 && <div className="side-h" style={{ marginTop: 8 }}>Notes Fibb can search</div>}
          {notes.map(c => <button key={c.id} className="task" onClick={() => setReading(c)}><div className="grow"><div className="tt">{c.title}</div><div className="ts">{c.words.toLocaleString()} words</div></div></button>)}
        </div>
      )}
      <div className="s folderline" title={book.folder}>{book.folder}</div>
    </section>
  );
}

export function BooksView() {
  const [books, setBooks] = useState<Book[] | null>(null);
  const [picking, setPicking] = useState(false);
  const reload = useCallback(() => { void api<{ books: Book[] }>('/api/books', undefined, { books: [] }).then(r => setBooks(r.books || [])); }, []);
  useEffect(() => { reload(); }, [reload]);
  const add = async (folder: string): Promise<string | null> => {
    const r = await api<{ book?: Book }>('/api/books', send('POST', { folder }), {});
    if (!r.book) return r.error || 'Fibb could not read that folder.';
    setPicking(false); reload(); return null;
  };
  return (
    <div className="thread"><div className="thread-inner settings">
      <h2 className="view-title">Books</h2>
      {books && books.length === 0 && !picking && (
        <section className="card empty">
          <div className="t">Show Fibb your book</div>
          <div className="s">Point Fibb at the folder where your manuscript lives. It reads your chapters so it can check them, answer questions about them, and count your words for you. No sign-in and nothing to upload.</div>
          <div className="act"><button className="btn pri" onClick={() => setPicking(true)}>Choose the folder</button></div>
        </section>
      )}
      {picking && <FolderPicker onPick={add} onCancel={() => setPicking(false)} />}
      {(books || []).map(b => <BookCard key={b.id} book={b} reload={reload} />)}
      {books && books.length > 0 && !picking && <div className="act"><button className="btn" onClick={() => setPicking(true)}>Add another book</button></div>}
      <div className="s" style={{ margin: '0 4px' }}>Fibb only reads. It never changes, moves or deletes your files. What it reads is sent to your AI model so it can help.</div>
    </div></div>
  );
}
