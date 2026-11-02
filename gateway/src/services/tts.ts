/**
 * Fibb TTS Service
 *
 * Multi-provider text-to-speech. Inspired by OpenClaw 2026.4.25's pluggable
 * TTS architecture but tightly scoped to author workflows.
 *
 * Providers:
 *   edge        — Microsoft Edge TTS (free, no key, ~300 voices, default)
 *   elevenlabs  — ElevenLabs v3 (paid, audiobook-grade narration; uses
 *                 the ElevenLabs API key from the vault)
 *
 * Voice resolution priority (highest first):
 *   1. Explicit voice/preset passed to generate()
 *   2. Persona's ttsVoice (when generating for a project with a persona)
 *   3. Globally configured voice (settings)
 *   4. Default voice
 */

import { mkdir, readdir, stat, readFile, unlink, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { logger } from './logger.js';
import type { Vault } from '../security/vault.js';
import { KokoroEngine, type KokoroStatus } from './tts-kokoro.js';
import { geminiSynthesize } from './tts-gemini.js';
import { parseVoiceId, concatWav, KOKORO_VOICES, GEMINI_VOICES, type CatalogVoice } from './tts-catalog.js';

export type TTSProviderId = 'edge' | 'kokoro' | 'gemini' | 'elevenlabs';

const LOCAL_TEXT_CAP = 20000;
const GEMINI_MODELS = ['gemini-3.8-flash-tts', 'gemini-2.5-flash-tts'];

/** Split text into sentence-ish chunks of at most `max` chars. */
export function chunkSentences(text: string, max = 400): string[] {
  const sentences = text.replace(/\s+/g, ' ').trim().match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) || [];
  const out: string[] = [];
  let cur = '';
  const push = (t: string) => { if (t.trim()) out.push(t.trim()); };
  for (const sRaw of sentences) {
    let sent = sRaw;
    while (sent.length > max) {
      let cut = sent.lastIndexOf(' ', max);
      if (cut < max / 2) cut = max;
      if (cur) { push(cur); cur = ''; }
      push(sent.slice(0, cut));
      sent = sent.slice(cut);
    }
    if ((cur + sent).length > max) { push(cur); cur = sent; } else cur += sent;
  }
  push(cur);
  return out;
}

export interface TTSResult {
  success: boolean;
  file?: string;
  filename?: string;
  format?: string;
  size?: number;
  duration?: number; // estimated seconds
  provider?: TTSProviderId;
  error?: string;
}

export interface TTSVoice {
  id: string;        // e.g. 'en-US-AriaNeural'
  name: string;      // e.g. 'Aria'
  language: string;   // e.g. 'en-US'
  gender: string;     // 'Female' or 'Male'
  description: string; // Author-friendly description
}

export interface VoicePreset {
  id: string;
  voice: string;
  description: string;
  gender: string;
}

export class TTSService {
  private audioDir: string;
  private configDir: string;
  private defaultVoice = 'en-US-AriaNeural';
  private defaultPreset = 'narrator_female';
  private configuredVoice: string | null = null;
  private configuredProvider: TTSProviderId = 'edge';
  private vault: Vault | null = null;
  private kokoro: KokoroEngine;
  private keyPresent = { gemini: false, elevenlabs: false };
  private geminiModel: string | null = null;
  // Cache of ElevenLabs voices to avoid re-fetching on every call.
  private elevenLabsVoicesCache: Array<{ voice_id: string; name: string; labels?: any }> | null = null;
  private elevenLabsVoicesFetchedAt = 0;

  // Author-focused voice presets (from AuthorScribe Audio)
  static readonly VOICE_PRESETS: Record<string, VoicePreset> = {
    narrator_female: {
      id: 'narrator_female',
      voice: 'en-US-AriaNeural',
      description: 'Versatile female — clear, expressive, works for most genres',
      gender: 'Female',
    },
    narrator_male: {
      id: 'narrator_male',
      voice: 'en-US-GuyNeural',
      description: 'Warm male — great for literary fiction, thriller narration',
      gender: 'Male',
    },
    narrator_deep: {
      id: 'narrator_deep',
      voice: 'en-US-ChristopherNeural',
      description: 'Deep, authoritative male — epic fantasy, sci-fi, nonfiction',
      gender: 'Male',
    },
    narrator_warm: {
      id: 'narrator_warm',
      voice: 'en-US-JennyNeural',
      description: 'Warm, approachable female — romance, memoir',
      gender: 'Female',
    },
    british_male: {
      id: 'british_male',
      voice: 'en-GB-RyanNeural',
      description: 'British male — literary fiction, period pieces, cozy mysteries',
      gender: 'Male',
    },
    british_female: {
      id: 'british_female',
      voice: 'en-GB-SoniaNeural',
      description: 'British female — elegant, clear, literary',
      gender: 'Female',
    },
    storyteller: {
      id: 'storyteller',
      voice: 'en-US-AndrewNeural',
      description: 'Engaging male storyteller — adventure, YA, middle grade',
      gender: 'Male',
    },
    snarky_nerd: {
      id: 'snarky_nerd',
      voice: 'en-US-SteffanNeural',
      description: 'Snarky, nerdy male — witty banter, smart humor, sci-fi',
      gender: 'Male',
    },
    curious_kid: {
      id: 'curious_kid',
      voice: 'en-US-AnaNeural',
      description: 'Curious child — full of wonder, MG, picture books, whimsical',
      gender: 'Female',
    },
  };

