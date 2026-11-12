import { describe, it, expect } from 'vitest';
import {
  evaluateRequest, allowedHosts, allowedOrigins, isAllowedOrigin, guardOptionsFromEnv,
  createRequestGuard, createSocketGuard, createRateLimiter, UPLOAD_PATHS, type GuardRequest, type GuardOptions,
} from './request-guard.js';

const opts: GuardOptions = { port: 3847 };
const base: GuardRequest = { method: 'GET', path: '/api/status', host: 'localhost:3847' };
const check = (over: Partial<GuardRequest>, o: GuardOptions = opts) => evaluateRequest({ ...base, ...over }, o);
const code = (over: Partial<GuardRequest>, o: GuardOptions = opts) => {
  const d = check(over, o);
  return d.ok ? 'ok' : d.code;
};

describe('evaluateRequest: Host allowlist (DNS rebinding)', () => {
  it.each(['localhost:3847', '127.0.0.1:3847', '[::1]:3847', 'LOCALHOST:3847'])('allows %s', (host) => {
    expect(code({ host })).toBe('ok');
  });
  it.each([
    'evil.example.com', 'evil.example.com:3847', 'localhost', 'localhost:9999', '127.0.0.1', '0.0.0.0:3847',
    'localhost.evil.com:3847', '192.168.1.20:3847', '', undefined,
  ])('refuses %s', (host) => {
    expect(code({ host: host as any })).toBe('bad_host');
  });
  it('follows the configured port (read lazily) and accepts explicit extra hosts', () => {
    let port = 4000;
    const o: GuardOptions = { port: () => port, extraHosts: ['Fibb.lan:4000'] };
    expect(code({ host: 'localhost:4000' }, o)).toBe('ok');
    expect(code({ host: 'localhost:3847' }, o)).toBe('bad_host');
    expect(code({ host: 'fibb.lan:4000' }, o)).toBe('ok');
    port = 3847;
    expect(code({ host: 'localhost:3847' }, o)).toBe('ok');
    expect(allowedHosts({ port: 80 })).toContain('localhost');
  });
  it('a refused host is a 403', () => {
    expect(check({ host: 'evil.example.com' })).toMatchObject({ ok: false, status: 403 });
  });
});

