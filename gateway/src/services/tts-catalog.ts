// gateway/src/services/tts-catalog.ts
export type TTSProvider = 'edge' | 'kokoro' | 'gemini' | 'elevenlabs';
export interface CatalogVoice { id: string; provider: TTSProvider; label: string; gender: 'Female' | 'Male'; accent: string; note?: string }

export const KOKORO_VOICES: CatalogVoice[] = [
  { id: 'kokoro:af_heart', provider: 'kokoro', label: 'Heart', gender: 'Female', accent: 'American', note: 'warm, clear — Fibb’s default' },
  { id: 'kokoro:af_bella', provider: 'kokoro', label: 'Bella', gender: 'Female', accent: 'American' },
  { id: 'kokoro:af_nicole', provider: 'kokoro', label: 'Nicole', gender: 'Female', accent: 'American', note: 'soft, intimate' },
  { id: 'kokoro:bf_emma', provider: 'kokoro', label: 'Emma', gender: 'Female', accent: 'British' },
  { id: 'kokoro:am_michael', provider: 'kokoro', label: 'Michael', gender: 'Male', accent: 'American' },
  { id: 'kokoro:am_adam', provider: 'kokoro', label: 'Adam', gender: 'Male', accent: 'American' },
  { id: 'kokoro:bm_george', provider: 'kokoro', label: 'George', gender: 'Male', accent: 'British' },
  { id: 'kokoro:bm_fable', provider: 'kokoro', label: 'Fable', gender: 'Male', accent: 'British' },
];

export const GEMINI_VOICES: CatalogVoice[] = [
  { id: 'gemini:Kore', provider: 'gemini', label: 'Kore', gender: 'Female', accent: 'Neutral', note: 'assertive' },
  { id: 'gemini:Aoede', provider: 'gemini', label: 'Aoede', gender: 'Female', accent: 'Neutral', note: 'airy' },
  { id: 'gemini:Leda', provider: 'gemini', label: 'Leda', gender: 'Female', accent: 'Neutral', note: 'youthful' },
  { id: 'gemini:Puck', provider: 'gemini', label: 'Puck', gender: 'Male', accent: 'Neutral', note: 'energetic' },
  { id: 'gemini:Charon', provider: 'gemini', label: 'Charon', gender: 'Male', accent: 'Neutral', note: 'explanatory' },
  { id: 'gemini:Fenrir', provider: 'gemini', label: 'Fenrir', gender: 'Male', accent: 'Neutral', note: 'enthusiastic' },
];

/** Parse a namespaced voice id. Un-prefixed ids are Edge presets (legacy). */
export function parseVoiceId(id: string): { provider: TTSProvider; voice: string } {
  const m = /^(edge|kokoro|gemini|elevenlabs):(.+)$/.exec(id.trim());
  if (m) return { provider: m[1] as TTSProvider, voice: m[2] };
  if (/^[A-Za-z0-9]{18,24}$/.test(id) && !id.includes('-') && !id.includes('_')) return { provider: 'elevenlabs', voice: id };
  return { provider: 'edge', voice: id };
}

export function isKnownVoice(id: string): boolean {
  const p = parseVoiceId(id);
  if (p.provider === 'kokoro') return KOKORO_VOICES.some(v => v.id === `kokoro:${p.voice}`);
  if (p.provider === 'gemini') return GEMINI_VOICES.some(v => v.id === `gemini:${p.voice}`);
  return true; // edge presets/raw ids and elevenlabs ids are validated elsewhere
}

function parseWav(b: Buffer): { rate: number; data: Buffer; fmt: Buffer } {
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV buffer');
  let off = 12;
  let fmt: Buffer | null = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = b.subarray(off + 8, off + 8 + size);
    if (id === 'data') {
      if (!fmt) throw new Error('WAV data before fmt chunk');
      return { rate: fmt.readUInt32LE(4), fmt, data: b.subarray(off + 8, Math.min(b.length, off + 8 + size)) };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

/** Concatenate same-format PCM WAVs (e.g. Kokoro output, all 24 kHz). */
export function concatWav(buffers: Buffer[]): Buffer {
  if (!buffers.length) throw new Error('concatWav needs at least one buffer');
  const parsed = buffers.map(parseWav);
  const rate = parsed[0].rate;
  if (parsed.some(p => p.rate !== rate)) throw new Error('concatWav: sample rate mismatch');
  const data = Buffer.concat(parsed.map(p => p.data));
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16);
  parsed[0].fmt.copy(head, 20, 0, 16);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
