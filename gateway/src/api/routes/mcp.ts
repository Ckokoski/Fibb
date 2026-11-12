/**
 * Connectors by link (Fibb P5): remote MCP servers.
 *
 *   GET    /api/mcp                 -> { connections: [Connection] }
 *   POST   /api/mcp {name, url, token?}            -> 201 { connection }
 *   PATCH  /api/mcp/:id {enabled?, name?, tools?}  -> { connection }
 *   POST   /api/mcp/:id/refresh     -> { connection }
 *   DELETE /api/mcp/:id             -> { ok: true }
 *
 * Connection = { id, name, host, enabled, status: 'ok'|'error'|'unknown', error?,
 *                tools: [{ name, title, description, risk, state: 'on'|'off'|'hidden' }],
 *                hiddenCount }
 *
 * `tools` in PATCH maps a tool name to 'read' | 'write' | 'off' (or null to
 * go back to the default). No route ever returns or echoes the connector's
 * URL or token; only its host.
 */
import type { Request, Response } from 'express';
import type { ApiContext } from '../context.js';
import { McpError } from '../../services/mcp.js';

export function registerMcpRoutes(ctx: ApiContext): void {
  const { app, services } = ctx;
  const none = (res: Response) => res.status(503).json({ error: 'Connectors are not ready yet.' });
  // Only McpError text is safe to show; anything else gets a fixed message.
  const fail = (res: Response, err: unknown, fallback: string) => {
    if (err instanceof McpError) return res.status(err.status).json({ error: err.message });
    return res.status(500).json({ error: fallback });
  };
  const idOf = (req: Request) => String(req.params?.id ?? '');

  app.get('/api/mcp', (_req: Request, res: Response) => {
    if (!services.mcp) return res.json({ connections: [] });
    services.mcp.poke();
    res.json({ connections: services.mcp.list() });
  });

  app.post('/api/mcp', async (req: Request, res: Response) => {
    if (!services.mcp) return none(res);
    const { name, url, token } = req.body || {};
    try {
      res.status(201).json({ connection: await services.mcp.add({ name, url, token }) });
    } catch (err) {
      fail(res, err, 'Fibb could not add that connector.');
    }
  });

  app.patch('/api/mcp/:id', async (req: Request, res: Response) => {
    if (!services.mcp) return none(res);
    const { enabled, name, tools } = req.body || {};
    try {
      res.json({ connection: await services.mcp.update(idOf(req), { enabled, name, tools }) });
    } catch (err) {
      fail(res, err, 'Fibb could not change that connector.');
    }
  });

  app.post('/api/mcp/:id/refresh', async (req: Request, res: Response) => {
    if (!services.mcp) return none(res);
    try {
      res.json({ connection: await services.mcp.refresh(idOf(req)) });
    } catch (err) {
      fail(res, err, 'Fibb could not refresh that connector.');
    }
  });

  app.delete('/api/mcp/:id', async (req: Request, res: Response) => {
    if (!services.mcp) return none(res);
    try {
      await services.mcp.remove(idOf(req));
      res.json({ ok: true });
    } catch (err) {
      fail(res, err, 'Fibb could not remove that connector.');
    }
  });
}
