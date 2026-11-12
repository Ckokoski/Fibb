import { useCallback, useEffect, useRef, useState } from 'react';
import { STARTER_TOOLS, bookmarkletHref } from '../lib/starterTools';

interface ShelfTool {
  id: string; name: string; kind: 'bookmarklet' | 'extension' | 'apps-script'; summary: string; access: string[];
  code?: string; files?: Array<{ path: string; size: number }>; warnings?: string[]; createdAt: string;
}
const KIND: Record<ShelfTool['kind'], string> = { bookmarklet: 'Bookmark button', extension: 'Chrome extension', 'apps-script': 'Google Apps Script' };

async function api<T>(url: string, init: RequestInit | undefined, fallback: T): Promise<T & { error?: string }> {
  try {
    const r = await fetch(url, init);
    const body = await r.json().catch(() => ({}));
    return r.ok ? body : { ...fallback, error: body.error || `HTTP ${r.status}` };
  } catch { return { ...fallback, error: 'Fibb is not reachable.' }; }
}

/** A link the author drags to the bookmarks bar. The address is set on the element directly, since React blocks javascript: links. */
function DragLink({ name, code }: { name: string; code: string }) {
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => { ref.current?.setAttribute('href', bookmarkletHref(code)); }, [code]);
  return <a ref={ref} className="btn pri drag" draggable onClick={e => e.preventDefault()} title="Drag this to your bookmarks bar">{name}</a>;
}

function Code({ code }: { code: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <>
      <div className="act">
        <button className="btn quiet" onClick={() => setOpen(o => !o)} aria-expanded={open}>{open ? 'Hide the code' : 'See the code'}</button>
        {open && <button className="btn quiet" onClick={async () => { try { await navigator.clipboard.writeText(code); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ } }}>{copied ? 'Copied' : 'Copy'}</button>}
      </div>
      {open && <pre className="codebox">{code}</pre>}
    </>
  );
}

function Access({ items, warnings }: { items: string[]; warnings?: string[] }) {
  return (
    <ul className="access">
      {items.map(a => <li key={a}>{a}</li>)}
      {(warnings || []).map(w => <li key={w} className="warn">{w}</li>)}
    </ul>
  );
}

export function ToolsView() {
  const [shelf, setShelf] = useState<ShelfTool[]>([]);
  const [ask, setAsk] = useState('');
  const [kind, setKind] = useState<ShelfTool['kind']>('bookmarklet');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const reload = useCallback(() => { void api<{ tools: ShelfTool[] }>('/api/shelf', undefined, { tools: [] }).then(r => setShelf(r.tools || [])); }, []);
  useEffect(() => { reload(); }, [reload]);

  const make = async () => {
    const request = ask.trim(); if (request.length < 8) return;
    setBusy(true); setErr('');
    const r = await api<{ tool?: ShelfTool }>('/api/shelf', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request, kind }) }, {});
    setBusy(false);
    if (r.tool) { setAsk(''); reload(); } else setErr(r.error || 'Fibb could not make that one. Try describing it another way.');
  };

  return (
    <div className="thread"><div className="thread-inner settings">
      <h2 className="view-title">Tools</h2>

      <section className="card">
        <div className="t">Ask Fibb to make you a tool</div>
        <div className="s">Describe a small chore. Fibb writes a tiny tool for it, shows you the code and what it can touch, and you decide whether to use it. Fibb never installs anything itself.</div>
        <textarea className="input" style={{ marginTop: 12, resize: 'vertical' }} rows={2} value={ask} maxLength={600} onChange={e => setAsk(e.target.value)}
          placeholder="Count how many times each character's name appears on the page" aria-label="Describe the tool you want" />
        <label className="modelrow"><span>Make it as</span>
          <select className="input" value={kind} onChange={e => setKind(e.target.value as ShelfTool['kind'])} aria-label="Kind of tool">
            <option value="bookmarklet">A button for my bookmarks bar</option>
            <option value="extension">A small Chrome extension</option>
            <option value="apps-script">A Google Docs script</option>
          </select>
        </label>
        <div className="act"><button className="btn pri" disabled={busy || ask.trim().length < 8} onClick={make}>{busy ? 'Writing it…' : 'Make it'}</button></div>
        {err && <div className="s" role="alert" style={{ color: 'var(--red)' }}>{err}</div>}
      </section>

      {shelf.length > 0 && <h4 className="side-h">Made for you</h4>}
      {shelf.map(t => (
        <section key={t.id} className="card tool">
          <div className="keyhead"><div className="t">{t.name}</div><span className="badge">{KIND[t.kind]}</span></div>
          <div className="s">{t.summary}</div>
          <Access items={t.access} warnings={t.warnings} />
          <div className="act">
            {t.kind === 'bookmarklet' && t.code && <><DragLink name={t.name} code={t.code} /><span className="s" style={{ margin: 0 }}>Drag the button to your bookmarks bar.</span></>}
            {t.kind === 'extension' && <a className="btn pri" href={`/api/shelf/${encodeURIComponent(t.id)}/download`}>Download the folder</a>}
          </div>
          {t.kind === 'extension' && <div className="s">Unzip it, open <code>chrome://extensions</code>, turn on Developer mode, choose Load unpacked, and pick the folder.</div>}
          {t.kind === 'apps-script' && <div className="s">In your Google Doc choose Extensions, then Apps Script. Paste the code, save, and reload the doc.</div>}
          {t.code && <Code code={t.code} />}
          <div className="act"><button className="btn quiet" onClick={async () => { await api(`/api/shelf/${encodeURIComponent(t.id)}`, { method: 'DELETE' }, {}); reload(); }}>Remove</button></div>
        </section>
      ))}

      <h4 className="side-h">Ready to use</h4>
      <div className="s" style={{ margin: '0 4px' }}>Show your bookmarks bar with Ctrl+Shift+B, then drag a button onto it. Click it on any page, with or without text selected.</div>
      <div className="toolgrid">
        {STARTER_TOOLS.map(t => (
          <section key={t.id} className="card tool">
            <div className="t">{t.name}</div>
            <div className="s">{t.blurb}</div>
            <Access items={t.access} />
            <div className="act"><DragLink name={t.name} code={t.code} /></div>
            <Code code={t.code} />
          </section>
        ))}
      </div>
    </div></div>
  );
}
