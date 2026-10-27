/**
 * sneakers routes — extracted verbatim from the former monolithic
 * gateway/src/api/routes.ts as part of the Phase 2 god-file split.
 * Behavior-preserving: handler bodies below are unchanged from the original.
 */
import { Request, Response } from 'express';
import type { ApiContext } from '../context.js';

export function registerSneakersRoutes(ctx: ApiContext): void {
  const { app, gateway, services, baseDir } = ctx;

  // ═══════════════════════════════════════════════════════════
  // Lessons API (from Sneakers)
  // ═══════════════════════════════════════════════════════════

  app.get('/api/lessons', (_req: Request, res: Response) => {
    const lessons = services.lessons;
    if (!lessons) return res.json({ lessons: [] });
    res.json({ lessons: lessons.getAll() });
  });

  app.post('/api/lessons', async (req: Request, res: Response) => {
    const lessons = services.lessons;
    if (!lessons) return res.status(503).json({ error: 'Lesson store not available' });

    const { category, lesson: text, source, confidence, goalId } = req.body;
    if (!text) return res.status(400).json({ error: 'lesson text required' });

    const result = await lessons.addLesson({
      timestamp: new Date().toISOString(),
      category: category || 'general',
      lesson: text,
      source: source || 'user-feedback',
      confidence: confidence ?? 0.7,
      goalId,
    });
    res.json({ lesson: result });
  });

  app.post('/api/lessons/:id/adjust', async (req: Request, res: Response) => {
    const lessons = services.lessons;
    if (!lessons) return res.status(503).json({ error: 'Lesson store not available' });

    const delta = req.body.delta ?? 0;
    const result = await lessons.adjustConfidence(req.params.id, delta);
    if (!result) return res.status(404).json({ error: 'Lesson not found' });
    res.json({ lesson: result });
  });

  app.delete('/api/lessons', async (_req: Request, res: Response) => {
    const lessons = services.lessons;
    if (!lessons) return res.status(503).json({ error: 'Lesson store not available' });
    await lessons.reset();
    res.json({ success: true });
  });

  // ═══════════════════════════════════════════════════════════
  // Preferences API (from Sneakers)
  // ═══════════════════════════════════════════════════════════

  app.get('/api/preferences', (_req: Request, res: Response) => {
    const prefs = services.preferences;
    if (!prefs) return res.json({ preferences: {}, metadata: {} });
    res.json(prefs.getAllWithMetadata());
  });

  app.post('/api/preferences', async (req: Request, res: Response) => {
    const prefs = services.preferences;
    if (!prefs) return res.status(503).json({ error: 'Preference store not available' });

    const { key, value, source } = req.body;
    if (!key || value === undefined) return res.status(400).json({ error: 'key and value required' });

    await prefs.set(key, value, source || 'explicit');
    res.json({ success: true, preferences: prefs.getAll() });
  });

  app.delete('/api/preferences/:key', async (req: Request, res: Response) => {
    const prefs = services.preferences;
    if (!prefs) return res.status(503).json({ error: 'Preference store not available' });

    const removed = await prefs.remove(req.params.key);
    if (!removed) return res.status(404).json({ error: 'Preference not found' });
    res.json({ success: true });
  });

  app.delete('/api/preferences', async (_req: Request, res: Response) => {
    const prefs = services.preferences;
    if (!prefs) return res.status(503).json({ error: 'Preference store not available' });
    await prefs.reset();
    res.json({ success: true });
  });
}