  constructor(workspaceDir: string, vault?: Vault) {
    this.audioDir = join(workspaceDir, 'audio');
    this.configDir = join(workspaceDir, '.config');
    this.vault = vault || null;
    this.kokoro = new KokoroEngine(join(workspaceDir, '.models'));
  }

  kokoroStatus(): KokoroStatus { return this.kokoro.getStatus(); }

  /** Start (or join) the Kokoro model download/load; never throws. */
  installKokoro(): KokoroStatus {
    this.kokoro.load().catch(() => { /* status carries the error */ });
    return this.kokoro.getStatus();
  }

  /** Refresh cached vault-key presence (call after vault writes). */
  async refreshKeyCache(): Promise<void> {
    if (!this.vault) return;
    try {
      this.keyPresent.gemini = !!(await this.vault.get('gemini_api_key'));
      this.keyPresent.elevenlabs = !!(await this.vault.get('elevenlabs_api_key'));
    } catch { /* keep previous */ }
  }

  /** Synchronous readiness check for a (possibly namespaced) voice id. */
  isVoiceReadySync(id: string): boolean {
    const p = parseVoiceId(id);
    if (p.provider === 'edge') return true;
    if (p.provider === 'kokoro') return this.kokoro.getStatus().status === 'ready';
    return this.keyPresent[p.provider];
  }

  async listCatalog(): Promise<Array<{ provider: TTSProviderId; label: string; available: boolean; status?: KokoroStatus; voices: CatalogVoice[] }>> {
    await this.refreshKeyCache();
    const edgeVoices: CatalogVoice[] = Object.values(TTSService.VOICE_PRESETS).map(v => ({
      id: `edge:${v.id}`, provider: 'edge', label: v.id.replace(/_/g, ' '), gender: v.gender as 'Female' | 'Male',
      accent: v.voice.startsWith('en-GB') ? 'British' : 'American', note: v.description,
    }));
    return [
      { provider: 'edge', label: 'Edge (free)', available: true, voices: edgeVoices },
      { provider: 'kokoro', label: 'Kokoro (local, free)', available: this.kokoro.getStatus().status === 'ready', status: this.kokoro.getStatus(), voices: KOKORO_VOICES },
      { provider: 'gemini', label: 'Gemini', available: this.keyPresent.gemini, voices: GEMINI_VOICES },
      { provider: 'elevenlabs', label: 'ElevenLabs (paid)', available: this.keyPresent.elevenlabs, voices: [] },
    ];
  }

  /** Wire vault after construction (so we can resolve ElevenLabs API key on demand). */
  setVault(vault: Vault): void {
    this.vault = vault;
  }

  async initialize(): Promise<void> {
    await mkdir(this.audioDir, { recursive: true });
    await mkdir(this.configDir, { recursive: true });
    await this.loadVoiceConfig();
    await this.refreshKeyCache();
  }

  // ── Voice Config Persistence ──

  private async loadVoiceConfig(): Promise<void> {
    const configPath = join(this.configDir, 'tts.json');
    try {
      const raw = await readFile(configPath, 'utf-8');
      const config = JSON.parse(raw);
      if (config.voice && typeof config.voice === 'string') {
        this.configuredVoice = config.voice;
      }
      if (['edge', 'kokoro', 'gemini', 'elevenlabs'].includes(config.provider)) {
        this.configuredProvider = config.provider;
      }
    } catch { /* no config yet — use default */ }
  }

  async setVoice(voice: string): Promise<void> {
    this.configuredVoice = voice;
    await this.persistConfig();
  }

  async setProvider(provider: TTSProviderId): Promise<void> {
    this.configuredProvider = provider;
    await this.persistConfig();
  }

