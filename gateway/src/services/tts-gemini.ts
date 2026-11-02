// gateway/src/services/tts-gemini.ts
export async function geminiSynthesize(apiKey: string, text: string, voice: string, model = 'gemini-3.8-flash-tts', fetchFn: typeof fetch = fetch): Promise<Buffer> {
  const res = await fetchFn('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      model,
      input: [{ type: 'user_input', content: [{ type: 'text', text }] }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice }] },
    }),
  });
  if (res.status === 429) throw Object.assign(new Error('Gemini TTS rate limit reached'), { code: 'RATE_LIMIT', status: 429 });
  if (res.status === 404) throw Object.assign(new Error('Gemini TTS model not found (HTTP 404)'), { code: 'NOT_FOUND', status: 404 });
  if (!res.ok) throw Object.assign(new Error(`Gemini TTS failed (HTTP ${res.status})`), { status: res.status });
  const data: any = await res.json();
  const steps: any[] = data?.steps || [];
  let b64: string | undefined;
  for (const s of steps) for (const c of (s?.content || [])) if (c?.type === 'audio' && typeof c.data === 'string') b64 = c.data;
  if (!b64 && typeof data?.output_audio?.data === 'string') b64 = data.output_audio.data;
  if (!b64) throw new Error('Gemini TTS returned no audio');
  return Buffer.from(b64, 'base64');
}
