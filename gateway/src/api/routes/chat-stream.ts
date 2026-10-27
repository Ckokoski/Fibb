/**
 * POST /api/chat/stream — Server-Sent Events chat. Events:
 *   data: {"type":"chunk","content":"..."}   repeated
 *   data: {"type":"done","content":"<full text>"}
 *   data: {"type":"error","message":"..."}
 * GET /api/facts, DELETE /api/facts?phrase=... — the facts memory.
 */
import type { Request, Response } from 'express';
import type { ApiContext } from '../context.js';

export function registerChatStreamRoutes(ctx: ApiContext): void {
  const { app, gateway, services } = ctx;

  app.post('/api/chat/stream', async (req: Request, res: Response) => {
    const { message, channel } = req.body || {};
    if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Message required' });
    if (message.length > 10000) return res.status(400).json({ error: 'Message too long (max 10,000 chars)' });
    const ch = typeof channel === 'string' && /^[a-zA-Z0-9:_-]{1,64}$/.test(channel) ? channel : 'webchat';

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    let closed = false;
    let terminal = false;
    req.on('close', () => { closed = true; });
    const send = (obj: any) => {
      if (closed) return;
      if (obj?.type === 'done' || obj?.type === 'error') terminal = true;
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    try {
      await gateway.handleMessage(
        message, ch,
        (full: string) => send({ type: 'done', content: full }),
        undefined, undefined, undefined,
        (chunk: string) => send({ type: 'chunk', content: chunk }),
      );
    } catch (err: any) {
      const msg = String(err?.message || err);
      send({ type: 'error', message: msg.includes('No AI providers')
        ? 'No AI provider is reachable. Paste a free Gemini key or install Ollama.'
        : 'AI error: ' + msg });
    }
    if (!terminal && !closed) send({ type: 'done', content: '' });
    res.end();
  });

  app.get('/api/facts', (_req: Request, res: Response) => {
    res.json(services.facts.get());
  });

  app.delete('/api/facts', async (req: Request, res: Response) => {
    const phrase = String(req.query.phrase || '');
    if (!phrase) return res.status(400).json({ error: 'phrase required' });
    const removed = await services.facts.forget(phrase);
    res.json({ removed });
  });
}