describe('evaluateRequest: state-changing requests', () => {
  const post = (over: Partial<GuardRequest>) => code({ method: 'POST', path: '/api/approvals/x/approve', contentType: 'application/json', ...over });

  it('allows the same-origin app (Origin matches, either loopback name)', () => {
    expect(post({ origin: 'http://localhost:3847', secFetchSite: 'same-origin' })).toBe('ok');
    expect(post({ host: '127.0.0.1:3847', origin: 'http://127.0.0.1:3847' })).toBe('ok');
  });
  it('refuses other origins, "null", https look-alikes and other ports', () => {
    for (const origin of [
      'https://evil.example.com', 'null', 'http://localhost:9999', 'https://localhost:3847',
      'http://localhost:3847.evil.com', 'http://evil.example.com:3847', 'file://',
    ]) {
      expect(post({ origin })).toBe('cross_origin');
    }
    // A matching Sec-Fetch-Site does not rescue a foreign Origin.
    expect(post({ origin: 'https://evil.example.com', secFetchSite: 'same-origin' })).toBe('cross_origin');
  });
  it('with no Origin, trusts Sec-Fetch-Site same-origin/none and refuses cross-site/same-site', () => {
    expect(post({ secFetchSite: 'same-origin' })).toBe('ok');
    expect(post({ secFetchSite: 'none' })).toBe('ok');
    expect(post({ secFetchSite: 'cross-site' })).toBe('cross_site');
    expect(post({ secFetchSite: 'same-site' })).toBe('cross_site');
  });
  it('allows non-browser clients (no Origin, no Sec-Fetch-Site): curl, the Telegram bridge', () => {
    expect(post({})).toBe('ok');
    // Node's fetch sends Sec-Fetch-Mode but never Sec-Fetch-Site.
    expect(post({ secFetchMode: 'cors' })).toBe('ok');
    expect(code({ method: 'DELETE', path: '/api/workspace/clean' })).toBe('ok');
    expect(code({ method: 'POST', path: '/api/projects/p1/pause' })).toBe('ok');
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post'])('%s is state-changing', (method) => {
    expect(code({ method, origin: 'https://evil.example.com' })).toBe('cross_origin');
    expect(code({ method, secFetchSite: 'cross-site' })).toBe('cross_site');
  });

  it('refuses CORS-simple content types (the form-post CSRF vector)', () => {
    for (const contentType of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'TEXT/PLAIN']) {
      const d = check({ method: 'POST', path: '/api/approvals/x/approve', contentType, origin: 'http://localhost:3847' });
      expect(d).toMatchObject({ ok: false, status: 415, code: 'bad_content_type' });
    }
    expect(post({ contentType: 'application/json; charset=utf-8' })).toBe('ok');
    // A body-less POST (no Content-Type) is fine: the app sends several.
    expect(post({ contentType: undefined, origin: 'http://localhost:3847' })).toBe('ok');
  });
  it('lets multipart through on the upload routes only, still Origin-checked', () => {
    const multipart = 'multipart/form-data; boundary=----x';
    for (const path of ['/api/audio/transcribe', '/api/documents/upload', '/api/projects/abc-1/upload', '/api/track-changes/parse']) {
      expect(UPLOAD_PATHS.some(re => re.test(path))).toBe(true);
      expect(code({ method: 'POST', path, contentType: multipart, origin: 'http://localhost:3847' })).toBe('ok');
      expect(code({ method: 'POST', path, contentType: multipart, origin: 'https://evil.example.com' })).toBe('cross_origin');
      expect(code({ method: 'POST', path, contentType: multipart, secFetchSite: 'cross-site' })).toBe('cross_site');
      expect(code({ method: 'POST', path, contentType: 'text/plain', origin: 'http://localhost:3847' })).toBe('bad_content_type');
    }
    expect(code({ method: 'POST', path: '/api/projects/a/b/upload', contentType: multipart })).toBe('bad_content_type');
    expect(code({ method: 'POST', path: '/api/vault', contentType: multipart })).toBe('bad_content_type');
  });
});

describe('evaluateRequest: reads', () => {
  it('allows the app, plain navigation and non-browser clients', () => {
    expect(code({})).toBe('ok');
    expect(code({ secFetchSite: 'same-origin', secFetchMode: 'cors' })).toBe('ok');
    expect(code({ secFetchSite: 'none', secFetchMode: 'navigate' })).toBe('ok');
  });
  it('keeps the Google OAuth callback working (cross-site top-level navigation)', () => {
    expect(code({ path: '/api/google/callback', host: '127.0.0.1:3847', secFetchSite: 'cross-site', secFetchMode: 'navigate' })).toBe('ok');
  });
  it('refuses another site reading or embedding the API', () => {
    expect(code({ path: '/api/vault/keys', origin: 'https://evil.example.com', secFetchSite: 'cross-site', secFetchMode: 'cors' })).toBe('cross_origin');
    expect(code({ path: '/api/vault/keys', secFetchSite: 'cross-site', secFetchMode: 'no-cors' })).toBe('cross_site');
    expect(code({ path: '/api/google/auth-url', secFetchSite: 'same-site', secFetchMode: 'no-cors' })).toBe('cross_site');
    expect(code({ method: 'OPTIONS', origin: 'https://evil.example.com' })).toBe('cross_origin');
  });
});

