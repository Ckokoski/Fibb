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
