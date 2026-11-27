/**
 * Tool shelf routes (see services/tool-shelf.ts).
 *
 *   GET    /api/shelf               -> { tools: [{ id, name, kind, summary, access, warnings, code?, files?, createdAt }] }
 *   POST   /api/shelf               { request, kind? } -> 201 { tool } | 400 { error }
 *                                   kind: "bookmarklet" | "extension" | "apps-script" | "page" (guessed from the request when left out)
 *   DELETE /api/shelf/:id           -> { ok: true }   (404 unknown)
 *   GET    /api/shelf/:id/download  -> application/zip attachment (404 unknown, 400 when the tool is not an extension)
 *   GET    /api/shelf/:id/page           -> text/html, the page itself (404 unknown, 400 when the tool is not a page)
 *   GET    /api/shelf/:id/page/download  -> the same HTML as an attachment named <slug>.html
 *
 * 503 when the service is missing. Fibb never installs or runs a tool; these
 * routes only hand back code that passed the safety check.
 *
 * The two page routes are the only place Fibb serves model-written HTML from
 * its own address, so they replace the app-wide security headers:
 *  - Content-Security-Policy with "sandbox": the page gets an origin of its
 *    own. It cannot read Fibb's cookie, and any call it made to /api would
 *    carry "Origin: null", which the request guard refuses. Nothing in the
 *    guard is loosened for these routes; a normal same-origin navigation or
 *    frame load (a GET with no Origin header) already passes it.
 *  - frame-ancestors 'self' and X-Frame-Options: SAMEORIGIN in place of the
 *    app-wide 'none' / DENY, so only the Fibb app itself can show the page in
 *    a frame.
 */
import type { Request, Response } from 'express';
import type { ApiContext } from '../context.js';
import { contentDisposition } from '../../security/paths.js';
import { TOOL_KINDS } from '../../services/tool-shelf-check.js';
import { PAGE_CSP_HEADER } from '../../services/tool-shelf.js';

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
      return res.status(400).json({ error: 'kind must be "bookmarklet", "extension", "apps-script" or "page"' });
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
  // The page is re-checked and hardened by the service on every request.
  const sendPage = (attachment: boolean) => async (req: Request, res: Response) => {
    if (!services.toolShelf) return missing(res);
    try {
      const result = await services.toolShelf.page(String(req.params.id));
      if (!result.ok) {
        return result.reason === 'not_found'
          ? res.status(404).json({ error: 'Tool not found' })
          : res.status(400).json({ error: 'Only pages can be opened this way' });
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', PAGE_CSP_HEADER);
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      if (attachment) res.setHeader('Content-Disposition', contentDisposition('attachment', result.filename));
      res.send(result.html);
    } catch {
      failed(res);
    }
  };
  app.get('/api/shelf/:id/page', sendPage(false));
  app.get('/api/shelf/:id/page/download', sendPage(true));
}
