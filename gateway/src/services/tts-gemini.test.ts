import { describe, it, expect } from 'vitest';
import { geminiSynthesize } from './tts-gemini.js';

const ok = (body: any, status = 200) => (async (_u: any, init: any) => {
  (ok as any).last = { init };
  return new Response(JSON.stringify(body), { status });
}) as unknown as typeof fetch;

describe('geminiSynthesize', () => {
  it('sends header key, model and voice; returns decoded audio', async () => {
    const data = Buffer.from('RIFF....').toString('base64');
    const f = ok({ steps: [{ content: [{ type: 'audio', data }] }] });
    const buf = await geminiSynthesize('KEY', 'hi', 'Kore', 'm-1', f);
    expect(buf.subarray(0, 4).toString()).toBe('RIFF');
    const init = (ok as any).last.init;
    expect(init.headers['x-goog-api-key']).toBe('KEY');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('m-1');
    expect(body.generation_config.speech_config[0].voice).toBe('Kore');
  });
  it('429 -> RATE_LIMIT', async () => {
    await expect(geminiSynthesize('k', 't', 'Kore', 'm', ok({}, 429))).rejects.toMatchObject({ code: 'RATE_LIMIT' });
  });
  it('no audio throws', async () => {
    await expect(geminiSynthesize('k', 't', 'Kore', 'm', ok({ steps: [] }))).rejects.toThrow(/no audio/i);
  });
});
