/**
 * "I noticed" routes (see services/notices.ts).
 *
 *   GET  /api/notices               -> { notices: [{ id, text, action?: { label, kind }, createdAt }] }
 *   POST /api/notices/:id/accept    -> { ok: true, message?, say? }   (404 unknown, 409 not new)
 *   POST /api/notices/:id/dismiss   -> { ok: true }                   (404 unknown, 409 not new)
 *   GET  /api/notices/settings      -> { enabled }
 *   POST /api/notices/settings      { enabled: boolean } -> { enabled }   (400 on non-boolean)
 *
 * 503 when the service is missing.
 */
import type { Request, Response } from 'express';
import type { ApiContext } from '../context.js';

export function registerNoticeRoutes(ctx: ApiContext): void {
  const { app, services } = ctx;
  const missing = (res: Response) => res.status(503).json({ error: 'Notices not initialized' });
  const refuse = (res: Response, reason: string) =>
    reason === 'not_found' ? res.status(404).json({ error: 'Notice not found' })
      : reason === 'not_new' ? res.status(409).json({ error: 'This notice was already answered' })
        : res.status(500).json({ error: 'Fibb could not do that just now. Try again in a moment.' });

  app.get('/api/notices', (_req: Request, res: Response) => {
    if (!services.notices) return missing(res);
    res.json({ notices: services.notices.list() });
  });

  // Static paths before /:id.
  app.get('/api/notices/settings', (_req: Request, res: Response) => {
    if (!services.notices) return missing(res);
    res.json({ enabled: services.notices.isEnabled() });
  });

  app.post('/api/notices/settings', async (req: Request, res: Response) => {
    if (!services.notices) return missing(res);
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
    try {
      res.json({ enabled: await services.notices.setEnabled(enabled) });
    } catch {
      res.status(500).json({ error: 'Could not save that setting.' });
    }
  });

  app.post('/api/notices/:id/accept', async (req: Request, res: Response) => {
    if (!services.notices) return missing(res);
    try {
      const r = await services.notices.accept(String(req.params.id));
      if (!r.ok) return refuse(res, r.reason);
      const body: { ok: true; message?: string; say?: string } = { ok: true };
      if (r.message) body.message = r.message;
      if (r.say) body.say = r.say;
      res.json(body);
    } catch {
      refuse(res, 'failed');
    }
  });

  app.post('/api/notices/:id/dismiss', async (req: Request, res: Response) => {
    if (!services.notices) return missing(res);
    try {
      const r = await services.notices.dismiss(String(req.params.id));
      if (!r.ok) return refuse(res, r.reason);
      res.json({ ok: true });
    } catch {
      refuse(res, 'failed');
    }
  });
}
