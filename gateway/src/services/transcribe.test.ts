// gateway/src/services/transcribe.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TranscribeService } from './transcribe.js';

const vault = { get: vi.fn(async (k: string) => (k === 'gemini_api_key' ? 'test-key' : null)) } as any;
afterEach(() => vi.restoreAllMocks());

describe('TranscribeService', () => {
  it('sends inline audio to Gemini and returns the text', async () => {
    const fetchMock = vi.fn(async (url: string, init: any) => {
      expect(url).toContain(':generateContent?key=test-key');
      const body = JSON.parse(init.body);
      expect(body.contents[0].parts[0].inlineData.mimeType).toBe('audio/ogg');
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: ' hello world ' }] } }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const svc = new TranscribeService(vault, { geminiModel: 'gemini-2.0-flash' });
    const out = await svc.transcribe(Buffer.from('abc'), 'audio/ogg');
    expect(out).toEqual({ text: 'hello world', provider: 'gemini' });
  });
  it('throws a clear error when no transcription provider is available', async () => {
    const noKey = { get: vi.fn(async () => null) } as any;
    const svc = new TranscribeService(noKey, { geminiModel: 'gemini-2.0-flash' });
    await expect(svc.transcribe(Buffer.from('abc'), 'audio/ogg')).rejects.toThrow(/no transcription provider/i);
  });
  it('rejects empty or oversized audio', async () => {
    const svc = new TranscribeService(vault, { geminiModel: 'gemini-2.0-flash' });
    await expect(svc.transcribe(Buffer.alloc(0), 'audio/ogg')).rejects.toThrow(/empty/i);
    await expect(svc.transcribe(Buffer.alloc(11 * 1024 * 1024), 'audio/ogg')).rejects.toThrow(/too large/i);
  });
});
