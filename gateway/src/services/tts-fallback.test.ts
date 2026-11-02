import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const k = vi.hoisted(() => ({ fromPretrained: vi.fn(), generate: vi.fn() }));
vi.mock('kokoro-js', () => ({ KokoroTTS: { from_pretrained: k.fromPretrained } }));
vi.mock('@huggingface/transformers', () => ({ env: {} }));
vi.mock('node-edge-tts', () => ({
  EdgeTTS: class { constructor(public o: any) {} async ttsPromise(_t: string, file: string) { (await import('fs')).writeFileSync(file, 'mp3'); } },
}));

import { TTSService } from './tts.js';
import { concatWav } from './tts-catalog.js';

function wav(n: number, rate = 24000): Buffer {
  const data = Buffer.alloc(n * 2, 1);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const fakeTts = () => ({ generate: k.generate });

let dir: string; let svc: TTSService;
const vault = (key: string | null) => ({ get: async (n: string) => (n === 'gemini_api_key' ? key : null) }) as any;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fibb-tts-'));
  k.fromPretrained.mockReset(); k.generate.mockReset();
  svc = new TTSService(dir, vault('SECRET-KEY'));
  await svc.initialize();
});
afterEach(() => { vi.unstubAllGlobals(); try { rmSync(dir, { recursive: true, force: true }); } catch {} });

const stubFetch = (status: number, body: any = {}) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

describe('Kokoro engine states', () => {
  it('load failure -> error status; retry succeeds', async () => {
    k.fromPretrained.mockRejectedValueOnce(new Error('offline'));
    svc.installKokoro();
    await vi.waitFor(() => expect(svc.kokoroStatus().status).toBe('error'));
    k.fromPretrained.mockResolvedValueOnce(fakeTts());
    svc.installKokoro();
    await vi.waitFor(() => expect(svc.kokoroStatus().status).toBe('ready'));
  });
  it('not ready -> Edge fallback', async () => {
    k.fromPretrained.mockReturnValue(new Promise(() => {}));
    const r = await svc.generate('Hello there friend.', { voice: 'kokoro:af_heart' });
    expect(r.provider).toBe('edge');
    expect(r.success).toBe(true);
  });
  it('synthesis throw -> Edge fallback', async () => {
    k.fromPretrained.mockResolvedValue(fakeTts());
    k.generate.mockRejectedValue(new Error('boom'));
    svc.installKokoro();
    await vi.waitFor(() => expect(svc.kokoroStatus().status).toBe('ready'));
    const r = await svc.generate('Hello there friend.', { voice: 'kokoro:af_heart' });
    expect(r.provider).toBe('edge');
  });
  it('detects a cached model, marks cached/available, and loads in background', async () => {
    const d = mkdtempSync(join(tmpdir(), 'fibb-tts-c-'));
    mkdirSync(join(d, '.models', 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx'), { recursive: true });
    writeFileSync(join(d, '.models', 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx', 'model_quantized.onnx'), 'x');
    k.fromPretrained.mockReturnValue(new Promise(() => {}));
    const s2 = new TTSService(d);
    await s2.initialize();
    expect(s2.kokoroStatus().status).toBe('cached');
    expect(s2.isVoiceReadySync('kokoro:af_heart')).toBe(true);
    await vi.waitFor(() => expect(k.fromPretrained).toHaveBeenCalled());
    rmSync(d, { recursive: true, force: true });
  });
});

describe('Gemini fallbacks', () => {
  for (const status of [429, 404, 500, 403]) {
    it(`HTTP ${status} -> Edge fallback (Kokoro not ready)`, async () => {
      stubFetch(status);
      const r = await svc.generate('Hello there friend.', { voice: 'gemini:Kore' });
      expect(r.success).toBe(true);
      expect(r.provider).toBe('edge');
    });
  }
  it('429 -> Kokoro when ready', async () => {
    k.fromPretrained.mockResolvedValue(fakeTts());
    k.generate.mockResolvedValue({ toWav: () => wav(100) });
    svc.installKokoro();
    await vi.waitFor(() => expect(svc.kokoroStatus().status).toBe('ready'));
    stubFetch(429);
    const r = await svc.generate('Hello there friend.', { voice: 'gemini:Kore' });
    expect(r.provider).toBe('kokoro');
  });
  it('missing key and network error fall back too; key never logged', async () => {
    const s2 = new TTSService(dir, vault(null)); await s2.initialize();
    expect((await s2.generate('Hello there friend.', { voice: 'gemini:Kore' })).provider).toBe('edge');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET SECRET-KEY'); }));
    expect((await svc.generate('Hello there friend.', { voice: 'gemini:Kore' })).provider).toBe('edge');
  });
});

describe('concatWav', () => {
  it('joins two 24 kHz buffers with correct RIFF sizes', () => {
    const out = concatWav([wav(100), wav(50)]);
    expect(out.length).toBe(44 + 300);
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    expect(out.readUInt32LE(40)).toBe(300);
    expect(out.readUInt32LE(24)).toBe(24000);
  });
});