describe('origins and environment', () => {
  it('allowedOrigins are the loopback names on the port, never a wildcard', () => {
    expect(allowedOrigins(opts)).toEqual(['http://localhost:3847', 'http://127.0.0.1:3847', 'http://[::1]:3847']);
    expect(isAllowedOrigin('*', opts)).toBe(false);
    expect(isAllowedOrigin(undefined, opts)).toBe(false);
  });
  it('the Vite dev origin is allowed only in development or when configured', () => {
    const prod = guardOptionsFromEnv(3847, {}, []);
    expect(isAllowedOrigin('http://localhost:5173', prod)).toBe(false);
    expect(evaluateRequest({ method: 'POST', path: '/api/chat', host: 'localhost:3847', origin: 'http://localhost:5173' }, prod).ok).toBe(false);
    for (const dev of [guardOptionsFromEnv(3847, { NODE_ENV: 'development' }, []), guardOptionsFromEnv(3847, { FIBB_DEV: '1' }, []), guardOptionsFromEnv(3847, {}, ['--watch'])]) {
      // Vite proxies with changeOrigin: Host is the gateway, Origin is the dev server.
      expect(evaluateRequest({ method: 'POST', path: '/api/chat', host: 'localhost:3847', origin: 'http://localhost:5173', secFetchSite: 'same-origin' }, dev).ok).toBe(true);
    }
    const custom = guardOptionsFromEnv(3847, { FIBB_ALLOWED_ORIGINS: 'http://localhost:4321/, http://other:1', FIBB_ALLOWED_HOSTS: 'fibb.lan:3847' }, []);
    expect(isAllowedOrigin('http://localhost:4321', custom)).toBe(true);
    expect(allowedHosts(custom)).toContain('fibb.lan:3847');
    expect(isAllowedOrigin('http://fibb.lan:3847', custom)).toBe(true);
  });
});

// ── Handler tests (stub req/res, as in api/routes/tasks.test.ts) ──
function run(mw: (req: any, res: any, next: () => void) => void, req: any) {
  const res: any = { code: 200, body: undefined, headers: {} as Record<string, string> };
  res.status = (c: number) => { res.code = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  let passed = false;
  mw(req, res, () => { passed = true; });
  return { res, passed };
}
const req = (method: string, url: string, headers: Record<string, string> = {}) =>
  ({ method, originalUrl: url, url, headers: { host: 'localhost:3847', ...headers } });

describe('createRequestGuard middleware', () => {
  const audits: any[] = [];
  const guard = createRequestGuard(opts, (category, action, data) => { audits.push({ category, action, data }); });

  it('passes the same-origin app and non-API paths', () => {
    expect(run(guard, req('POST', '/api/chat/stream', { origin: 'http://localhost:3847', 'content-type': 'application/json' })).passed).toBe(true);
    expect(run(guard, req('GET', '/api/tasks')).passed).toBe(true);
    // Static files are not guarded (a rebinding page gains nothing from them).
    expect(run(guard, req('GET', '/assets/index.js', { host: 'evil.example.com' })).passed).toBe(true);
    expect(run(guard, req('GET', '/apidocs', { host: 'evil.example.com' })).passed).toBe(true);
  });

  it('a hostile page cannot approve, read key names, queue a task, start Google or open the browser', () => {
    const evil = { origin: 'https://evil.example.com', 'sec-fetch-site': 'cross-site' };
    const attempts: Array<[string, string, Record<string, string>]> = [
      ['POST', '/api/approvals/conf-1/approve', { ...evil, 'content-type': 'text/plain' }],
      ['POST', '/api/approvals/conf-1/approve', evil],
      ['GET', '/api/vault/keys', evil],
      ['POST', '/api/tasks', { ...evil, 'content-type': 'application/json' }],
      ['GET', '/api/google/auth-url', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' }],
      ['POST', '/api/browser/open', { ...evil, 'content-type': 'application/x-www-form-urlencoded' }],
      ['POST', '/api/vault', { 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }],
      // DNS rebinding: "same-origin" from the browser's point of view, wrong Host.
      ['POST', '/api/approvals/conf-1/approve', { host: 'rebind.evil.example.com:3847', origin: 'http://rebind.evil.example.com:3847', 'sec-fetch-site': 'same-origin' }],
      ['GET', '/api/vault/keys', { host: 'rebind.evil.example.com:3847' }],
    ];
    for (const [method, url, headers] of attempts) {
      const out = run(guard, req(method, url, headers));
      expect(out.passed, `${method} ${url}`).toBe(false);
      expect([403, 415]).toContain(out.res.code);
      expect(typeof out.res.body.error).toBe('string');
    }
  });

  it('audits a refusal with the reason, without the query string', () => {
    audits.length = 0;
    const out = run(guard, req('GET', '/api/google/callback?code=4/secret-code&state=abc', { host: 'evil.example.com' }));
    expect(out.res.code).toBe(403);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ category: 'security', action: 'request_blocked', data: { reason: 'bad_host', path: '/api/google/callback' } });
    expect(JSON.stringify(audits)).not.toContain('secret-code');
  });

  it('a throwing audit logger never turns a refusal into a pass', () => {
    const g = createRequestGuard(opts, () => { throw new Error('disk full'); });
    const out = run(g, req('POST', '/api/tasks', { origin: 'https://evil.example.com' }));
    expect(out.passed).toBe(false);
    expect(out.res.code).toBe(403);
  });
});

