import { useCallback, useEffect, useState } from 'react';

interface McpTool { name: string; title?: string; description: string; risk: 'read' | 'write'; state: 'on' | 'off' | 'hidden' }
interface McpConnection { id: string; name: string; host: string; enabled: boolean; status: 'ok' | 'error' | 'unknown'; error?: string; tools: McpTool[]; hiddenCount?: number }

async function api<T>(url: string, init: RequestInit | undefined, fallback: T): Promise<T & { error?: string }> {
  try {
    const r = await fetch(url, init);
    const body = await r.json().catch(() => ({}));
    return r.ok ? body : { ...fallback, error: body.error || `HTTP ${r.status}` };
  } catch { return { ...fallback, error: 'Fibb is not reachable.' }; }
}
const send = (method: string, body?: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

function Connection({ c, reload }: { c: McpConnection; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const shown = c.tools.filter(t => t.state !== 'hidden');
  const hidden = c.tools.length - shown.length + (c.hiddenCount || 0);
  return (
    <div className="keyrow">
      <div className="keyhead">
        <span className={`dot${c.status === 'ok' && c.enabled ? ' on' : ''}`} aria-hidden />
        <b>{c.name}</b>
        <span className="badge">{c.enabled ? `${shown.filter(t => t.state === 'on').length} tools` : 'Paused'}</span>
        <span className="hint">{c.host}</span>
      </div>
      {c.status === 'error' && <div className="s" role="alert" style={{ color: 'var(--red)' }}>{c.error || 'Fibb could not reach this connector.'}</div>}
      <div className="act">
        <button className="btn" onClick={() => setOpen(o => !o)} aria-expanded={open}>{open ? 'Hide tools' : 'Show tools'}</button>
        <button className="btn quiet" onClick={async () => { await api(`/api/mcp/${c.id}`, send('PATCH', { enabled: !c.enabled }), {}); reload(); }}>{c.enabled ? 'Pause' : 'Turn on'}</button>
        <button className="btn quiet" onClick={async () => { await api(`/api/mcp/${c.id}/refresh`, send('POST'), {}); reload(); }}>Refresh</button>
        <button className="btn quiet" onClick={async () => { if (!window.confirm(`Remove ${c.name}?`)) return; await api(`/api/mcp/${c.id}`, { method: 'DELETE' }, {}); reload(); }}>Remove</button>
      </div>
      {open && (
        <div className="tasks">
          {shown.map(t => (
            <div key={t.name} className="task">
              <div className="grow"><div className="tt">{t.title || t.name}</div><div className="ts">{t.description}</div></div>
              <select className="input mini" value={t.state === 'off' ? 'off' : t.risk} aria-label={`How Fibb may use ${t.title || t.name}`}
                onChange={async e => { await api(`/api/mcp/${c.id}`, send('PATCH', { tools: { [t.name]: e.target.value } }), {}); reload(); }}>
                <option value="read">Use freely</option>
                <option value="write">Ask me first</option>
                <option value="off">Off</option>
              </select>
            </div>
          ))}
          {hidden > 0 && <div className="s">{hidden} more {hidden === 1 ? 'tool is' : 'tools are'} hidden, either for safety or because there were too many.</div>}
        </div>
      )}
    </div>
  );
}

/** Connect outside apps (Gmail, Docs, Drive, Calendar, Notion and more) by pasting one connector link. */
export function AppsSection() {
  const [list, setList] = useState<McpConnection[]>([]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const reload = useCallback(() => { void api<{ connections: McpConnection[] }>('/api/mcp', undefined, { connections: [] }).then(r => setList(r.connections || [])); }, []);
  useEffect(() => { reload(); }, [reload]);

  const add = async () => {
    setBusy(true); setErr('');
    const r = await api<{ connection?: McpConnection }>('/api/mcp', send('POST', { name: name.trim() || 'My apps', url: url.trim(), ...(token.trim() ? { token: token.trim() } : {}) }), {});
    setBusy(false);
    if (r.connection) { setName(''); setUrl(''); setToken(''); reload(); } else setErr(r.error || 'Could not connect. Check the link and try again.');
  };

  return (
    <section className="card">
      <div className="t">Connect your apps</div>
      <div className="s">Gmail, Google Docs, Drive, Calendar, Notion and thousands more, with one link. Fibb reads freely where a tool is marked safe, and asks you before anything that sends, creates or changes.</div>
      <ol className="free">
        <li>Open a connector service such as <a href="https://zapier.com/mcp" target="_blank" rel="noreferrer">Zapier MCP</a> and sign in to the apps you want there.</li>
        <li>Copy the server link it gives you.</li>
        <li>Paste it here. Treat the link like a password: Fibb encrypts it and never shows it again.</li>
      </ol>
      <div className="act" style={{ flexWrap: 'wrap' }}>
        <input className="input" style={{ flex: '1 1 140px' }} placeholder="Name, such as My apps" value={name} maxLength={40} onChange={e => setName(e.target.value)} aria-label="Connection name" />
        <input className="input" style={{ flex: '3 1 260px' }} type="password" autoComplete="off" placeholder="Paste the connector link (https://…)" value={url} onChange={e => setUrl(e.target.value)} aria-label="Connector link" />
      </div>
      <details className="more"><summary>My connector also gave me a key</summary>
        <input className="input" style={{ marginTop: 8 }} type="password" autoComplete="off" placeholder="Key or token (optional)" value={token} onChange={e => setToken(e.target.value)} aria-label="Connector key" />
      </details>
      <div className="act"><button className="btn pri" disabled={busy || !/^https:\/\/\S{8,}/.test(url.trim())} onClick={add}>{busy ? 'Connecting…' : 'Connect'}</button></div>
      {err && <div className="s" role="alert" style={{ color: 'var(--red)' }}>{err}</div>}
      {list.map(c => <Connection key={c.id} c={c} reload={reload} />)}
      <div className="s" style={{ marginTop: 14 }}>What you connect passes through that connector service on its way to Fibb, and what Fibb reads there is sent to your AI model.</div>
    </section>
  );
}
