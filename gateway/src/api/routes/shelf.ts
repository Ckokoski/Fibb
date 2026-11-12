/**
 * Tool shelf routes (see services/tool-shelf.ts).
 *
 *   GET    /api/shelf               -> { tools: [{ id, name, kind, summary, access, warnings, code?, files?, createdAt }] }
 *   POST   /api/shelf               { request, kind? } -> 201 { tool } | 400 { error }
 *                                   kind: "bookmarklet" | "extension" | "apps-script" (guessed from the request when left out)
 *   DELETE /api/shelf/:id           -> { ok: true }   (404 unknown)
 *   GET    /api/shelf/:id/download  -> application/zip attachment (404 unknown, 400 when the tool is not an extension)
 *
 * 503 when the service is missing. Fibb never installs or runs a tool; these
 * routes only hand back code that passed the safety check.
 */
import type { Request, Response } from 'express';
import type { ApiContext } from '../context.js';
import { contentDisposition } from '../../security/paths.js';
import { TOOL_KINDS } from '../../services/tool-shelf-check.js';

export function registerShelfRoutes(ctx: ApiContext): void {
  const { app, services } = ctx;
  const missing = (res: Response) => res.status(503).json({ error: 'Tool shelf not initialized' });
  const failed = (res: Response) => res.status(500).json({ error: 'Fibb could not do that just now. Try again in a moment.' });

  app.get('/api/shelf', async (_req: Request, res: Response) => {
    if (!services.toolShelf) return missing(res);
    try {
      res.json({ tools: await services.toolShelf.list() });
    } catch {
      failed(res);
    }
  });

  app.post('/api/shelf', async (req: Request, res: Response) => {
    if (!services.toolShelf) return missing(res);
    const { request, kind } = req.body || {};
    if (typeof request !== 'string' || !request.trim()) return res.status(400).json({ error: 'request is required' });
    if (kind !== undefined && !TOOL_KINDS.includes(kind)) {
      return res.status(400).json({ error: 'kind must be "bookmarklet", "extension" or "apps-script"' });
    }
    try {
      const result = await services.toolShelf.create({ request, kind });
      if (!result.ok) return res.status(400).json({ error: result.error });
      res.status(201).json({ tool: result.tool });
    } catch {
      failed(res);
    }
  });

  app.delete('/api/shelf/:id', async (req: Request, res: Response) => {
    if (!services.toolShelf) return missing(res);
    try {
      const ok = await services.toolShelf.remove(String(req.params.id));
      if (!ok) return res.status(404).json({ error: 'Tool not found' });
      res.json({ ok: true });
    } catch {
      failed(res);
    }
  });

  app.get('/api/shelf/:id/download', async (req: Request, res: Response) => {
    if (!services.toolShelf) return missing(res);
    try {
      const result = await services.toolShelf.zip(String(req.params.id));
      if (!result.ok) {
        return result.reason === 'not_found'
          ? res.status(404).json({ error: 'Tool not found' })
          : res.status(400).json({ error: 'Only extensions can be downloaded as a zip' });
      }
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', contentDisposition('attachment', result.filename));
      res.setHeader('Content-Length', String(result.buffer.length));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(result.buffer);
    } catch {
      failed(res);
    }
  });
}