describe('createSocketGuard', () => {
  const allow = (headers: Record<string, string>) => {
    let ok: boolean | undefined;
    createSocketGuard(opts)({ method: 'GET', url: '/socket.io/?EIO=4&transport=websocket', headers }, (_e, success) => { ok = success; });
    return ok;
  };
  it('accepts the app and refuses foreign origins and rebinding hosts', () => {
    expect(allow({ host: 'localhost:3847', origin: 'http://localhost:3847' })).toBe(true);
    expect(allow({ host: 'localhost:3847', 'sec-fetch-site': 'same-origin' })).toBe(true);
    expect(allow({ host: 'localhost:3847' })).toBe(true);
    expect(allow({ host: 'localhost:3847', origin: 'https://evil.example.com' })).toBe(false);
    expect(allow({ host: 'localhost:3847', 'sec-fetch-site': 'cross-site' })).toBe(false);
    expect(allow({ host: 'evil.example.com:3847', origin: 'http://evil.example.com:3847' })).toBe(false);
  });
});

describe('createRateLimiter', () => {
  it('limits a sensitive route per window and recovers afterwards', () => {
    let t = 1_000_000;
    const limiter = createRateLimiter([{ name: 'approvals', max: 3, windowMs: 1000, match: (m, p) => m === 'POST' && p.startsWith('/api/approvals/') }], () => t);
    const hit = () => run(limiter, req('POST', '/api/approvals/x/approve'));
    expect(hit().passed).toBe(true);
    expect(hit().passed).toBe(true);
    expect(hit().passed).toBe(true);
    const blocked = hit();
    expect(blocked.passed).toBe(false);
    expect(blocked.res.code).toBe(429);
    expect(blocked.res.headers['Retry-After']).toBe('1');
    // Other routes are not counted.
    expect(run(limiter, req('GET', '/api/approvals')).passed).toBe(true);
    expect(run(limiter, req('POST', '/api/tasks')).passed).toBe(true);
    t += 1000;
    expect(hit().passed).toBe(true);
  });
  it('the default rules cover vault writes, approvals, the Google client and chat', () => {
    const limiter = createRateLimiter();
    const until429 = (method: string, url: string) => {
      for (let i = 1; i <= 200; i++) if (!run(limiter, req(method, url)).passed) return i;
      return -1;
    };
    expect(until429('POST', '/api/vault')).toBeGreaterThan(10);
    expect(until429('POST', '/api/approvals/x/approve')).toBeGreaterThan(10);
    expect(until429('POST', '/api/google/client')).toBeGreaterThan(5);
    expect(until429('POST', '/api/chat/stream?x=1')).toBeGreaterThan(10);
    expect(until429('GET', '/api/vault/keys')).toBe(-1);
    expect(until429('GET', '/api/tasks')).toBe(-1);
  });
});
