// gateway/src/services/transcribe.ts
/**
 * Speech-to-text (spec P2 §2). Gemini audio understanding on the free tier by
 * default; local whisper.cpp when AUTHORAGENT_WHISPER_PATH points at the
 * `whisper-cli` binary (model path in AUTHORAGENT_WHISPER_MODEL).
 */
import { writeFile, readFile, rm, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Vault } from '../security/vault.js';
import { logger } from './logger.js';

const execFileP = promisify(execFile);
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export interface TranscribeResult { text: string; provider: 'gemini' | 'whisper' }

export class TranscribeService {
  constructor(
    private vault: Pick<Vault, 'get'>,
    private opts: { geminiModel: string | (() => string); geminiEndpoint?: string; whisperPath?: string; whisperModel?: string } = { geminiModel: 'gemini-2.0-flash' },
  ) {}

  async transcribe(audio: Buffer, mimeType: string): Promise<TranscribeResult> {
    if (!audio || audio.length === 0) throw new Error('Audio is empty');
    if (audio.length > MAX_AUDIO_BYTES) throw new Error(`Audio too large (max ${MAX_AUDIO_BYTES / 1024 / 1024} MB)`);
    const whisperPath = this.opts.whisperPath ?? process.env.AUTHORAGENT_WHISPER_PATH;
    if (whisperPath) {
      try { return await this.viaWhisper(audio, mimeType, whisperPath); }
      catch (err) { logger.warn('whisper transcription failed, trying Gemini', err); }
    }
    const key = await this.vault.get('gemini_api_key');
    if (key) return this.viaGemini(audio, mimeType, key);
    throw new Error('No transcription provider available. Add a free Gemini key or set AUTHORAGENT_WHISPER_PATH.');
  }

  private async viaGemini(audio: Buffer, mimeType: string, key: string): Promise<TranscribeResult> {
    const endpoint = this.opts.geminiEndpoint ?? 'https://generativelanguage.googleapis.com/v1beta';
    const res = await fetch(`${endpoint}/models/${typeof this.opts.geminiModel === 'function' ? this.opts.geminiModel() : this.opts.geminiModel}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [
          { inlineData: { mimeType, data: audio.toString('base64') } },
          { text: 'Transcribe this audio verbatim. Return only the spoken words, no commentary, no timestamps.' },
        ] }],
        generationConfig: { temperature: 0 },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn(`Gemini transcription failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
      throw new Error(`Gemini transcription failed (HTTP ${res.status})`);
    }
    const data: any = await res.json();
    const text = (data?.candidates?.[0]?.content?.parts || []).map((p: any) => p?.text || '').join('').trim();
    if (!text) throw new Error('Gemini returned no transcript');
    return { text, provider: 'gemini' };
  }

  private async viaWhisper(audio: Buffer, mimeType: string, whisperPath: string): Promise<TranscribeResult> {
    const dir = await mkdtemp(join(tmpdir(), 'fibb-stt-'));
    const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('webm') ? 'webm' : mimeType.includes('wav') ? 'wav' : 'mp3';
    const inFile = join(dir, `in.${ext}`);
    const outBase = join(dir, 'out');
    try {
      await writeFile(inFile, audio);
      const args = ['-f', inFile, '-otxt', '-of', outBase, '-nt'];
      const model = this.opts.whisperModel ?? process.env.AUTHORAGENT_WHISPER_MODEL;
      if (model) args.unshift('-m', model);
      await execFileP(whisperPath, args, { timeout: 120_000 });
      const text = (await readFile(`${outBase}.txt`, 'utf-8')).trim();
      if (!text) throw new Error('whisper returned no transcript');
      return { text, provider: 'whisper' };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
