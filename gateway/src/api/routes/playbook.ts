/**
 * The playbook: things Fibb can do, listed and run on demand
 * (see services/playbook.ts and services/notices.ts).
 *
 *   GET  /api/playbook           -> { plays: [{ id, category, title, blurb, label, kind, available, missing? }] }
 *                                   Rendered for the current book and tools, grouped by category in a
 *                                   fixed order. Never includes the work order behind a play.
 *   POST /api/playbook/:id/run   { when?: 'tonight' | 'now' } -> { ok: true, message?, say?, taskId? }
 *                                   task: queued (default `now`, which also starts it); schedule: a
 *                                   cron job; say: the text for the app to send as the author.
 *                                   400 bad `when`, 404 unknown id, 409 { error, missing } when the
 *                                   play needs something that is not there, 409 when the schedule
 *                                   already exists.
 *
 * 503 when the service is missing.
 */
import type { Request, Response } from 'express';
import type { ApiContext } from '../context.js';

const WHENS = ['tonight', 'now'];
const MISSING_TEXT: Record<string, string> = {
  book: 'Tell Fibb about your book first, then try again.',
  google: 'Connect Google first, then try again.',
  browser: 'Fibb needs a browser for this one. Install Edge or Chrome, then try again.',
};

export function registerPlaybookRoutes(ctx: ApiContext): void {
  const { app, services } = ctx;
  const missing = (res: Response) => res.status(503).json({ error: 'Playbook not initialized' });
  const failed = (res: Response) => res.status(500).json({ error: 'Fibb could not do that just now. Try again in a moment.' });

  app.get('/api/playbook', async (_req: Request, res: Response) => {
    if (!services.notices) return missing(res);
    try {
      res.json({ plays: await services.notices.playbook() });
    } catch {
      failed(res);
    }
  });

  app.post('/api/playbook/:id/run', async (req: Request, res: Response) => {
    if (!services.notices) return missing(res);
    const when = req.body?.when;
    if (when !== undefined && !WHENS.includes(when)) return res.status(400).json({ error: 'when must be "tonight" or "now"' });
    try {
      const r = await services.notices.runPlay(String(req.params.id), { when });
      if (!r.ok) {
        if (r.reason === 'not_found') return res.status(404).json({ error: 'Play not found' });
        if (r.reason === 'unavailable') return res.status(409).json({ error: MISSING_TEXT[r.missing] || 'That is not available yet.', missing: r.missing });
        if (r.reason === 'exists') return res.status(409).json({ error: 'That is already on your schedule.' });
        return failed(res);
      }
      // Same as POST /api/tasks: a `now` task starts right away, un-awaited.
      if (r.taskId && when !== 'tonight' && services.nightShift) void services.nightShift.runTask(r.taskId);
      const body: { ok: true; message?: string; say?: string; taskId?: string } = { ok: true };
      if (r.message) body.message = r.message;
      if (r.say) body.say = r.say;
      if (r.taskId) body.taskId = r.taskId;
      res.json(body);
    } catch {
      failed(res);
    }
  });
}
