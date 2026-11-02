import type { Request, Response } from 'express';
import type { ApiContext } from '../context.js';

export function registerCompanionRoutes(ctx: ApiContext): void {
  const { app, services } = ctx;
  app.get('/api/companions', (_req: Request, res: Response) => {
    res.json({ companions: services.companion.list(), activeId: services.companion.getActive().id });
  });
  app.get('/api/companion', (_req: Request, res: Response) => {
    const c = services.companion.getActive();
    res.json({ ...c, voicePreset: services.companion.getVoicePreset(), defaultVoicePreset: c.voicePreset });
  });
  app.post('/api/companion', async (req: Request, res: Response) => {
    const { id, voicePreset } = req.body || {};
    try {
      if (typeof id === 'string') await services.companion.setActive(id);
      if (voicePreset === null || typeof voicePreset === 'string') await services.companion.setVoiceOverride(voicePreset);
      const c = services.companion.getActive();
      res.json({ ...c, voicePreset: services.companion.getVoicePreset(), defaultVoicePreset: c.voicePreset });
    } catch (err: any) {
      res.status(400).json({ error: String(err?.message || err) });
    }
  });
}
