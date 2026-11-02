import { mkdir } from 'fs/promises';
import { logger } from './logger.js';

export interface KokoroStatus { status: 'idle' | 'downloading' | 'ready' | 'error'; percent?: number; error?: string }

export class KokoroEngine {
  private tts: any | null = null;
  private loading: Promise<any> | null = null;
  private progress: KokoroStatus = { status: 'idle' };
  private files = new Map<string, number>();

  constructor(private modelsDir: string, private modelId = 'onnx-community/Kokoro-82M-v1.0-ONNX', private dtype: 'q8' | 'fp16' | 'fp32' = 'q8') {}

  getStatus(): KokoroStatus { return this.progress; }

  async load(): Promise<any> {
    if (this.tts) return this.tts;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      await mkdir(this.modelsDir, { recursive: true });
      const { KokoroTTS } = await import('kokoro-js');
      const hf: any = await import('@huggingface/transformers');
      hf.env.cacheDir = this.modelsDir;
      hf.env.allowLocalModels = true;
      this.progress = { status: 'downloading', percent: 0 };
      const tts = await KokoroTTS.from_pretrained(this.modelId, {
        dtype: this.dtype, device: 'cpu',
        progress_callback: (p: any) => {
          if (p?.status === 'progress' && typeof p.progress === 'number' && p.file) {
            this.files.set(p.file, p.progress);
            // Report the slowest in-flight file so the bar does not claim done early.
            this.progress = { status: 'downloading', percent: Math.round(Math.min(...this.files.values())) };
          }
        },
      });
      this.progress = { status: 'ready', percent: 100 };
      this.tts = tts;
      return tts;
    })().catch(err => {
      this.progress = { status: 'error', error: String(err?.message || err) };
      this.loading = null;
      this.files.clear();
      logger.warn('Kokoro load failed', err);
      throw err;
    });
    return this.loading;
  }

  /** Returns 24 kHz mono WAV bytes. */
  async synthesize(text: string, voice: string): Promise<Buffer> {
    const tts = await this.load();
    const audio = await tts.generate(text, { voice });
    return Buffer.from(audio.toWav());
  }
}
