import { describe, it, expect } from 'vitest';
import { parseVoiceId, isKnownVoice, concatWav, KOKORO_VOICES } from './tts-catalog.js';

function wav(samples: number[], rate = 24000): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

describe('tts-catalog', () => {
  it('parses namespaced and legacy ids', () => {
    expect(parseVoiceId('kokoro:af_heart')).toEqual({ provider: 'kokoro', voice: 'af_heart' });
    expect(parseVoiceId('narrator_warm')).toEqual({ provider: 'edge', voice: 'narrator_warm' });
    expect(parseVoiceId('gemini:Kore')).toEqual({ provider: 'gemini', voice: 'Kore' });
    expect(parseVoiceId('21m00Tcm4TlvDq8ikWAM')).toEqual({ provider: 'elevenlabs', voice: '21m00Tcm4TlvDq8ikWAM' });
  });
  it('validates known voices', () => {
    expect(isKnownVoice('kokoro:af_heart')).toBe(true);
    expect(isKnownVoice('kokoro:zz')).toBe(false);
    expect(isKnownVoice('gemini:Nope')).toBe(false);
    expect(isKnownVoice('narrator_warm')).toBe(true);
    expect(KOKORO_VOICES[0].id).toBe('kokoro:af_heart');
  });
  it('concatenates wavs and fixes sizes', () => {
    const out = concatWav([wav([1, 2, 3]), wav([4, 5])]);
    expect(out.length).toBe(44 + 10);
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    expect(out.readUInt32LE(40)).toBe(10);
    expect(out.readInt16LE(44 + 6)).toBe(4);
    expect(concatWav([wav([1])]).length).toBe(46);
  });
  it('throws on differing sample rates or empty input', () => {
    expect(() => concatWav([wav([1], 24000), wav([1], 16000)])).toThrow(/sample rate/i);
    expect(() => concatWav([])).toThrow();
  });
});
