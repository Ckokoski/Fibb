/**
 * The guard on a real Express app (ephemeral loopback port), wired in the same
 * order as gateway/src/index.ts: guard, cors, rate limiter, error scrubber,
 * JSON parser, routes, error handler. Proves the same-origin app's requests
 * (JSON, multipart upload, SSE) still work and a foreign page's do not.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import http from 'http';
import type { AddressInfo } from 'net';
import { createRequestGuard, createRateLimiter, isAllowedOrigin, type GuardOptions } from './request-guard.js';
import { createErrorScrubber, createErrorHandler } from './redact.js';

let server: http.Server;
let port = 0;
let approved = 0;
const opts: GuardOptions = { port: () => port };

beforeAll(async () => {
  const app = express();
  app.use(createRequestGuard(opts));
  app.use(cors({ origin: (origin, cb) => cb(null, !!origin && isAllowedOrigin(origin, opts)), credentials: false }));
  app.use(createRateLimiter());
  app.use(createErrorScrubber());
  app.use(express.json({ limit: '5mb' }));
  app.get('/api/vault/keys', (_req, res) => { res.json({ keys: ['gemini_api_key'] }); });
  app.post('/api/approvals/:id/approve', (_req, res) => { approved++; res.json({ ok: true }); });
  app.post('/api/echo', (req, res) => { res.json({ got: req.body }); });
  app.post('/api/audio/transcribe', multer({ storage: multer.memoryStorage() }).single('audio'), (req: any, res) => {
    res.json({ bytes: req.file?.size ?? 0 });
  });
  app.post('/api/chat/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ type: 'done', content: req.body?.message })}\n\n`);
    res.end();
  });
  app.get('/api/google/callback', (_req, res) => { res.type('html').send('<h1>ok</h1>'); });
  app.get('/api/boom', () => { throw new Error('secret path C:\\Users\\chris\\vault.key'); });
  app.get('/', (_req, res) => { res.send('app'); });
  app.use(createErrorHandler(() => {}));
  server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => { await new Promise(r => server.close(r)); });

const url = (path: string) => `http://127.0.0.1:${port}${path}`;
const self = () => `http://127.0.0.1:${port}`;
const json = { 'Content-Type': 'application/json' };

/** Raw request, so the Host header can be forged (as DNS rebinding does). */
function raw(path: string, headers: Record<string, string>, method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('request guard on a real server', () => {
  it('the same-origin app works: JSON, body-less POST, multipart upload, SSE', async () => {
    const echo = await fetch(url('/api/echo'), { method: 'POST', headers: { ...json, Origin: self(), 'Sec-Fetch-Site': 'same-origin' }, body: JSON.stringify({ a: 1 }) });
    expect(await echo.json()).toEqual({ got: { a: 1 } });

    const before = approved;
    const approve = await fetch(url('/api/approvals/conf-1/approve'), { method: 'POST', headers: { Origin: self() } });
    expect(approve.status).toBe(200);
    expect(approved).toBe(before + 1);

    const fd = new FormData();
    fd.append('audio', new Blob([new Uint8Array(1234)], { type: 'audio/webm' }), 'note.webm');
    const up = await fetch(url('/api/audio/transcribe'), { method: 'POST', headers: { Origin: self() }, body: fd });
    expect(await up.json()).toEqual({ bytes: 1234 });

    const sse = await fetch(url('/api/chat/stream'), { method: 'POST', headers: { ...json, Origin: self() }, body: JSON.stringify({ message: 'hi' }) });
    expect(sse.headers.get('content-type')).toContain('text/event-stream');
    expect(await sse.text()).toContain('"content":"hi"');

    expect((await fetch(url('/api/vault/keys'))).status).toBe(200);
    expect((await fetch(url('/'))).status).toBe(200);
  });

  it('non-browser local callers work without an Origin (as the Telegram bridge calls do)', async () => {
    const r = await fetch(url('/api/echo'), { method: 'POST', headers: json, body: JSON.stringify({ text: 'x' }) });
    expect(r.status).toBe(200);
    expect((await fetch(url('/api/approvals/conf-1/approve'), { method: 'POST' })).status).toBe(200);
  });

  it('a foreign page cannot approve, post or read, and gets no CORS grant', async () => {
    const before = approved;
    const evil = { Origin: 'https://evil.example.com', 'Sec-Fetch-Site': 'cross-site' };
    const a = await fetch(url('/api/approvals/conf-1/approve'), { method: 'POST', headers: evil });
    expect(a.status).toBe(403);
    expect(a.headers.get('access-control-allow-origin')).toBeNull();
    const form = await fetch(url('/api/approvals/conf-1/approve'), { method: 'POST', headers: { 'Content-Type': 'text/plain', 'Sec-Fetch-Site': 'cross-site' }, body: 'x' });
    expect(form.status).toBe(403);
    const simple = await fetch(url('/api/echo'), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"a":1}' });
    expect(simple.status).toBe(415);
    const read = await fetch(url('/api/vault/keys'), { headers: evil });
    expect(read.status).toBe(403);
    expect(await read.text()).not.toContain('gemini_api_key');
    const preflight = await fetch(url('/api/echo'), { method: 'OPTIONS', headers: { ...evil, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
    expect(approved).toBe(before);
  });

  it('own-origin responses carry that origin, never a wildcard or credentials', async () => {
    const r = await fetch(url('/api/vault/keys'), { headers: { Origin: self() } });
    expect(r.headers.get('access-control-allow-origin')).toBe(self());
    expect(r.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('DNS rebinding: a foreign Host header is refused even when it looks same-origin', async () => {
    const before = approved;
    const host = `rebind.evil.example.com:${port}`;
    expect((await raw('/api/vault/keys', { Host: host })).status).toBe(403);
    expect((await raw('/api/approvals/conf-1/approve', { Host: host, Origin: `http://${host}`, 'Sec-Fetch-Site': 'same-origin' }, 'POST')).status).toBe(403);
    expect((await raw('/api/vault/keys', { Host: `localhost:${port}` })).status).toBe(200);
    expect(approved).toBe(before);
  });

  it('the Google OAuth callback (cross-site top-level navigation) still loads', async () => {
    // Raw request: Node's fetch overwrites Sec-Fetch-Mode.
    const r = await raw('/api/google/callback?code=x&state=y', { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' });
    expect(r.status).toBe(200);
    expect(r.body).toContain('ok');
    // The same request as a cross-site subresource (img/script) is refused.
    const embed = await raw('/api/google/callback?code=x&state=y', { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors' });
    expect(embed.status).toBe(403);
  });

  it('errors reach the client as JSON without the raw message, path or stack', async () => {
    const boom = await fetch(url('/api/boom'));
    expect(boom.status).toBe(500);
    const text = await boom.text();
    expect(text).not.toMatch(/chris|vault\.key|at /);
    expect(JSON.parse(text).error).toBeTruthy();
    const bad = await fetch(url('/api/echo'), { method: 'POST', headers: json, body: '{not json' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'The request body is not valid JSON.' });
  });
});
