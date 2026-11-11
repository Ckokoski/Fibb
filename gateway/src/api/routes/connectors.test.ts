import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { registerConnectorRoutes } from './connectors.js';
import { registerChatStreamRoutes } from './chat-stream.js';
import { ToolRegistry } from '../../services/tools/registry.js';
import { GoogleService } from '../../services/google.js';

type Handler = (req: any, res: any) => any;

function harness(services: any, gateway: any = {}) {
  const routes = new Map<string, Handler>();
  const reg = (m: string) => (path: string, h: Handler) => { routes.set(`${m} ${path}`, h); };
  const app: any = { get: reg('GET'), post: reg('POST'), patch: reg('PATCH'), delete: reg('DELETE') };
  registerConnectorRoutes({ app, gateway, services, baseDir: '' });
  registerChatStreamRoutes({ app, gateway, services, baseDir: '' });
  const call = async (key: string, opts: { body?: any; query?: any } = {}) => {
    const res: any = { code: 200, body: undefined, contentType: '', written: [] as string[], ended: false };
    res.status = (c: number) => { res.code = c; return res; };
    res.json = (b: any) => { res.body = b; res.contentType = 'json'; return res; };
    res.type = (t: string) => { res.contentType = t; return res; };
    res.send = (b: any) => { res.body = b; return res; };
    res.setHeader = () => res;
    res.flushHeaders = () => {};
    res.on = () => res;
    res.write = (s: string) => { res.written.push(s); return true; };
    res.end = () => { res.ended = true; };
    await routes.get(key)!({ params: {}, body: opts.body, query: opts.query || {} }, res);
    return res as { code: number; body: any; contentType: string; written: string[]; ended: boolean };
  };
  return { call, routes };
}

// In-memory fake vault: these tests never touch the real vault or /api/vault.
class FakeVault {
  store = new Map<string, string>();
  async get(k: string) { return this.store.has(k) ? this.store.get(k)! : null; }
  async set(k: string, v: string) { this.store.set(k, v); }
  async delete(k: string) { return this.store.delete(k); }
}

const CLIENT_ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';
const CLIENT_SECRET = 'FAKE-client-secret-for-tests-0001';
const REFRESH = 'fake-refresh-token-for-tests';
const ACCESS = 'fake-access-token-for-tests';

