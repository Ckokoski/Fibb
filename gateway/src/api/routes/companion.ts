import type { Request, Response } from 'express';
import type { ApiContext } from '../context.js';

export function registerCompanionRoutes(ctx: ApiContext): void {
  const { app, services } = ctx;
  app.get('/api/companions', (_req: Request, res: Response) => {
    res.json({ companions: services.companion.list(), activeId: services.companion.getActive().id });
  });
  const view = () => {
    const c = services.companion.getActive();
    return { name: 'Fibb', look: c.look, image: c.image, states: c.states, voicePreset: services.companion.getVoicePreset(), defaultVoicePreset: c.voicePreset, tagline: c.tagline };
  };
  app.get('/api/companion', (_req: Request, res: Response) => {
    res.json(view());
  });
  app.post('/api/companion', async (req: Request, res: Response) => {
    const { look, id, voicePreset } = req.body || {};
    const pick = typeof look === 'string' ? look : id;
    try {
      if (typeof pick === 'string') await services.companion.setActive(pick);
      if (voicePreset === null || typeof voicePreset === 'string') await services.companion.setVoiceOverride(voicePreset);
      res.json(view());
    } catch (err: any) {
      res.status(400).json({ error: String(err?.message || err) });
    }
  });
}
