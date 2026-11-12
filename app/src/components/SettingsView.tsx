import { useCallback, useEffect, useState } from 'react';
import { ConnectorsSection } from './ConnectorsSection';
import { cue, setSounds, soundsOn } from '../lib/sound';
import {
  deleteVaultKey, getModels, getVaultKeys, refreshProviders, saveVaultKey, setModel,
  type Companion,
} from '../lib/api';
import { micSupported } from '../lib/voice';
import { LookPicker } from './LookPicker';
import { VoiceSection } from './VoiceSection';

const SLOTS = [
  { key: 'gemini_api_key', label: 'Google Gemini', free: true, hint: 'Free tier; powers chat, memory, and voice notes', url: 'https://aistudio.google.com/app/apikey' },
  { key: 'deepseek_api_key', label: 'DeepSeek', free: false, hint: 'Cheap, strong drafting', url: 'https://platform.deepseek.com/' },
  { key: 'openrouter_api_key', label: 'OpenRouter', free: false, hint: 'One key, many models', url: 'https://openrouter.ai/keys' },
  { key: 'openai_api_key', label: 'OpenAI', free: false, hint: 'Premium', url: 'https://platform.openai.com/api-keys' },
  { key: 'anthropic_api_key', label: 'Anthropic Claude', free: false, hint: 'Premium editing and judging', url: 'https://console.anthropic.com/' },
  { key: 'elevenlabs_api_key', label: 'ElevenLabs', free: false, hint: 'Audiobook-grade voices (Edge voices are free and built in)', url: 'https://elevenlabs.io/' },
  { key: 'telegram_bot_token', label: 'Telegram bot', free: true, hint: 'Talk to Fibb from your phone', url: 'https://core.telegram.org/bots#botfather' },
];

interface ModelInfo { id: string; available: boolean; currentModel: string; tier: string; knownModels: string[] }

function KeyRow({ slot, connected, onChanged }: { slot: typeof SLOTS[number]; connected: boolean; onChanged: () => void }) {
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [bad, setBad] = useState(false);
  return (
    <div className="keyrow">
      <div className="keyhead">
        <span className={`dot${connected ? ' on' : ''}`} aria-hidden />
        <b>{slot.label}</b>
        <span className="badge">{slot.free ? 'Free' : 'Paid'}</span>
        <span className="sr-only">{connected ? 'Connected' : 'Not connected'}</span>
        <a className="hint" href={slot.url} target="_blank" rel="noreferrer">{slot.hint}</a>
      </div>
      <div className="act">
        <input className="input" type="password" autoComplete="off" value={val} onChange={e => setVal(e.target.value)}
          placeholder={connected ? '•••••••• (stored)' : 'Paste key'} aria-label={`${slot.label} key`} />
        <button className="btn pri" disabled={busy || val.trim().length < 8} onClick={async () => {
          setBusy(true); setNote(''); setBad(false);
          try {
            const r = await saveVaultKey(slot.key, val.trim());
            if (r.ok) { setVal(''); setNote(r.warning || 'Saved'); onChanged(); }
            else { setBad(true); setNote(r.warning || 'Could not save. Your key is still in the box.'); }
          } catch (e: any) { setBad(true); setNote(e?.message || 'Could not save'); }
          finally { setBusy(false); }
        }}>Save</button>
        {connected && <button className="btn" disabled={busy} onClick={async () => {
          if (!window.confirm(`Remove the stored ${slot.label} key?`)) return;
          setBusy(true); setBad(false);
          try { const ok = await deleteVaultKey(slot.key); if (ok) { setNote('Removed'); onChanged(); } else { setBad(true); setNote('Could not remove'); } }
          catch (e: any) { setBad(true); setNote(e?.message || 'Could not remove'); }
          finally { setBusy(false); }
        }}>Remove</button>}
      </div>
      {note && <div className="s" role="status" style={bad ? { color: 'var(--red)' } : undefined}>{note}</div>}
    </div>
  );
}