let dir: string;
let vault: FakeVault;
let google: GoogleService;
let browser: any;
let registry: ToolRegistry;
let h: ReturnType<typeof harness>;
let fetched: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fibb-connector-routes-'));
  vault = new FakeVault();
  google = new GoogleService({ vault, workspaceDir: dir, port: 3847 });
  await google.initialize();
  browser = {
    opened: [] as any[], closed: 0,
    status: () => ({ available: true, channel: 'msedge', running: false }),
    openForUser: async (url?: string) => {
      if (url && url.includes('127.0.0.1')) throw new Error('That address is on a private or local network, which Fibb is not allowed to open.');
      browser.opened.push(url);
    },
    close: async () => { browser.closed++; },
  };
  registry = new ToolRegistry();
  registry.register({ name: 'web_open', description: 'Open a page.', args: '{"url": "..."}', risk: 'read', available: () => true, run: async () => 'SECRET-RUN-OUTPUT' });
  registry.register({ name: 'gmail_draft', description: 'Save a draft.', args: '{}', risk: 'write', available: async () => false, run: async () => '' });
  h = harness({ toolRegistry: registry, browser, google });
  fetched = [];
  vi.stubGlobal('fetch', vi.fn(async (url: any) => {
    fetched.push(String(url));
    if (String(url).includes('/token')) return { ok: true, status: 200, json: async () => ({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 }) };
    if (String(url).includes('/userinfo')) return { ok: true, status: 200, json: async () => ({ email: 'author@example.com' }) };
    return { ok: true, status: 200, json: async () => ({}) };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });

describe('GET /api/tools', () => {
  it('lists name, description, risk and availability only', async () => {
    const r = await h.call('GET /api/tools');
    expect(r.body).toEqual({ tools: [
      { name: 'web_open', description: 'Open a page.', risk: 'read', available: true },
      { name: 'gmail_draft', description: 'Save a draft.', risk: 'write', available: false },
    ] });
  });
  it('is empty when tools are not wired', async () => {
    expect((await harness({}).call('GET /api/tools')).body).toEqual({ tools: [] });
  });
});

describe('browser routes', () => {
  it('status, open (with and without url), close', async () => {
    expect((await h.call('GET /api/browser/status')).body).toEqual({ available: true, channel: 'msedge', running: false });
    expect((await h.call('POST /api/browser/open', { body: {} })).body).toEqual({ ok: true });
    expect((await h.call('POST /api/browser/open', { body: { url: 'https://kdp.amazon.com/' } })).body).toEqual({ ok: true });
    expect(browser.opened).toEqual([undefined, 'https://kdp.amazon.com/']);
    expect((await h.call('POST /api/browser/close')).body).toEqual({ ok: true });
    expect(browser.closed).toBe(1);
  });
  it('open: the URL guard applies (400) and bad input is rejected', async () => {
    const r = await h.call('POST /api/browser/open', { body: { url: 'http://127.0.0.1:3847/' } });
    expect(r.code).toBe(400);
    expect(r.body.error).toMatch(/private or local/);
    expect((await h.call('POST /api/browser/open', { body: { url: 42 } })).code).toBe(400);
    expect(browser.opened).toEqual([]);
  });
  it('degrades when the browser service is missing', async () => {
    const bare = harness({});
    expect((await bare.call('GET /api/browser/status')).body).toMatchObject({ available: false, running: false });
    expect((await bare.call('POST /api/browser/open', { body: {} })).code).toBe(503);
    expect((await bare.call('POST /api/browser/close')).code).toBe(503);
  });
});

describe('google routes', () => {
  it('status -> client -> auth-url -> callback -> status -> disconnect', async () => {
    expect((await h.call('GET /api/google/status')).body).toEqual({ configured: false, connected: false });
    const notReady = await h.call('GET /api/google/auth-url');
    expect(notReady.code).toBe(400);

    const saved = await h.call('POST /api/google/client', { body: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } });
    expect(saved.code).toBe(200);
    expect(saved.body).toEqual({ ok: true }); // never echoed
    expect((await h.call('GET /api/google/status')).body).toEqual({ configured: true, connected: false });

    const auth = await h.call('GET /api/google/auth-url');
    expect(Object.keys(auth.body)).toEqual(['url']);
    const state = new URL(auth.body.url).searchParams.get('state')!;
    expect(auth.body.url).not.toContain(CLIENT_SECRET);

    const cb = await h.call('GET /api/google/callback', { query: { code: 'the-auth-code', state } });
    expect(cb.code).toBe(200);
    expect(cb.contentType).toBe('html');
    expect(cb.body).toMatch(/^<!doctype html>/);
    expect(cb.body).toContain('Google is connected');
    expect(cb.body).not.toMatch(/<script|src=|href=/); // self-contained
    for (const s of ['the-auth-code', state, REFRESH, ACCESS, CLIENT_SECRET]) expect(cb.body).not.toContain(s);
    expect(vault.store.get('google_refresh_token')).toBe(REFRESH);

    const status = await h.call('GET /api/google/status');
    expect(status.body).toEqual({ configured: true, connected: true, email: 'author@example.com' });
    for (const s of [REFRESH, ACCESS, CLIENT_SECRET]) expect(JSON.stringify(status.body)).not.toContain(s);

    expect((await h.call('POST /api/google/disconnect')).body).toEqual({ ok: true });
    expect(fetched.some(u => u === 'https://oauth2.googleapis.com/revoke')).toBe(true);
    expect((await h.call('GET /api/google/status')).body).toEqual({ configured: true, connected: false });
    expect((await h.call('POST /api/google/disconnect')).body).toEqual({ ok: true });
    expect((await h.call('GET /api/google/status')).body).toEqual({ configured: false, connected: false });
    expect(vault.store.size).toBe(0);
  });

  it('client: invalid shapes are 400 and nothing is stored or echoed', async () => {
    const r = await h.call('POST /api/google/client', { body: { clientId: 'nope', clientSecret: CLIENT_SECRET } });
    expect(r.code).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain(CLIENT_SECRET);
    expect((await h.call('POST /api/google/client', { body: {} })).code).toBe(400);
    expect((await h.call('POST /api/google/client', {})).code).toBe(400);
    expect(vault.store.size).toBe(0);
  });

  it('callback: a state mismatch is a plain failure that echoes nothing', async () => {
    await h.call('POST /api/google/client', { body: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } });
    await h.call('GET /api/google/auth-url');
    const r = await h.call('GET /api/google/callback', { query: { code: 'the-auth-code', state: 'forged-state-value' } });
    expect(r.code).toBe(400);
    expect(r.contentType).toBe('text/plain');
    expect(r.body).toMatch(/expired/);
    expect(r.body).not.toContain('the-auth-code');
    expect(r.body).not.toContain('forged-state-value');
    expect(fetched).toEqual([]);
    expect(vault.store.has('google_refresh_token')).toBe(false);

    const denied = await h.call('GET /api/google/callback', { query: { error: 'access_denied' } });
    expect(denied.code).toBe(400);
    expect(denied.contentType).toBe('text/plain');
  });

  it('degrades when the google service is missing', async () => {
    const bare = harness({});
    expect((await bare.call('GET /api/google/status')).body).toEqual({ configured: false, connected: false });
    expect((await bare.call('GET /api/google/auth-url')).code).toBe(503);
    expect((await bare.call('POST /api/google/client', { body: {} })).code).toBe(503);
    expect((await bare.call('POST /api/google/disconnect')).code).toBe(503);
    expect((await bare.call('GET /api/google/callback', { query: {} })).code).toBe(400);
  });
});

describe('POST /api/chat/stream tool events', () => {
  it('forwards onTool as SSE {"type":"tool",...} events between chunks', async () => {
    const gateway = {
      handleMessage: async (_m: string, _c: string, respond: any, _x: any, _t: any, _p: any, onChunk: any, onTool: any) => {
        onTool({ name: 'drive_search', status: 'start', summary: 'Searching your Drive…' });
        onTool({ name: 'drive_search', status: 'done', summary: 'Searching your Drive…' });
        onTool({ name: 'doc_create', status: 'needs-approval', summary: 'Waiting for your OK', extra: 'dropped' });
        onChunk('Hi');
        respond('Hi');
      },
    };
    const r = await harness({ facts: {} }, gateway).call('POST /api/chat/stream', { body: { message: 'find my outline' } });
    const events = r.written.map(w => JSON.parse(w.replace(/^data: /, '').trim()));
    expect(r.written.every(w => w.startsWith('data: ') && w.endsWith('\n\n'))).toBe(true);
    expect(events).toEqual([
      { type: 'tool', name: 'drive_search', status: 'start', summary: 'Searching your Drive…' },
      { type: 'tool', name: 'drive_search', status: 'done', summary: 'Searching your Drive…' },
      { type: 'tool', name: 'doc_create', status: 'needs-approval', summary: 'Waiting for your OK' },
      { type: 'chunk', content: 'Hi' },
      { type: 'done', content: 'Hi' },
    ]);
    expect(r.ended).toBe(true);
  });
});