  private async persistConfig(): Promise<void> {
    const configPath = join(this.configDir, 'tts.json');
    await writeFile(configPath, JSON.stringify({
      voice: this.configuredVoice,
      provider: this.configuredProvider,
    }, null, 2));
  }

  getActiveVoice(): string {
    return this.configuredVoice || this.defaultVoice;
  }

  getActiveProvider(): TTSProviderId {
    return this.configuredProvider;
  }

  /** Edge TTS is always available (only needs internet); ElevenLabs needs an API key. */
  isAvailable(provider: TTSProviderId = 'edge'): boolean {
    if (provider === 'edge') return true;
    if (provider === 'kokoro') return this.kokoro.getStatus().status === 'ready';
    if (provider === 'gemini' || provider === 'elevenlabs') return !!this.vault; // can probe further at call time
    return false;
  }

  // ── Voice Resolution ──

  /**
   * Resolve a voice input to a provider-appropriate voice ID.
   * Accepts: preset name ('narrator_deep'), voice ID, or null (use default).
   * For ElevenLabs voices the input should be a voice_id; for Edge voices it
   * should be the Microsoft voice name.
   */
  resolveVoice(input?: string): string {
    if (!input) input = this.getActiveVoice();
    if (/^(edge|kokoro|gemini|elevenlabs):/.test(input)) {
      const parsed = parseVoiceId(input);
      if (parsed.provider === 'edge') return TTSService.VOICE_PRESETS[parsed.voice.toLowerCase()]?.voice ?? parsed.voice;
      return input; // kokoro:/gemini:/elevenlabs: stay namespaced
    }
    // Check if it's a preset name (Edge presets)
    const preset = TTSService.VOICE_PRESETS[input.toLowerCase()];
    if (preset) return preset.voice;
    // Otherwise treat as a raw voice ID (works for both Edge and ElevenLabs)
    return input;
  }

  /**
   * Detect which provider a given voice ID belongs to.
   * - Edge voices look like 'en-US-AriaNeural' (lang-region-name pattern)
   * - ElevenLabs voice_ids are 20-char alphanumeric strings
   * Falls back to the configured provider if pattern is ambiguous.
   */
  detectProviderForVoice(voice: string): TTSProviderId {
    if (/^(kokoro|gemini):/.test(voice)) return parseVoiceId(voice).provider;
    if (/^[a-z]{2}-[A-Z]{2}-\w+Neural$/.test(voice)) return 'edge';
    if (/^[A-Za-z0-9]{18,24}$/.test(voice) && !voice.includes('-')) return 'elevenlabs';
    return this.configuredProvider;
  }

  // ── Audio Generation ──

  /**
   * Generate audio from text. Dispatches to the right provider based on
   * options.provider, options.voice fingerprint, or the configured default.
   *
   * Voice priority: explicit voice > persona's voice (caller injects it via
   * the `voice` option) > configured global > default preset.
   */
  async generate(text: string, options: {
    voice?: string;
    provider?: TTSProviderId;     // Force a specific provider
    rate?: string;                // Edge: '+10%' / '-20%' / '+0%' | ElevenLabs: applied as stability
    pitch?: string;               // Edge only
    volume?: string;              // Edge only
    elevenLabsModel?: string;     // ElevenLabs only — defaults to eleven_v3
  } = {}): Promise<TTSResult> {
    const voice = this.resolveVoice(options.voice);
    // Provider precedence: explicit override > voice-id-based detection > configured default
    const provider = options.provider || this.detectProviderForVoice(voice) || this.configuredProvider;

    if (provider === 'kokoro') {
      return this.generateKokoro(text, voice.startsWith('kokoro:') ? voice.slice(7) : 'af_heart', options);
    }
    if (provider === 'gemini') {
      return this.generateGemini(text, voice.startsWith('gemini:') ? voice.slice(7) : 'Kore', options);
    }
    if (provider === 'elevenlabs') {
      return this.generateElevenLabs(text, voice.replace(/^elevenlabs:/, ''), options);
    }
    return this.generateEdge(text, /^[a-z]{2}-[A-Z]{2}-/.test(voice) ? voice : this.resolveVoice('narrator_warm'), options);
  }

  private async writeWav(buf: Buffer, text: string, provider: TTSProviderId): Promise<TTSResult> {
    const filename = `tts-${randomBytes(6).toString('hex')}.wav`;
    const file = join(this.audioDir, filename);
    await writeFile(file, buf);
    const words = text.split(/\s+/).length;
    return { success: true, file, filename, format: 'wav', size: buf.length, duration: Math.round((words / 150) * 60), provider };
  }

