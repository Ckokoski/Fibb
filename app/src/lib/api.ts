export type StreamEvent =
  | { type: 'chunk'; content: string }
  | { type: 'done'; content: string }
  | { type: 'error'; message: string };

export async function* streamChat(message: string, channel = 'webchat'): AsyncGenerator<StreamEvent> {
  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, channel }),
  });
  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    yield { type: 'error', message: msg };
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, sep); buf = buf.slice(sep + 2);
      const data = raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
      if (!data) continue;
      try { yield JSON.parse(data) as StreamEvent; } catch { /* skip */ }
    }
  }
}

export interface Facts {
  name?: string;
  books: Array<{ title: string; stage?: string; chapter?: number; goal?: string }>;
  people: Array<{ name: string; kind: string; book?: string; notes?: string }>;
  preferences: string[];
  recent: string[];
}

export async function getFacts(): Promise<Facts> {
  const r = await fetch('/api/facts');
  if (!r.ok) return { books: [], people: [], preferences: [], recent: [] };
  return r.json();
}

export interface WritingStats { currentStreakDays?: number; wordsTotal?: number; wordsToday?: number; wordsThisWeek?: number; [k: string]: unknown }

export async function getWritingStats(): Promise<WritingStats> {
  try { const r = await fetch('/api/writing/stats'); return r.ok ? r.json() : {}; } catch { return {}; }
}

export async function saveGeminiKey(key: string): Promise<boolean> {
  const r = await fetch('/api/vault', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'gemini_api_key', value: key }),
  });
  return r.ok;
}

export type MascotStateName = 'idle' | 'thinking' | 'listening' | 'celebrating';
export interface Companion { id: string; look?: string; name: string; voicePreset: string; tagline: string; image: string; defaultVoicePreset?: string; states?: Record<MascotStateName, string> }
export async function getCompanions(): Promise<{ companions: Companion[]; activeId: string }> {
  try {
  const r = await fetch('/api/companions'); return r.ok ? r.json() : { companions: [], activeId: 'nib' };
  } catch { return { companions: [], activeId: 'nib' }; }
}
export async function getCompanion(): Promise<Companion | null> {
  try {
  const r = await fetch('/api/companion'); return r.ok ? r.json() : null;
  } catch { return null; }
}
export async function setCompanion(body: { look?: string; voicePreset?: string | null }): Promise<Companion | null> {
  try {
  const r = await fetch('/api/companion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.ok ? r.json() : null;
  } catch { return null; }
}
export interface CatalogVoice { id: string; label: string; gender: 'Female' | 'Male'; accent?: string; note?: string }
export interface CatalogProvider { provider: string; label: string; available: boolean; status?: any; voices: CatalogVoice[] }
export interface KokoroStatus { status: string; percent?: number; error?: string }
export interface VoiceCatalog { activeVoice: string; catalog: CatalogProvider[]; kokoro: KokoroStatus }
export async function getVoiceCatalog(): Promise<VoiceCatalog> {
  try {
    const r = await fetch('/api/audio/voices');
    if (!r.ok) return { activeVoice: '', catalog: [], kokoro: { status: 'idle' } };
    const j = await r.json();
    return { activeVoice: j.activeVoice || '', catalog: j.catalog || [], kokoro: j.kokoro || { status: 'idle' } };
  } catch { return { activeVoice: '', catalog: [], kokoro: { status: 'idle' } }; }
}
export async function installKokoro(): Promise<KokoroStatus> {
  try { const r = await fetch('/api/audio/kokoro/install', { method: 'POST' }); const j = await r.json().catch(() => ({})); return r.ok ? j : { status: 'error', error: j.error || `HTTP ${r.status}` }; }
  catch { return { status: 'error', error: 'Network error' }; }
}
export async function kokoroStatus(): Promise<KokoroStatus> {
  try { const r = await fetch('/api/audio/kokoro/status'); return r.ok ? r.json() : { status: 'error', error: `HTTP ${r.status}` }; }
  catch { return { status: 'error', error: 'Network error' }; }
}
export async function setActiveVoice(voice: string): Promise<boolean> {
  try { const r = await fetch('/api/audio/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voice }) }); return r.ok; } catch { return false; }
}
export const setLook = (look: string) => setCompanion({ look });
export const setVoiceOverride = (id: string | null) => setCompanion({ voicePreset: id });
// /api/audio/generate returns the TTSResult ({success, file, filename, ...}) with no `url`;
// the file is served at /api/audio/file/:filename.
export async function speak(text: string, voice?: string): Promise<string | null> {
  try {
  const r = await fetch('/api/audio/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text.slice(0, 8000), ...(voice ? { voice } : {}) }) });
  if (!r.ok) return null;
  const j = await r.json();
  return j.url || (j.filename ? `/api/audio/file/${encodeURIComponent(j.filename)}` : null);
  } catch { return null; }
}
export async function transcribe(blob: Blob): Promise<string> {
  const fd = new FormData(); fd.append('audio', blob, 'note.webm');
  const r = await fetch('/api/audio/transcribe', { method: 'POST', body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j.text || '';
}
export async function getVaultKeys(): Promise<string[]> {
  try {
  const r = await fetch('/api/vault/keys'); if (!r.ok) return []; return (await r.json()).keys || [];
  } catch { return []; }
}
export async function saveVaultKey(key: string, value: string): Promise<{ ok: boolean; warning?: string }> {
  try {
  const r = await fetch('/api/vault', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value }) });
  const j = await r.json().catch(() => ({})); return { ok: r.ok, warning: j.warning };
  } catch { return { ok: false, warning: 'Network error' }; }
}
export async function deleteVaultKey(key: string): Promise<boolean> {
  try {
  const r = await fetch(`/api/vault/${encodeURIComponent(key)}`, { method: 'DELETE' }); return r.ok;
  } catch { return false; }
}
export async function refreshProviders(): Promise<Array<{ id: string; name: string; model: string; tier: string }>> {
  try {
  const r = await fetch('/api/providers/refresh', { method: 'POST' }); if (!r.ok) return []; return (await r.json()).providers || [];
  } catch { return []; }
}
export async function getModels(): Promise<any[]> {
  try {
  const r = await fetch('/api/models'); if (!r.ok) return []; return (await r.json()).providers || [];
  } catch { return []; }
}
export async function setModel(provider: string, model: string): Promise<boolean> {
  try {
  const r = await fetch('/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, model }) }); return r.ok;
  } catch { return false; }
}
