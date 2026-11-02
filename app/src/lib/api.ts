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

export interface Companion { id: string; name: string; voicePreset: string; tagline: string; image: string; defaultVoicePreset?: string }
export async function getCompanions(): Promise<{ companions: Companion[]; activeId: string }> {
  const r = await fetch('/api/companions'); return r.ok ? r.json() : { companions: [], activeId: 'nib' };
}
export async function getCompanion(): Promise<Companion | null> {
  const r = await fetch('/api/companion'); return r.ok ? r.json() : null;
}
export async function setCompanion(body: { id?: string; voicePreset?: string | null }): Promise<Companion | null> {
  const r = await fetch('/api/companion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.ok ? r.json() : null;
}
export interface VoicePreset { id: string; voice: string; description: string; gender: 'Male' | 'Female' }
export async function getVoices(): Promise<{ presets: VoicePreset[] }> {
  const r = await fetch('/api/audio/voices'); return r.ok ? r.json() : { presets: [] };
}
// /api/audio/generate returns the TTSResult ({success, file, filename, ...}) with no `url`;
// the file is served at /api/audio/file/:filename.
export async function speak(text: string, voice?: string): Promise<string | null> {
  const r = await fetch('/api/audio/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text.slice(0, 8000), ...(voice ? { voice } : {}) }) });
  if (!r.ok) return null;
  const j = await r.json();
  return j.url || (j.filename ? `/api/audio/file/${encodeURIComponent(j.filename)}` : null);
}
export async function transcribe(blob: Blob): Promise<string> {
  const fd = new FormData(); fd.append('audio', blob, 'note.webm');
  const r = await fetch('/api/audio/transcribe', { method: 'POST', body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j.text || '';
}
export async function getVaultKeys(): Promise<string[]> {
  const r = await fetch('/api/vault/keys'); if (!r.ok) return []; return (await r.json()).keys || [];
}
export async function saveVaultKey(key: string, value: string): Promise<{ ok: boolean; warning?: string }> {
  const r = await fetch('/api/vault', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value }) });
  const j = await r.json().catch(() => ({})); return { ok: r.ok, warning: j.warning };
}
export async function deleteVaultKey(key: string): Promise<boolean> {
  const r = await fetch(`/api/vault/${encodeURIComponent(key)}`, { method: 'DELETE' }); return r.ok;
}
export async function refreshProviders(): Promise<Array<{ id: string; name: string; model: string; tier: string }>> {
  const r = await fetch('/api/providers/refresh', { method: 'POST' }); if (!r.ok) return []; return (await r.json()).providers || [];
}
export async function getModels(): Promise<any[]> {
  const r = await fetch('/api/models'); if (!r.ok) return []; return (await r.json()).providers || [];
}
export async function setModel(provider: string, model: string): Promise<boolean> {
  const r = await fetch('/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, model }) }); return r.ok;
}
