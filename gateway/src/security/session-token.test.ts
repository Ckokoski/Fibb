import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadOrCreateSessionToken, sessionTokenPath, isValidSessionToken, generateSessionToken, tokensEqual, readCookies,
  sessionCookie, isSessionExempt, evaluateSession, hasSessionToken, createSessionGuard,
  grantSessionCookie, createSessionStaticHeaders, createSocketSessionGuard, SESSION_DENIED_MESSAGE,
} from './session-token.js';

const TOKEN = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

describe('session token file', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fibb-session-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('creates a 256-bit token on first start and reuses it afterwards', () => {
    const t = loadOrCreateSessionToken(dir);
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(sessionTokenPath(dir), 'utf-8').trim()).toBe(t);
    expect(sessionTokenPath(dir)).toBe(join(dir, '.config', 'session-token'));
    expect(loadOrCreateSessionToken(dir)).toBe(t);
    // No temp file left behind.
    expect(existsSync(`${sessionTokenPath(dir)}.tmp`)).toBe(false);
  });

  it.each(['', 'short', 'z'.repeat(64), 'A'.repeat(64), `${'a'.repeat(64)}\n${'b'.repeat(64)}`])('regenerates a malformed token (%j)', (bad) => {
    mkdirSync(join(dir, '.config'), { recursive: true });
    writeFileSync(sessionTokenPath(dir), bad);
    const t = loadOrCreateSessionToken(dir);
    expect(isValidSessionToken(t)).toBe(true);
    expect(t).not.toBe(bad);
    expect(readFileSync(sessionTokenPath(dir), 'utf-8').trim()).toBe(t);
  });

  it('is private to the user where the platform has file modes', () => {
    loadOrCreateSessionToken(dir);
    if (process.platform !== 'win32') {
      expect(statSync(sessionTokenPath(dir)).mode & 0o777).toBe(0o600);
    }
  });

  it('every token is different', () => {
    expect(generateSessionToken()).not.toBe(generateSessionToken());
  });
});

describe('token comparison and cookie parsing', () => {
  it('tokensEqual: equal only for the same non-empty string, any length is safe', () => {
    expect(tokensEqual(TOKEN, TOKEN)).toBe(true);
    expect(tokensEqual(OTHER, TOKEN)).toBe(false);
    expect(tokensEqual(TOKEN.slice(0, 63), TOKEN)).toBe(false);
    expect(tokensEqual(TOKEN + 'a', TOKEN)).toBe(false);
    expect(tokensEqual('', '')).toBe(false);
    expect(tokensEqual(undefined, TOKEN)).toBe(false);
    expect(tokensEqual(TOKEN, undefined)).toBe(false);
    expect(tokensEqual(['x'] as any, TOKEN)).toBe(false);
  });

  it('readCookies finds the named cookie among others, quoted or repeated', () => {
    expect(readCookies(`theme=dark; fibb_session=${TOKEN}; x=1`, 'fibb_session')).toEqual([TOKEN]);
    expect(readCookies(`fibb_session="${TOKEN}"`, 'fibb_session')).toEqual([TOKEN]);
    expect(readCookies(`fibb_session=${OTHER}; fibb_session=${TOKEN}`, 'fibb_session')).toEqual([OTHER, TOKEN]);
    expect(readCookies(`not_fibb_session=${TOKEN}; fibb_session_x=${TOKEN}`, 'fibb_session')).toEqual([]);
    expect(readCookies(undefined, 'fibb_session')).toEqual([]);
    expect(readCookies('garbage', 'fibb_session')).toEqual([]);
  });

  it('the cookie is HttpOnly, SameSite=Strict, Path=/, with no Secure and no lifetime', () => {
    const c = sessionCookie(TOKEN);
    expect(c).toBe(`fibb_session=${TOKEN}; Path=/; HttpOnly; SameSite=Strict`);
    expect(c).not.toMatch(/Secure|Max-Age|Expires/i);
  });
});

describe('evaluateSession', () => {
  const ok = (over: any) => evaluateSession({ method: 'GET', path: '/api/status', ...over }, TOKEN);

  it('requires the token on /api, from the cookie or the header', () => {
    expect(ok({})).toBe(false);
    expect(ok({ cookie: `fibb_session=${TOKEN}` })).toBe(true);
    expect(ok({ headerToken: TOKEN })).toBe(true);
    expect(ok({ cookie: `fibb_session=${OTHER}` })).toBe(false);
    expect(ok({ headerToken: OTHER })).toBe(false);
    expect(ok({ headerToken: OTHER, cookie: `fibb_session=${TOKEN}` })).toBe(true);
    expect(ok({ method: 'POST', path: '/api/chat/stream' })).toBe(false);
    expect(ok({ path: '/api' })).toBe(false);
  });

  it('non-API paths pass', () => {
    expect(ok({ path: '/' })).toBe(true);
    expect(ok({ path: '/assets/app.js' })).toBe(true);
    expect(ok({ path: '/apix' })).toBe(true);
  });

  it('only GET /api/google/callback is exempt', () => {
    expect(isSessionExempt('GET', '/api/google/callback')).toBe(true);
    expect(isSessionExempt('get', '/api/google/callback/')).toBe(true);
    expect(isSessionExempt('POST', '/api/google/callback')).toBe(false);
    expect(isSessionExempt('GET', '/api/google/callback/x')).toBe(false);
    expect(isSessionExempt('GET', '/api/google/auth-url')).toBe(false);
    expect(isSessionExempt('GET', '/api/health')).toBe(false);
    expect(ok({ path: '/api/google/callback' })).toBe(true);
    expect(ok({ method: 'POST', path: '/api/google/client' })).toBe(false);
  });

  it('fails closed when the server has no valid token', () => {
    expect(hasSessionToken({ headerToken: '' }, '')).toBe(false);
    expect(hasSessionToken({ headerToken: 'x' }, 'x')).toBe(false);
    expect(evaluateSession({ method: 'GET', path: '/api/status', headerToken: '' }, '')).toBe(false);
  });
});

