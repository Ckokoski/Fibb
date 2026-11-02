import { useState } from 'react';
import { saveGeminiKey } from '../lib/api';

export function FirstRunCard({ onDone }: { onDone: () => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <div className="card" role="region" aria-label="Connect an AI provider">
      <div className="t">Fibb needs a brain to think with</div>
      <div className="s">
        Paste a free Gemini key from <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">aistudio.google.com</a>,
        or install <a href="https://ollama.com" target="_blank" rel="noreferrer">Ollama</a> and run <code>ollama pull llama3.2</code> for fully local, free use.
      </div>
      <div className="act">
        <input className="input" type="password" placeholder="Gemini API key" value={key} onChange={e => setKey(e.target.value)} aria-label="Gemini API key" />
        <button className="btn pri" disabled={busy || key.trim().length < 20} onClick={async () => {
          setBusy(true); setErr('');
          const ok = await saveGeminiKey(key.trim());
          setBusy(false);
          if (ok) onDone(); else setErr('Could not save the key. Check the terminal for details.');
        }}>Save</button>
      </div>
      {err && <div className="s" style={{ color: 'var(--red)' }}>{err}</div>}
    </div>
  );
}
