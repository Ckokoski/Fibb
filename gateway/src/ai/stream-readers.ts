/**
 * Pure body readers for streaming provider responses.
 * readNdjson: one JSON object per line (Ollama).
 * readSse: Server-Sent Events, `data:` lines hold JSON (Gemini alt=sse, OpenAI-compatible, Anthropic).
 * Both tolerate chunk boundaries anywhere and never throw on a bad line.
 */

export async function readNdjson(
  body: ReadableStream<Uint8Array>,
  onObject: (obj: any) => void,
): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { onObject(JSON.parse(line)); } catch { /* skip malformed line */ }
    }
  }
  const tail = buf.trim();
  if (tail) { try { onObject(JSON.parse(tail)); } catch { /* ignore */ } }
}

export async function readSse(
  body: ReadableStream<Uint8Array>,
  onData: (obj: any) => void,
): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const handleEvent = (raw: string): boolean => {
    // Returns false when the stream should stop ([DONE]).
    const dataLines = raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
    if (dataLines.length === 0) return true;
    const data = dataLines.join('\n');
    if (data === '[DONE]') return false;
    try { onData(JSON.parse(data)); } catch { /* skip malformed event */ }
    return true;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      if (!handleEvent(raw)) { try { await reader.cancel(); } catch { /* ignore */ } return; }
    }
  }
  if (buf.trim()) handleEvent(buf);
}