export function SettingsView({ companion, onCompanionChanged }: { companion: Companion | null; onCompanionChanged: () => void }) {
  const [keys, setKeys] = useState<string[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [online, setOnline] = useState<string[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'connect' | 'voice' | 'look' | 'more'>('connect');
  const [sounds, setSoundsState] = useState(soundsOn);

  const reload = useCallback(() => {
    getVaultKeys().then(setKeys).catch(() => {});
    getModels().then(m => setModels(m as ModelInfo[])).catch(() => {});
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const ollama = models.find(m => m.id === 'ollama');

  return (
    <div className="thread"><div className="thread-inner settings">
      <h2 className="view-title">Settings</h2>
      <div className="seg" role="tablist" aria-label="Settings sections">
        {([['connect', 'Connections'], ['voice', 'Voice'], ['look', 'Look and feel'], ['more', 'Advanced']] as const).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {error && <div className="card" role="alert" style={{ color: 'var(--red)' }}>{error}</div>}
      <div className="tabpane" hidden={tab !== 'connect'}>
      <section className="card">
        <div className="t">Free, no key needed</div>
        <ul className="free">
          <li>Ollama (local models): {ollama ? (ollama.available ? 'running' : 'not detected') : 'detected at start'}</li>
          <li>Edge voices: always on, built in</li>
          <li>Web Speech (microphone in your browser): {micSupported() ? 'available' : 'not supported here'}</li>
        </ul>
      </section>

      <section className="card">
        <div className="t">Connections</div>
        <div className="s">Keys are encrypted in the vault. This page only shows whether a key is stored, never its value.</div>
        <div className="act">
          <button className="btn" disabled={testing} onClick={async () => {
            setTesting(true); setError('');
            try { const p = await refreshProviders(); setOnline(p.map(x => x.name || x.id)); reload(); }
            catch (e: any) { setError(e?.message || 'Test failed'); }
            finally { setTesting(false); }
          }}>{testing ? 'Testing…' : 'Test connections'}</button>
          {online && <span className="s">{online.length ? `Online: ${online.join(', ')}` : 'No providers online yet'}</span>}
        </div>
        {SLOTS.map(slot => <KeyRow key={slot.key} slot={slot} connected={keys.includes(slot.key)} onChanged={reload} />)}
      </section>

      <ConnectorsSection />

      {models.length > 0 && (
        <section className="card">
          <div className="t">Models</div>
          <div className="s">Pick the model each connected provider uses.</div>
          {models.map(m => {
            const opts = Array.from(new Set([m.currentModel, ...m.knownModels]));
            return (
              <label className="modelrow" key={m.id}>
                <span>{m.id}{!m.available && <em> (no key)</em>}</span>
                <select className="input" value={m.currentModel} onChange={async e => { setError(''); try { if (!(await setModel(m.id, e.target.value))) setError('Could not change model'); } catch (er: any) { setError(er?.message || 'Could not change model'); } reload(); }}>
                  {opts.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </label>
            );
          })}
        </section>
      )}

      </div>
      <div className="tabpane" hidden={tab !== 'voice'}>
      <VoiceSection voicePreset={companion?.voicePreset} onChanged={onCompanionChanged} />

      </div>
      <div className="tabpane" hidden={tab !== 'look'}>
      <section className="card">
        <div className="t">Appearance</div>
        <div className="s">Fibb is always Fibb. Pick the look you like.</div>
        <LookPicker onPicked={onCompanionChanged} />
      </section>

      <section className="card">
        <div className="t">Sounds</div>
        <label className="voicerow"><span className="s" style={{ margin: 0 }}>A soft chime when Fibb finishes a reply or celebrates with you.</span>
          <input type="checkbox" checked={sounds} aria-label="Play soft sounds" onChange={e => { setSounds(e.target.checked); setSoundsState(e.target.checked); if (e.target.checked) cue('done', true); }} />
        </label>
      </section>

      </div>
      <div className="tabpane" hidden={tab !== 'more'}>
      <section className="card">
        <div className="t">Advanced</div>
        <div className="s"><a href="/legacy/">Previous dashboard</a></div>
        <div className="s">Voice notes without a browser microphone use a local Whisper binary: set <code>AUTHORAGENT_WHISPER_PATH</code> in the environment before starting Fibb.</div>
      </section>
      </div>
    </div></div>
  );
}
