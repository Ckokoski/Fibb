/**
 * The session token on a real Express + Socket.IO server (ephemeral loopback
 * port), wired in the same order as gateway/src/index.ts: request guard, cors,
 * session guard, rate limiter, error scrubber, JSON parser, routes, static
 * files and SPA fallbacks (which set the cookie), error handler.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import http from 'http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Server as SocketIO } from 'socket.io';
import type { AddressInfo } from 'net';
import { createRequestGuard, createSocketGuard, createRateLimiter, isAllowedOrigin, type GuardOptions } from './request-guard.js';
import {
  createSessionGuard, createSessionStaticHeaders, grantSessionCookie, createSocketSessionGuard, generateSessionToken, SESSION_DENIED_MESSAGE,
} from './session-token.js';
import { createErrorScrubber, createErrorHandler } from './redact.js';

let server: http.Server;
let io: SocketIO;
let port = 0;
let dir = '';
let hits = 0;
const token = generateSessionToken();
const wrong = generateSessionToken();
const opts: GuardOptions = { port: () => port };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fibb-session-http-'));
  for (const site of ['app', 'legacy']) {
    mkdirSync(join(dir, site, 'assets'), { recursive: true });
    writeFileSync(join(dir, site, 'index.html'), `<h1>${site}</h1>`);
    writeFileSync(join(dir, site, 'assets', 'app.js'), '1');
  }
  const app = express();
  server = http.createServer(app);
  io = new SocketIO(server, { allowRequest: createSocketSessionGuard(() => token, createSocketGuard(opts)) });
  app.use(createRequestGuard(opts));
  app.use(cors({ origin: (origin, cb) => cb(null, !!origin && isAllowedOrigin(origin, opts)), credentials: false }));
  app.use(createSessionGuard(() => token));
  app.use(createRateLimiter());
  app.use(createErrorScrubber());
  app.use(express.json({ limit: '5mb' }));
  app.get('/api/status', (_req, res) => { hits++; res.json({ ok: true }); });
  app.post('/api/echo', (req, res) => { hits++; res.json({ got: req.body }); });
  app.post('/api/audio/transcribe', multer({ storage: multer.memoryStorage() }).single('audio'), (req: any, res) => {
    res.json({ bytes: req.file?.size ?? 0 });
  });
  app.post('/api/chat/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ type: 'done', content: req.body?.message })}\n\n`);
    res.end();
  });
  app.get('/api/google/callback', (_req, res) => { res.type('html').send('<h1>connected</h1>'); });
  app.get('/healthz', (_req, res) => { res.json({ status: 'alive' }); });
  const htmlCookie = { setHeaders: createSessionStaticHeaders(() => token, opts) };
  app.use('/legacy', express.static(join(dir, 'legacy'), htmlCookie));
  app.get('/legacy/*', (req, res) => {
    grantSessionCookie(req, res, token, opts);
    res.sendFile(join(dir, 'legacy', 'index.html'));
  });
  app.use(express.static(join(dir, 'app'), htmlCookie));
  app.use((req: any, res: any, next: any) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Route not found' });
    next();
  });
  app.get('*', (req, res) => {
    grantSessionCookie(req, res, token, opts);
    res.sendFile(join(dir, 'app', 'index.html'));
  });
  app.use(createErrorHandler(() => {}));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>(r => { io.close(() => r()); });
  rmSync(dir, { recursive: true, force: true });
});

const url = (path: string) => `http://127.0.0.1:${port}${path}`;
const self = () => `http://127.0.0.1:${port}`;
const json = { 'Content-Type': 'application/json' };
const cookie = () => ({ Cookie: `fibb_session=${token}` });

/** Raw request, so Host and Sec-Fetch-* can be set freely. */
function raw(path: string, headers: Record<string, string>, method = 'GET'): Promise<{ status: number; body: string; setCookie: string[] }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body, setCookie: res.headers['set-cookie'] || [] }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('session token on a real server', () => {
  it('loading the app HTML sets the cookie, every time, on every HTML entry', async () => {
    const expected = `fibb_session=${token}; Path=/; HttpOnly; SameSite=Strict`;
    for (const path of ['/', '/index.html', '/settings/voice', '/legacy/', '/legacy/index.html', '/legacy/projects/3']) {
      const r = await fetch(url(path));
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/html');
      expect(r.headers.getSetCookie()).toEqual([expected]);
    }
    // Re-set on every load, including a cache revalidation (304).
    const first = await fetch(url('/'));
    const etag = first.headers.get('etag')!;
    expect(etag).toBeTruthy();
    const again = await raw('/', { Host: `127.0.0.1:${port}`, 'If-None-Match': etag });
    expect(again.status).toBe(304);
    expect(again.setCookie).toEqual([expected]);
    // Assets, the liveness probe and the API never hand it out.
    expect((await fetch(url('/assets/app.js'))).headers.getSetCookie()).toEqual([]);
    expect((await fetch(url('/legacy/assets/app.js'))).headers.getSetCookie()).toEqual([]);
    expect((await fetch(url('/healthz'))).headers.getSetCookie()).toEqual([]);
    expect((await fetch(url('/api/status'), { headers: cookie() })).headers.getSetCookie()).toEqual([]);
    // A rebound Host gets the page but not the cookie.
    for (const path of ['/', '/settings', '/legacy/']) {
      const rebound = await raw(path, { Host: `rebind.evil.example.com:${port}` });
      expect(rebound.status).toBe(200);
      expect(rebound.setCookie).toEqual([]);
    }
  });

  it('the cookie from the HTML load is what the API accepts', async () => {
    const page = await fetch(url('/'));
    const pair = page.headers.getSetCookie()[0].split(';')[0];
    const r = await fetch(url('/api/status'), { headers: { Cookie: pair } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it('API without the token is 401 and the handler never runs', async () => {
    const before = hits;
    const r = await fetch(url('/api/status'));
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: SESSION_DENIED_MESSAGE });
    const post = await fetch(url('/api/echo'), { method: 'POST', headers: json, body: JSON.stringify({ a: 1 }) });
    expect(post.status).toBe(401);
    // Unknown API routes do not reveal themselves either.
    expect((await fetch(url('/api/nope'))).status).toBe(401);
    expect(hits).toBe(before);
  });

  it('a wrong token is 401, in the cookie or in the header', async () => {
    const before = hits;
    expect((await fetch(url('/api/status'), { headers: { Cookie: `fibb_session=${wrong}` } })).status).toBe(401);
    expect((await fetch(url('/api/status'), { headers: { 'X-Fibb-Token': wrong } })).status).toBe(401);
    expect((await fetch(url('/api/status'), { headers: { 'X-Fibb-Token': token.slice(0, 63) } })).status).toBe(401);
    expect((await fetch(url('/api/status'), { headers: { Cookie: `other=${token}` } })).status).toBe(401);
    expect(hits).toBe(before);
  });

  it('the header token works (internal callers such as the Telegram bridge)', async () => {
    const r = await fetch(url('/api/echo'), { method: 'POST', headers: { ...json, 'X-Fibb-Token': token }, body: JSON.stringify({ text: 'x' }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ got: { text: 'x' } });
    expect((await fetch(url('/api/status'), { headers: { 'X-Fibb-Token': token } })).status).toBe(200);
  });

  it('the Google OAuth callback is reachable without the token, and only by GET', async () => {
    const r = await raw('/api/google/callback?code=x&state=y', { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' });
    expect(r.status).toBe(200);
    expect(r.body).toContain('connected');
    expect(r.setCookie).toEqual([]);
    expect((await fetch(url('/api/google/callback'), { method: 'POST', headers: json, body: '{}' })).status).toBe(401);
  });

  it('SSE chat and the multipart upload still pass with the cookie, and not without', async () => {
    const sse = await fetch(url('/api/chat/stream'), { method: 'POST', headers: { ...json, ...cookie(), Origin: self() }, body: JSON.stringify({ message: 'hi' }) });
    expect(sse.status).toBe(200);
    expect(sse.headers.get('content-type')).toContain('text/event-stream');
    expect(await sse.text()).toContain('"content":"hi"');
    expect((await fetch(url('/api/chat/stream'), { method: 'POST', headers: { ...json, Origin: self() }, body: JSON.stringify({ message: 'hi' }) })).status).toBe(401);

    const form = () => {
      const fd = new FormData();
      fd.append('audio', new Blob([new Uint8Array(1234)], { type: 'audio/webm' }), 'note.webm');
      return fd;
    };
    const up = await fetch(url('/api/audio/transcribe'), { method: 'POST', headers: { ...cookie(), Origin: self() }, body: form() });
    expect(await up.json()).toEqual({ bytes: 1234 });
    expect((await fetch(url('/api/audio/transcribe'), { method: 'POST', headers: { Origin: self() }, body: form() })).status).toBe(401);
  });

  it('runs after the Host/Origin guard: a foreign page is refused with 403 even with a valid token', async () => {
    const evil = await fetch(url('/api/status'), { headers: { ...cookie(), Origin: 'https://evil.example.com', 'Sec-Fetch-Site': 'cross-site' } });
    expect(evil.status).toBe(403);
    const rebound = await raw('/api/status', { Host: `rebind.evil.example.com:${port}`, Cookie: `fibb_session=${token}` });
    expect(rebound.status).toBe(403);
  });

  it('a preflight from an allowed origin is still answered (it carries no cookie)', async () => {
    const r = await fetch(url('/api/echo'), { method: 'OPTIONS', headers: { Origin: self(), 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-fibb-token' } });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe(self());
  });

  it('Socket.IO handshake: refused without the token or with a wrong one, accepted with it', async () => {
    const handshake = '/socket.io/?EIO=4&transport=polling';
    const host = { Host: `127.0.0.1:${port}` };
    expect((await raw(handshake, host)).status).toBe(403);
    expect((await raw(handshake, { ...host, Cookie: `fibb_session=${wrong}` })).status).toBe(403);
    expect((await raw(handshake, { ...host, 'X-Fibb-Token': wrong })).status).toBe(403);
    const withCookie = await raw(handshake, { ...host, Cookie: `fibb_session=${token}` });
    expect(withCookie.status).toBe(200);
    expect(withCookie.body).toContain('"sid"');
    expect((await raw(handshake, { ...host, 'X-Fibb-Token': token })).status).toBe(200);
    // The Origin guard still applies to the handshake.
    expect((await raw(handshake, { ...host, Cookie: `fibb_session=${token}`, Origin: 'https://evil.example.com' })).status).toBe(403);
  });
});
