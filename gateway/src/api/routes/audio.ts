/**
 * audio routes — extracted verbatim from the former monolithic
 * gateway/src/api/routes.ts as part of the Phase 2 god-file split.
 * Behavior-preserving: handler bodies below are unchanged from the original.
 */
import { Request, Response } from 'express';
import type { ApiContext } from '../context.js';
import path from 'path';
import multer from 'multer';
import { safePath } from '../context.js';
import { isKnownVoice } from '../../services/tts-catalog.js';

// Dedicated memory-storage uploader for audio clips: the shared manuscript
// `upload` rejects non-.txt/.md/.docx names. 10 MB cap, no extension filter.
const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

export function registerAudioRoutes(ctx: ApiContext): void {
  const { app, gateway, services, baseDir } = ctx;

  // ═══════════════════════════════════════════════════════════
  // TTS / Audio (Edge TTS free + ElevenLabs paid — pluggable providers)
  // ═══════════════════════════════════════════════════════════

  /**
   * Resolve voice priority: explicit voice > persona's voice > project preset > default.
   * Used by both /api/audio/generate and the project narration code.
   */
  async function resolveVoiceForRequest(opts: {
    explicitVoice?: string;
    personaId?: string;
    projectId?: string;
  }): Promise<{ voice?: string; provider?: 'edge' | 'kokoro' | 'gemini' | 'elevenlabs' }> {
    if (opts.explicitVoice) return { voice: opts.explicitVoice };
    // Try project's linked persona
    if (opts.projectId && services.projects) {
      const project = services.projects.getProject?.(opts.projectId);
      if (project?.personaId && services.personas) {
        const persona = services.personas.get?.(project.personaId);
        if (persona?.ttsVoice) return { voice: persona.ttsVoice };
      }
    }
    // Or direct personaId
    if (opts.personaId && services.personas) {
      const persona = services.personas.get?.(opts.personaId);
      if (persona?.ttsVoice) return { voice: persona.ttsVoice };
    }
    return {};
  }

  // Generate audio from text. Provider auto-detected from voice format
  // (Edge for "en-US-AriaNeural"-style, ElevenLabs for 20-char voice_ids).
  app.post('/api/audio/generate', async (req: Request, res: Response) => {
    const { text, voice, rate, pitch, volume, provider, personaId, projectId, elevenLabsModel } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Text required' });
    }
    if (text.length > 50000) {
      return res.status(400).json({ error: 'Text too long (max 50,000 chars)' });
    }

    if (!services.tts) {
      return res.status(503).json({ error: 'TTS service not initialized' });
    }

    // Resolve persona-aware voice if no explicit voice was passed.
    const resolved = await resolveVoiceForRequest({
      explicitVoice: voice,
      personaId,
      projectId,
    });

    const result = await services.tts.generate(text, {
      voice: resolved.voice ?? services.companion?.getVoicePreset(),
      provider: provider || resolved.provider,
      rate, pitch, volume,
      elevenLabsModel,
    });
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  });

  // Transcribe an uploaded audio clip (multer memory storage, field "audio").
  app.post('/api/audio/transcribe', (req: Request, res: Response, next: any) => audioUpload.single('audio')(req, res, (err: any) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Audio too large (max 10 MB)' });
    if (err) return res.status(400).json({ error: String(err.message || err) });
    next();
  }), async (req: Request, res: Response) => {
    const file = (req as any).file as { buffer: Buffer; mimetype: string; size: number } | undefined;
    if (!file?.buffer?.length) return res.status(400).json({ error: 'audio file required (multipart field "audio")' });
    const mt = file.mimetype || '';
    if (!(mt.startsWith('audio/') || mt === 'video/webm' || mt === 'application/octet-stream')) return res.status(415).json({ error: 'Unsupported media type: ' + mt });
    try {
      const out = await services.transcribe.transcribe(file.buffer, file.mimetype || 'audio/webm');
      res.json(out);
    } catch (err: any) {
      const msg = String(err?.message || err);
      res.status(msg.includes('No transcription provider') ? 503 : 500).json({ error: msg });
    }
  });

  // Namespaced voice catalog across providers (edge, kokoro, gemini, elevenlabs).
  app.get('/api/audio/voices', async (_req: Request, res: Response) => {
    if (!services.tts) return res.status(503).json({ error: 'TTS service not initialized' });
    res.json({
      activeVoice: services.tts.getActiveVoice(),
      catalog: await services.tts.listCatalog(),
      kokoro: services.tts.kokoroStatus(),
    });
  });

  app.post('/api/audio/kokoro/install', (_req: Request, res: Response) => {
    if (!services.tts) return res.status(503).json({ error: 'TTS service not initialized' });
    res.json(services.tts.installKokoro());
  });
  app.get('/api/audio/kokoro/status', (_req: Request, res: Response) => {
    if (!services.tts) return res.status(503).json({ error: 'TTS service not initialized' });
    res.json(services.tts.kokoroStatus());
  });

  // Set the global default TTS provider/voice.
  app.post('/api/audio/config', async (req: Request, res: Response) => {
    if (!services.tts) return res.status(503).json({ error: 'TTS service not initialized' });
    const { voice, provider } = req.body || {};
    if (voice) {
      if (typeof voice !== 'string' || !isKnownVoice(voice)) return res.status(400).json({ error: 'Unknown voice' });
      await services.tts.setVoice(voice);
    }
    if (provider === 'edge' || provider === 'kokoro' || provider === 'gemini' || provider === 'elevenlabs') {
      await services.tts.setProvider(provider);
    }
    res.json({
      activeProvider: services.tts.getActiveProvider(),
      activeVoice: services.tts.getActiveVoice(),
    });
  });

  // Serve generated audio files
  app.get('/api/audio/file/:filename', async (req: Request, res: Response) => {
    const { existsSync: ex } = await import('fs');
    const fname = String(req.params.filename);
    const audioDir = path.join(baseDir, 'workspace', 'audio');
    const filePath = safePath(audioDir, fname);

    // Security: prevent path traversal
    if (!filePath) {
      return res.status(403).json({ error: 'Path traversal blocked' });
    }

    if (!ex(filePath)) {
      return res.status(404).json({ error: 'Audio file not found' });
    }

    const ext = fname.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      mp3: 'audio/mpeg',
      ogg: 'audio/ogg',
      wav: 'audio/wav',
    };
    res.setHeader('Content-Type', mimeTypes[ext || ''] || 'audio/mpeg');
    res.setHeader('Content-Disposition', `inline; filename="${fname}"`);
    const { createReadStream } = await import('fs');
    createReadStream(filePath).pipe(res);
  });

  // Get/set the active voice
  app.get('/api/audio/voice', async (_req: Request, res: Response) => {
    res.json({ voice: services.tts?.getActiveVoice() || 'en-US-AriaNeural' });
  });

  app.post('/api/audio/voice', async (req: Request, res: Response) => {
    const { voice } = req.body;
    if (!voice || typeof voice !== 'string') {
      return res.status(400).json({ error: 'voice is required (e.g., "narrator_female" or "en-US-AriaNeural")' });
    }
    if (!services.tts) {
      return res.status(503).json({ error: 'TTS service not initialized' });
    }
    // Resolve preset name to voice ID before saving
    const resolvedVoice = services.tts.resolveVoice(voice);
    await services.tts.setVoice(resolvedVoice);
    res.json({ success: true, voice: resolvedVoice, message: `Voice set to ${resolvedVoice}. This persists across restarts.` });
  });

}
