import { useCallback, useEffect, useState } from 'react';
import {
  deleteVaultKey, getCompanion, getModels, getVaultKeys, getVoices, refreshProviders, saveVaultKey, setCompanion, setModel, speak,
  type Companion, type VoicePreset,
} from '../lib/api';
import { micSupported, playUrl } from '../lib/voice';
import { CompanionPicker } from './CompanionPicker';

const SLOTS = [
  { key: 'gemini_api_key', label: 'Google Gemini', free: true, hint: 'Free tier; powers chat, memory, and voice notes', url: 'https://aistudio.google.com/app/apikey' },
  { key: 'deepseek_api_key', label: 'DeepSeek', free: false, hint: 'Cheap, strong drafting', url: 'https://platform.deepseek.com/' },
  { key: 'openrouter_api_key', label: 'OpenRouter', free: false, hint: 'One key, many models', url: 'https://openrouter.ai/keys' },
  { key: 'openai_api_key', label: 'OpenAI', free: false, hint: 'Premium', url: 'https://platform.openai.com/api-keys' },
  { key: 'anthropic_api_key', label: 'Anthropic Claude', free: false, hint: 'Premium editing and judging', url: 'https://console.anthropic.com/' },
  { key: 'elevenlabs_api_key', label: 'ElevenLabs', free: false, hint: 'Audiobook-grade voices (Edge voices are free and built in)', url: 'https://elevenlabs.io/' },
  { key: 'telegram_bot_token', label: 'Telegram bot', free: true, hint: 'Talk to your companion from your phone', url: 'https://core.telegram.org/bots#botfather' },
];

interface ModelInfo { id: string; available: boolean; currentModel: string; tier: string; knownModels: string[] }

function KeyRow({ slot, connected, onChanged }: { slot: typeof SLOTS[number]; connected: boolean; onChanged: () => void }) {
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
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
          setBusy(true); setNote('');
          const r = await saveVaultKey(slot.key, val.trim());
          setBusy(false); setVal('');
          setNote(r.ok ? (r.warning || 'Saved') : 'Could not save');
          onChanged();
        }}>Save</button>
        {connected && <button className="btn" disabled={busy} onClick={async () => {
          if (!window.confirm(`Remove the stored ${slot.label} key?`)) return;
          setBusy(true); await deleteVaultKey(slot.key); setBusy(false); setNote('Removed'); onChanged();
        }}>Remove</button>}
      </div>
      {note && <div className="s">{note}</div>}
    </div>
  );
}

export function SettingsView({ companion, onCompanionChanged }: { companion: Companion | null; onCompanionChanged: () => void }) {
  const [keys, setKeys] = useState<string[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [online, setOnline] = useState<string[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [voices, setVoices] = useState<VoicePreset[]>([]);
  const [chosen, setChosen] = useState<string | undefined>(companion?.voicePreset);
  const [previewing, setPreviewing] = useState('');

  const reload = useCallback(() => {
    getVaultKeys().then(setKeys).catch(() => {});
    getModels().then(m => setModels(m as ModelInfo[])).catch(() => {});
  }, []);
  useEffect(() => { reload(); getVoices().then(r => setVoices(r.presets)).catch(() => {}); }, [reload]);
  useEffect(() => { setChosen(companion?.voicePreset); }, [companion?.voicePreset]);

  const name = companion?.name ?? 'Fibb';
  const ollama = models.find(m => m.id === 'ollama');
  const preview = async (id: string) => {
    setPreviewing(id);
    const u = await speak(`Hi, I'm ${name}. Let's write something today.`, id);
    if (u) await playUrl(u);
    setPreviewing('');
  };
  const pickVoice = async (id: string | null) => {
    const r = await setCompanion({ voicePreset: id });
    if (r) setChosen(r.voicePreset);
    onCompanionChanged();
  };
  const refreshCompanion = async () => { const c = await getCompanion(); if (c) setChosen(c.voicePreset); onCompanionChanged(); };

  return (
    <div className="thread"><div className="thread-inner settings">
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
            setTesting(true); const p = await refreshProviders(); setOnline(p.map(x => x.name || x.id)); setTesting(false); reload();
          }}>{testing ? 'Testing…' : 'Test connections'}</button>
          {online && <span className="s">{online.length ? `Online: ${online.join(', ')}` : 'No providers online yet'}</span>}
        </div>
        {SLOTS.map(slot => <KeyRow key={slot.key} slot={slot} connected={keys.includes(slot.key)} onChanged={reload} />)}
      </section>

      {models.length > 0 && (
        <section className="card">
          <div className="t">Models</div>
          <div className="s">Pick the model each connected provider uses.</div>
          {models.map(m => {
            const opts = Array.from(new Set([m.currentModel, ...m.knownModels]));
            return (
              <label className="modelrow" key={m.id}>
                <span>{m.id}{!m.available && <em> (no key)</em>}</span>
                <select className="input" value={m.currentModel} onChange={async e => { await setModel(m.id, e.target.value); reload(); }}>
                  {opts.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </label>
            );
          })}
        </section>
      )}

      <section className="card">
        <div className="t">Voice</div>
        <div className="s">How {name} sounds when reading aloud.</div>
        {(['Female', 'Male'] as const).map(g => {
          const group = voices.filter(v => v.gender === g);
          if (!group.length) return null;
          return (
            <fieldset className="voices" key={g}>
              <legend>{g}</legend>
              {group.map(v => (
                <div className="voicerow" key={v.id}>
                  <label>
                    <input type="radio" name="voice" checked={chosen === v.id} onChange={() => pickVoice(v.id)} />
                    <span><b>{v.id}</b> <span className="s">{v.description}</span></span>
                  </label>
                  <button className="btn" disabled={!!previewing} onClick={() => preview(v.id)}>{previewing === v.id ? 'Playing…' : 'Preview'}</button>
                </div>
              ))}
            </fieldset>
          );
        })}
        <div className="act"><button className="btn" onClick={() => pickVoice(null)}>Use companion default</button></div>
      </section>

      <section className="card">
        <div className="t">Companion</div>
        <div className="s">Pick who you write with. Their name, look, and default voice change; your book and memory stay the same.</div>
        <CompanionPicker onPicked={refreshCompanion} />
      </section>
    </div></div>
  );
}