describe('middleware', () => {
  const run = (mw: any, req: any) => {
    const res: any = { code: 200, body: undefined, cookies: [] as string[] };
    res.status = (c: number) => { res.code = c; return res; };
    res.json = (b: any) => { res.body = b; return res; };
    res.append = (_n: string, v: string) => { res.cookies.push(v); return res; };
    let passed = false;
    mw(req, res, () => { passed = true; });
    return { res, passed };
  };

  it('guard: 401 with the fixed message, audited without the token', () => {
    const events: any[] = [];
    const guard = createSessionGuard(() => TOKEN, (c, a, d) => { events.push({ c, a, d }); });
    const denied = run(guard, { method: 'GET', originalUrl: '/api/vault/keys?x=1', headers: { 'x-fibb-token': OTHER } });
    expect(denied.passed).toBe(false);
    expect(denied.res.code).toBe(401);
    expect(denied.res.body).toEqual({ error: SESSION_DENIED_MESSAGE });
    expect(SESSION_DENIED_MESSAGE).toBe('Not signed in to Fibb. Reload the page.');
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(OTHER);
    expect(JSON.stringify(events)).not.toContain(TOKEN);
    expect(run(guard, { method: 'GET', originalUrl: '/api/vault/keys', headers: { 'x-fibb-token': TOKEN } }).passed).toBe(true);
    expect(run(guard, { method: 'GET', originalUrl: '/api/vault/keys', headers: { cookie: `fibb_session=${TOKEN}` } }).passed).toBe(true);
    expect(run(guard, { method: 'GET', originalUrl: '/', headers: {} }).passed).toBe(true);
  });

  it('guard: an audit failure never lets a request through or throws', () => {
    const guard = createSessionGuard(() => TOKEN, () => { throw new Error('disk full'); });
    const r = run(guard, { method: 'POST', originalUrl: '/api/chat', headers: {} });
    expect(r.passed).toBe(false);
    expect(r.res.code).toBe(401);
  });

  it('cookie: granted for an allowed Host only, and only with a valid token', () => {
    const grant = (host: string | undefined, token = TOKEN) => {
      const cookies: string[] = [];
      grantSessionCookie({ headers: { host } }, { append: (_n: string, v: string) => { cookies.push(v); } }, token, { port: 3847 });
      return cookies;
    };
    expect(grant('localhost:3847')).toEqual([sessionCookie(TOKEN)]);
    expect(grant('127.0.0.1:3847')).toEqual([sessionCookie(TOKEN)]);
    expect(grant('evil.example.com:3847')).toEqual([]);
    expect(grant(undefined)).toEqual([]);
    expect(grant('localhost:3847', '')).toEqual([]);
    // A broken response object never throws.
    expect(() => grantSessionCookie({ headers: { host: 'localhost:3847' } }, {}, TOKEN, { port: 3847 })).not.toThrow();
  });

  it('static headers: HTML files only', () => {
    const setHeaders = createSessionStaticHeaders(() => TOKEN, { port: 3847 });
    const serve = (filePath: string) => {
      const cookies: string[] = [];
      setHeaders({ req: { headers: { host: 'localhost:3847' } }, append: (_n: string, v: string) => { cookies.push(v); } }, filePath);
      return cookies;
    };
    expect(serve('C:\fibb\app\dist\index.html')).toEqual([sessionCookie(TOKEN)]);
    expect(serve('/srv/fibb/dashboard/dist/INDEX.HTM')).toEqual([sessionCookie(TOKEN)]);
    expect(serve('/srv/fibb/app/dist/assets/app.js')).toEqual([]);
    expect(serve('/srv/fibb/app/dist/assets/app.css')).toEqual([]);
    expect(serve('/srv/fibb/app/dist/html')).toEqual([]);
  });

  it('socket guard: the Host/Origin guard runs first, then the token', () => {
    const calls: string[] = [];
    const inner = (ok: boolean) => (_req: any, cb: any) => { calls.push('inner'); cb(null, ok); };
    const ask = (guard: any, headers: any) => {
      let out: boolean | undefined;
      guard({ headers }, (_e: any, ok: boolean) => { out = ok; });
      return out;
    };
    expect(ask(createSocketSessionGuard(() => TOKEN, inner(true)), { cookie: `fibb_session=${TOKEN}` })).toBe(true);
    expect(ask(createSocketSessionGuard(() => TOKEN, inner(true)), { 'x-fibb-token': TOKEN })).toBe(true);
    expect(ask(createSocketSessionGuard(() => TOKEN, inner(true)), {})).toBe(false);
    expect(ask(createSocketSessionGuard(() => TOKEN, inner(true)), { cookie: `fibb_session=${OTHER}` })).toBe(false);
    expect(ask(createSocketSessionGuard(() => TOKEN, inner(false)), { cookie: `fibb_session=${TOKEN}` })).toBe(false);
    expect(ask(createSocketSessionGuard(() => TOKEN), { cookie: `fibb_session=${TOKEN}` })).toBe(true);
    expect(calls).toHaveLength(5);
  });
});
