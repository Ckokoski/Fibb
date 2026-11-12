import { useCallback, useEffect, useState } from 'react';

interface GoogleStatus { configured: boolean; connected: boolean; email?: string }
interface BrowserStatus { available: boolean; channel?: string; running: boolean; reason?: string }

async function j<T>(url: string, init: RequestInit | undefined, fallback: T): Promise<T & { error?: string }> {
  try {
    const r = await fetch(url, init);
    const body = await r.json().catch(() => ({}));
    return r.ok ? body : { ...fallback, error: body.error || `HTTP ${r.status}` };
  } catch { return { ...fallback, error: 'Fibb is not reachable.' }; }
}
const post = (body?: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

export function ConnectorsSection() {
  const [g, setG] = useState<GoogleStatus>({ configured: false, connected: false });
  const [b, setB] = useState<BrowserStatus>({ available: false, running: false });
  const [id, setId] = useState('');
  const [secret, setSecret] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    void j<GoogleStatus>('/api/google/status', undefined, { configured: false, connected: false }).then(setG);
    void j<BrowserStatus>('/api/browser/status', undefined, { available: false, running: false }).then(setB);
  }, []);
  useEffect(() => { reload(); }, [reload]);
  // Coming back from the Google sign-in tab refreshes the status.
  useEffect(() => { const h = () => { if (!document.hidden) reload(); }; document.addEventListener('visibilitychange', h); window.addEventListener('focus', h); return () => { document.removeEventListener('visibilitychange', h); window.removeEventListener('focus', h); }; }, [reload]);

  const connect = async () => {
    setNote(''); setBusy(true);
    const r = await j<{ url?: string }>('/api/google/auth-url', undefined, {});
    setBusy(false);
    if (r.url) window.open(r.url, '_blank', 'noopener'); else setNote(r.error || 'Could not start the Google sign-in.');
  };

  return (
    <>
      <section className="card">
        <div className="keyhead"><span className={`dot${g.connected ? ' on' : ''}`} /><div className="t">Google: Drive, Docs, Gmail, Calendar</div>
          {g.connected && <span className="hint">{g.email || 'Connected'}</span>}</div>
        <div className="s">Fibb can find and read your documents, mail and calendar. Creating a doc, changing one, or drafting an email always asks you first. Fibb never sends email; it only leaves drafts.</div>
        {!g.configured && (
          <>
            <ol className="free">
              <li>Open <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Google Cloud credentials</a> and create an OAuth client of type <b>Desktop app</b>.</li>
              <li>Enable the Drive, Docs, Gmail and Calendar APIs for that project.</li>
              <li>Paste the client ID and secret here. They are encrypted in the vault and never shown again.</li>
            </ol>
            <div className="act" style={{ flexWrap: 'wrap' }}>
              <input className="input" placeholder="Client ID" value={id} onChange={e => setId(e.target.value)} aria-label="Google client ID" autoComplete="off" />
              <input className="input" type="password" placeholder="Client secret" value={secret} onChange={e => setSecret(e.target.value)} aria-label="Google client secret" autoComplete="off" />
              <button className="btn pri" disabled={busy || id.trim().length < 20 || secret.trim().length < 10} onClick={async () => {
                setBusy(true); setNote('');
                const r = await j<{ ok?: boolean }>('/api/google/client', post({ clientId: id.trim(), clientSecret: secret.trim() }), {});
                setBusy(false); setId(''); setSecret('');
                if (r.ok) reload(); else setNote(r.error || 'Could not save those.');
              }}>Save</button>
            </div>
          </>
        )}
        {g.configured && !g.connected && <div className="act"><button className="btn pri" disabled={busy} onClick={connect}>Sign in with Google</button>
          <button className="btn quiet" onClick={async () => { await j('/api/google/disconnect', post(), {}); reload(); }}>Remove client</button></div>}
        {g.connected && <div className="act"><button className="btn" onClick={async () => { await j('/api/google/disconnect', post(), {}); reload(); }}>Disconnect</button></div>}
        {note && <div className="s" role="alert" style={{ color: 'var(--red)' }}>{note}</div>}
      </section>

      <section className="card">
        <div className="keyhead"><span className={`dot${b.available ? ' on' : ''}`} /><div className="t">Fibb's browser</div>
          {b.available && <span className="hint">{b.running ? 'Open' : 'Ready'}{b.channel ? ` · ${b.channel === 'msedge' ? 'Edge' : b.channel === 'chrome' ? 'Chrome' : b.channel}` : ''}</span>}</div>
        <div className="s">A separate browser on this computer that Fibb drives for research and writer sites. It keeps its own sign-ins, apart from your everyday browser. Fibb reads pages freely, and asks before it clicks, types or submits anything.</div>
        {b.available
          ? <div className="act">
            <button className="btn" onClick={async () => { await j('/api/browser/open', post(), {}); reload(); }}>Open it to sign in to a site</button>
            {b.running && <button className="btn quiet" onClick={async () => { await j('/api/browser/close', post(), {}); reload(); }}>Close</button>}
          </div>
          : <div className="s">{b.reason || 'Not available yet. Fibb needs Microsoft Edge or Google Chrome installed.'}</div>}
      </section>
    </>
  );
}