  private edgeFallback(text: string, options: { rate?: string; pitch?: string; volume?: string }): Promise<TTSResult> {
    return this.generateEdge(text, this.resolveVoice('narrator_warm'), options);
  }

  private async generateKokoro(text: string, voice: string, options: { rate?: string; pitch?: string; volume?: string }): Promise<TTSResult> {
    if (this.kokoro.getStatus().status !== 'ready') {
      this.installKokoro(); // warm it up for next time
      return this.edgeFallback(text, options);
    }
    try {
      const chunks = chunkSentences(text.substring(0, LOCAL_TEXT_CAP));
      if (!chunks.length) return { success: false, error: 'No speakable text', provider: 'kokoro' };
      const parts: Buffer[] = [];
      for (const c of chunks) parts.push(await this.kokoro.synthesize(c, voice));
      return await this.writeWav(concatWav(parts), text, 'kokoro');
    } catch {
      return this.edgeFallback(text, options);
    }
  }

  private async generateGemini(text: string, voice: string, options: { rate?: string; pitch?: string; volume?: string }): Promise<TTSResult> {
    const apiKey = this.vault ? await this.vault.get('gemini_api_key') : null;
    if (!apiKey) {
      return { success: false, error: 'Gemini API key not found in vault. Add `gemini_api_key` in Settings → API Keys.', provider: 'gemini' };
    }
    const models = this.geminiModel ? [this.geminiModel] : GEMINI_MODELS;
    try {
      let lastErr: any;
      for (const model of models) {
        try {
          const buf = await geminiSynthesize(apiKey, text.substring(0, LOCAL_TEXT_CAP), voice, model);
          if (this.geminiModel !== model) logger.info(`Gemini TTS using model ${model}`);
          this.geminiModel = model;
          if (buf.subarray(0, 4).toString('ascii') !== 'RIFF') return { success: false, error: 'Gemini TTS returned non-WAV audio', provider: 'gemini' };
          return await this.writeWav(buf, text, 'gemini');
        } catch (e: any) {
          lastErr = e;
          if (e?.code !== 'NOT_FOUND') throw e;
        }
      }
      throw lastErr;
    } catch (e: any) {
      if (e?.code === 'RATE_LIMIT' || e?.code === 'NOT_FOUND') {
        if (this.kokoro.getStatus().status === 'ready') return this.generateKokoro(text, 'af_heart', options);
        return this.edgeFallback(text, options);
      }
      return { success: false, error: String(e?.message || e), provider: 'gemini' };
    }
  }

  private async generateEdge(text: string, voice: string, options: {
    rate?: string; pitch?: string; volume?: string;
  }): Promise<TTSResult> {
    // Lazy import to avoid issues if package isn't installed
    const { EdgeTTS } = await import('node-edge-tts');

    const id = randomBytes(6).toString('hex');
    const filename = `tts-${id}.mp3`;
    const outputFile = join(this.audioDir, filename);

    try {
      // Limit text length (Edge TTS handles long text well but let's be sensible)
      const trimmedText = text.substring(0, 50000);

      const tts = new EdgeTTS({
        voice,
        lang: voice.split('-').slice(0, 2).join('-'), // e.g. 'en-US' from 'en-US-AriaNeural'
        outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
        ...(options.rate && { rate: options.rate }),
        ...(options.pitch && { pitch: options.pitch }),
        ...(options.volume && { volume: options.volume }),
      });

      await tts.ttsPromise(trimmedText, outputFile);

      const fileStats = await stat(outputFile);

      // Estimate duration: ~150 words/minute, average word ~5 chars
      const wordCount = trimmedText.split(/\s+/).length;
      const estimatedDuration = Math.round((wordCount / 150) * 60);

      return {
        success: true,
        file: outputFile,
        filename,
        format: 'mp3',
        size: fileStats.size,
        duration: estimatedDuration,
        provider: 'edge',
      };
    } catch (error) {
      return {
        success: false,
        error: `Edge TTS failed: ${String(error)}. Make sure you have internet access.`,
        provider: 'edge',
      };
    }
  }

