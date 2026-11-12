import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getVoiceCatalog, installKokoro, kokoroStatus, setActiveVoice, setVoiceOverride, speak,
  type CatalogProvider, type KokoroStatus,
} from '../lib/api';
import { playUrl } from '../lib/voice';

const PREVIEW_TEXT = "Hi, I'm Fibb. Let's write something today.";
const BLURB: Record<string, string> = {
  edge: 'Free · online', kokoro: 'Free · runs on your PC', gemini: 'Free tier · uses your Gemini key', elevenlabs: 'Paid',
};
const NEEDS_KEY: Record<string, string> = {
  gemini: 'Add a Gemini key under Connections to use these voices.',
  elevenlabs: 'Add an ElevenLabs key under Connections to use these voices.',
};

export function VoiceSection({ voicePreset, onChanged }: { voicePreset?: string; onChanged: () => void }) {
  const [catalog, setCatalog] = useState<CatalogProvider[]>([]);
  const [activeVoice, setActive] = useState('');
  const [kokoro, setKokoro] = useState<KokoroStatus>({ status: 'idle' });
  const [open, setOpen] = useState('edge');
  const [previewing, setPreviewing] = useState('');
  const [note, setNote] = useState('');
  const [bad, setBad] = useState(false);
  const timer = useRef<number | null>(null);

  const load = useCallback(() => getVoiceCatalog().then(c => {
    setCatalog(c.catalog); setActive(c.activeVoice); setKokoro(c.kokoro);
  }), []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { if (timer.current) window.clearInterval(timer.current); }, []);

  // Poll the download every 1.5 s until it is ready or failed.
  const poll = useCallback(() => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = window.setInterval(async () => {
      let s: KokoroStatus;
      try { s = await kokoroStatus(); } catch { return; }
      setKokoro(s);
      if (s.status !== 'downloading') {
        if (timer.current) window.clearInterval(timer.current);
        timer.current = null;
        if (s.status === 'ready') void load();
      }
    }, 1500);
  }, [load]);
  useEffect(() => { if (kokoro.status === 'downloading' && !timer.current) poll(); }, [kokoro.status, poll]);

  const download = async () => {
    const s = await installKokoro();
    setKokoro(s);
    if (s.status === 'downloading') poll();
    else if (s.status === 'ready') void load();
  };

  const preview = async (id: string) => {
    setPreviewing(id); setNote(''); setBad(false);
    try {
      const u = await speak(PREVIEW_TEXT, id);
      if (u) await playUrl(u); else { setBad(true); setNote('Preview unavailable'); }
    } catch (e: any) { setBad(true); setNote(e?.message || 'Preview failed'); }
    finally { setPreviewing(''); }
  };
  const use = async (id: string) => {
    setNote(''); setBad(false);
    try {
      const [a, b] = await Promise.all([setActiveVoice(id), setVoiceOverride(id)]);
      if (a && b) { setActive(id); setNote("Fibb's voice updated"); } else { setBad(true); setNote('Could not change voice'); }
    } catch (e: any) { setBad(true); setNote(e?.message || 'Could not change voice'); }
    finally { onChanged(); }
  };
  const reset = async () => {
    setNote(''); setBad(false);
    try {
      const r = await setVoiceOverride(null);
      if (r) setNote('Back to the default voice'); else { setBad(true); setNote('Could not reset'); }
    } catch (e: any) { setBad(true); setNote(e?.message || 'Could not reset'); }
    finally { onChanged(); }
  };

  const current = catalog.find(p => p.provider === open);
  // Legacy preset ids (no provider prefix) are Edge presets.
  const ns = (id: string) => (!id ? '' : id.includes(':') ? id : `edge:${id}`);
  const current_id = ns(voicePreset || activeVoice);

  return (
    <section className="card">
      <div className="t">Voice</div>
      <div className="s">How Fibb sounds when reading aloud. Pick a provider, then a voice.</div>
      <div className="provs">
        {catalog.map(p => {
          const isKokoro = p.provider === 'kokoro';
          const ready = isKokoro ? kokoro.status === 'ready' || kokoro.status === 'cached' || p.available : p.available;
          const selectable = isKokoro || p.available;
          return (
            <div key={p.provider} className={`prov${open === p.provider ? ' on' : ''}${selectable ? '' : ' off'}`}>
              <button aria-pressed={open === p.provider} disabled={!selectable} onClick={() => setOpen(p.provider)} className="prov-main">
                <b>{p.label}</b>
                <span className="s">{BLURB[p.provider] ?? ''}</span>
              </button>
              {!selectable && NEEDS_KEY[p.provider] && <div className="hint">{NEEDS_KEY[p.provider]}</div>}
              {isKokoro && !ready && kokoro.status !== 'downloading' && <button className="btn" onClick={download}>Download</button>}
              {isKokoro && kokoro.status === 'downloading' && (
                <div className="prog" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(kokoro.percent ?? 0)}>
                  <i style={{ width: `${Math.max(4, Math.min(100, kokoro.percent ?? 0))}%` }} />
                  <span className="s">Downloading {Math.round(kokoro.percent ?? 0)}%</span>
                </div>
              )}
              {isKokoro && ready && <span className="s ok">Ready</span>}
              {isKokoro && kokoro.status === 'error' && <div className="s" role="alert" title={kokoro.error || undefined} style={{ color: 'var(--red)' }}>Download failed. Check your connection and try again.</div>}
            </div>
          );
        })}
      </div>

      {current && current.voices.length > 0 && (['Female', 'Male'] as const).map(g => {
        const group = current.voices.filter(v => v.gender === g);
        if (!group.length) return null;
        return (
          <fieldset className="voices" key={g}>
            <legend>{g}</legend>
            {group.map(v => (
              <div className={`voicerow voice${current_id === ns(v.id) ? ' on' : ''}`} key={v.id}>
                <button className="play" disabled={!!previewing} onClick={() => preview(v.id)} aria-label={`Preview ${v.label}`} title="Preview">
                  {previewing === v.id
                    ? <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden><rect x="6" y="5" width="4" height="14" rx="1.5" /><rect x="14" y="5" width="4" height="14" rx="1.5" /></svg>
                    : <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" /></svg>}
                </button>
                <span className="vmeta"><b>{v.label.replace(/\b[a-z]/g, c => c.toUpperCase())}</b><span className="s">{[v.accent, v.note].filter(Boolean).join(' · ')}</span></span>
                {current_id === ns(v.id)
                  ? <span className="badge on-badge">Fibb's voice</span>
                  : <button className="btn" onClick={() => use(v.id)}>Use</button>}
              </div>
            ))}
          </fieldset>
        );
      })}
      {current && current.voices.length === 0 && <div className="s" style={{ marginTop: 12 }}>{current.provider === 'kokoro' ? 'Download the voices to see them here.' : 'No voices available.'}</div>}
      <div className="act">
        <button className="btn quiet" onClick={reset}>Reset to default</button>
        {note && <span className="s" role="status" style={bad ? { color: 'var(--red)' } : undefined}>{note}</span>}
      </div>
    </section>
  );
}
