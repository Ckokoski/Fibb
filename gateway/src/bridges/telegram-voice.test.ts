import { describe, it, expect, vi, afterEach } from 'vitest';
import { TelegramBridge } from './telegram.js';

describe('TelegramBridge voice notes', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('replies with voice even when the handler responds after handleVoiceNote returns', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 7, file_path: 'a/b.oga' } }),
      arrayBuffer: async () => new ArrayBuffer(8),
      text: async () => '',
    })));
    const bridge = new TelegramBridge('dummy', { allowedUsers: [], pairingEnabled: false } as any);
    const seen: string[] = [];
    bridge.onMessage(((content: string, _ch: string, respond: (r: string) => Promise<void>) => {
      seen.push(content);
      setTimeout(() => { void respond('hello'); }, 0); // not awaited, returns immediately
      return Promise.resolve();
    }) as any);
    bridge.setTranscriber(async () => 'hi there');
    bridge.setCompanionVoice(() => 'narrator_warm');
    const spy = vi.fn(async () => {});
    (bridge as any).generateAndSendVoice = spy;

    await (bridge as any).handleVoiceNote(1, { file_id: 'x', mime_type: 'audio/ogg', duration: 3 }, 'Chris');
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 5));

    expect(seen[0]).toContain('[voice note] hi there');
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0] as any[])[0]).toBe(1);
    expect((spy.mock.calls[0] as any[])[2]).toBe('narrator_warm');
  });

  it('sends wav as a document and mp3 as a voice note', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = mkdtempSync(join(tmpdir(), 'fibb-tgv-'));
    try {
      writeFileSync(join(dir, 'x.wav'), Buffer.from('RIFFxxxxWAVE'));
      writeFileSync(join(dir, 'x.mp3'), Buffer.from('ID3xxxx'));
      const calls: Array<{ url: string; body: string }> = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
        calls.push({ url, body: Buffer.from(init.body).toString('latin1') });
        return { ok: true, text: async () => '' };
      }));
      const bridge = new TelegramBridge('dummy', { allowedUsers: [], pairingEnabled: false } as any);
      expect(await (bridge as any).sendVoice(1, join(dir, 'x.wav'), 'cap')).toBe(true);
      expect(await (bridge as any).sendVoice(1, join(dir, 'x.mp3'))).toBe(true);
      expect(calls[0].url.endsWith('/sendDocument')).toBe(true);
      expect(calls[0].body).toContain('audio/wav');
      expect(calls[0].body).toContain('name="document"');
      expect(calls[1].url.endsWith('/sendVoice')).toBe(true);
      expect(calls[1].body).toContain('audio/mpeg');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