  /**
   * ElevenLabs v3 — production-quality narration with realistic emotion,
   * paid via the user's API key. Designed for actual audiobook output that
   * pairs with our existing audiobook-prep service.
   */
  private async generateElevenLabs(text: string, voice: string, options: {
    elevenLabsModel?: string;
  }): Promise<TTSResult> {
    if (!this.vault) {
      return { success: false, error: 'ElevenLabs requires the vault. Service not initialized properly.', provider: 'elevenlabs' };
    }
    const apiKey = await this.vault.get('elevenlabs_api_key');
    if (!apiKey) {
      return {
        success: false,
        error: 'ElevenLabs API key not found in vault. Add `elevenlabs_api_key` in Settings → API Keys.',
        provider: 'elevenlabs',
      };
    }

    const modelId = options.elevenLabsModel || 'eleven_v3';
    const trimmedText = text.substring(0, 30000); // ElevenLabs cap is 5k chars per request typically; we'll see
    // ElevenLabs charges per character — guard against accidental huge calls.
    if (trimmedText.length > 5000) {
      return {
        success: false,
        error: `ElevenLabs requests over 5,000 characters cost a lot of credits. ` +
          `This text is ${trimmedText.length} chars. Split it into smaller chunks (one per chapter), ` +
          `or use the Edge TTS provider for longer drafts.`,
        provider: 'elevenlabs',
      };
    }

    const id = randomBytes(6).toString('hex');
    const filename = `tts-${id}.mp3`;
    const outputFile = join(this.audioDir, filename);

    try {
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text: trimmedText,
          model_id: modelId,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.3,
            use_speaker_boost: true,
          },
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        // 401 = bad key, 422 = invalid voice_id, 429 = quota.
        const reason = response.status === 401 ? 'API key rejected'
          : response.status === 422 ? `voice_id "${voice}" not found in your ElevenLabs library`
          : response.status === 429 ? 'rate limit / quota exceeded'
          : `${response.status} ${response.statusText}`;
        return {
          success: false,
          error: `ElevenLabs error: ${reason}. ${body.substring(0, 300)}`,
          provider: 'elevenlabs',
        };
      }

      const arrayBuffer = await response.arrayBuffer();
      await writeFile(outputFile, Buffer.from(arrayBuffer));

      const fileStats = await stat(outputFile);
      const wordCount = trimmedText.split(/\s+/).length;
      const estimatedDuration = Math.round((wordCount / 150) * 60);

      return {
        success: true,
        file: outputFile,
        filename,
        format: 'mp3',
        size: fileStats.size,
        duration: estimatedDuration,
        provider: 'elevenlabs',
      };
    } catch (error) {
      return {
        success: false,
        error: `ElevenLabs request failed: ${String(error)}`,
        provider: 'elevenlabs',
      };
    }
  }

  /**
   * List ElevenLabs voices the user has available (custom + library voices).
   * Cached for 5 minutes to avoid hammering the API on dashboard refresh.
   */
  async listElevenLabsVoices(): Promise<Array<{ voice_id: string; name: string; labels?: any }>> {
    if (!this.vault) return [];
    const apiKey = await this.vault.get('elevenlabs_api_key');
    if (!apiKey) return [];

    const FIVE_MIN = 5 * 60 * 1000;
    if (this.elevenLabsVoicesCache && Date.now() - this.elevenLabsVoicesFetchedAt < FIVE_MIN) {
      return this.elevenLabsVoicesCache;
    }

    try {
      const response = await fetch('https://api.elevenlabs.io/v2/voices', {
        headers: { 'xi-api-key': apiKey, Accept: 'application/json' },
      });
      if (!response.ok) return [];
      const data = await response.json() as any;
      const voices = Array.isArray(data?.voices)
        ? data.voices.map((v: any) => ({
            voice_id: v.voice_id,
            name: v.name,
            labels: v.labels,
          }))
        : [];
      this.elevenLabsVoicesCache = voices;
      this.elevenLabsVoicesFetchedAt = Date.now();
      return voices;
    } catch {
      return [];
    }
  }

  // ── Voice Catalog ──

  /**
   * List available voice presets (author-friendly).
   */
  listPresets(): VoicePreset[] {
    return Object.values(TTSService.VOICE_PRESETS);
  }

  /**
   * Get the raw audio file buffer (for Telegram voice messages, etc.)
   */
  async getAudioBuffer(filePath: string): Promise<Buffer | null> {
    try {
      return await readFile(filePath);
    } catch {
      return null;
    }
  }

  // ── Cleanup ──

  /**
   * Clean up old audio files (older than 24 hours).
   */
  async cleanup(): Promise<number> {
    let cleaned = 0;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;

    try {
      const files = await readdir(this.audioDir);
      for (const file of files) {
        if (!String(file).startsWith('tts-')) continue;
        const filePath = join(this.audioDir, String(file));
        try {
          const stats = await stat(filePath);
          if (stats.mtimeMs < cutoff) {
            await unlink(filePath);
            cleaned++;
          }
        } catch { /* skip */ }
      }
    } catch { /* dir doesn't exist yet */ }

    return cleaned;
  }

  getAudioDir(): string {
    return this.audioDir;
  }
}
