/**
 * Connectors (Fibb P4c): the tool list, Fibb's own browser, and Google.
 *
 *   GET  /api/tools                 -> { tools: [{ name, description, risk, available }] }
 *   GET  /api/browser/status        -> { available, channel?, running, reason? }
 *   POST /api/browser/open {url?}   -> { ok: true }
 *   POST /api/browser/close         -> { ok: true }
 *   GET  /api/google/status         -> { configured, connected, email? }
 *   POST /api/google/client {clientId, clientSecret} -> { ok: true }
 *   GET  /api/google/auth-url       -> { url }
 *   GET  /api/google/callback?code&state -> small HTML page (or plain failure text)
 *   POST /api/google/disconnect     -> { ok: true }
 *
 * No route ever returns a token, the client secret, or the auth code.
 */
import type { Request, Response } from 'express';
import type { ApiContext } from '../context.js';
import { isToolAvailable } from '../../services/tools/registry.js';
import { GoogleError } from '../../services/google.js';

const CONNECTED_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fibb is connected</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family: system-ui, sans-serif; background: #faf7f2; color: #2b2622; text-align: center; padding: 15vh 24px;">
<h1 style="font-size: 26px; margin: 0 0 12px;">Google is connected</h1>
<p style="font-size: 17px; margin: 0;">That worked. You can close this tab and go back to Fibb.</p>
</body></html>`;

const safeMessage = (err: unknown, fallback: string) =>
  err instanceof GoogleError ? err.message : fallback;

export function registerConnectorRoutes(ctx: ApiContext): void {
  const { app, services } = ctx;
  const noBrowser = (res: Response) => res.status(503).json({ error: 'Browser not initialized' });
  const noGoogle = (res: Response) => res.status(503).json({ error: 'Google connector not initialized' });

  // ── Tools ──
  app.get('/api/tools', async (_req: Request, res: Response) => {
    const registry = services.toolRegistry;
    if (!registry) return res.json({ tools: [] });
    const tools = [];
    for (const t of registry.list()) {
      tools.push({ name: t.name, description: t.description, risk: t.risk, available: await isToolAvailable(t) });
    }
    res.json({ tools });
  });

  // ── Fibb's browser ──
  app.get('/api/browser/status', (_req: Request, res: Response) => {
    if (!services.browser) return res.json({ available: false, running: false, reason: 'Browser not initialized' });
    res.json(services.browser.status());
  });

  app.post('/api/browser/open', async (req: Request, res: Response) => {
    if (!services.browser) return noBrowser(res);
    const url = req.body?.url;
    if (url !== undefined && (typeof url !== 'string' || url.length > 2000)) {
      return res.status(400).json({ error: 'url must be a web address' });
    }
    try {
      await services.browser.openForUser(url || undefined);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: String(err?.message || err).slice(0, 200) });
    }
  });

  app.post('/api/browser/close', async (_req: Request, res: Response) => {
    if (!services.browser) return noBrowser(res);
    try { await services.browser.close(); } catch { /* already closed */ }
    res.json({ ok: true });
  });

  // ── Google ──
  app.get('/api/google/status', async (_req: Request, res: Response) => {
    if (!services.google) return res.json({ configured: false, connected: false });
    res.json(await services.google.status());
  });

  app.post('/api/google/client', async (req: Request, res: Response) => {
    if (!services.google) return noGoogle(res);
    const { clientId, clientSecret } = req.body || {};
    try {
      await services.google.setClient(clientId, clientSecret);
      res.json({ ok: true });
    } catch (err) {
      const known = err instanceof GoogleError;
      res.status(known ? 400 : 500).json({ error: safeMessage(err, 'Could not save the Google client.') });
    }
  });

  app.get('/api/google/auth-url', async (_req: Request, res: Response) => {
    if (!services.google) return noGoogle(res);
    try {
      res.json({ url: await services.google.authUrl() });
    } catch (err) {
      res.status(400).json({ error: safeMessage(err, 'Google is not set up yet.') });
    }
  });

  app.get('/api/google/callback', async (req: Request, res: Response) => {
    const fail = (message: string) => res.status(400).type('text/plain').send(message);
    if (!services.google) return fail('Fibb could not connect to Google. Close this tab and try again from Settings.');
    const { code, state } = req.query || {};
    try {
      await services.google.handleCallback(code, state);
      res.status(200).type('html').send(CONNECTED_PAGE);
    } catch (err) {
      // Never echo the code, the state, or anything Google returned.
      fail(safeMessage(err, 'Fibb could not connect to Google. Close this tab and try again from Settings.'));
    }
  });

  app.post('/api/google/disconnect', async (_req: Request, res: Response) => {
    if (!services.google) return noGoogle(res);
    try {
      await services.google.disconnect();
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Could not disconnect Google.' });
    }
  });
}
