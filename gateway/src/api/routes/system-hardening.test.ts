/**
 * Review findings on system routes: /api/vault/load-from-files validates
 * fallbackKeyName and never returns paths or raw errors; the Telegram test and
 * connect routes survive a missing body and return fixed messages.
 * Uses an in-memory vault only. Nothing here touches the real vault.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { registerSystemRoutes } from './system.js';

type Handler = (req: any, res: any) => any;

function harness(services: any, gateway: any = {}) {
  const routes = new Map<string, Handler>();
  const reg = (m: string) => (path: string, h: Handler) => { routes.set(`${m} ${path}`, h); };
  const app: any = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), delete: reg('DELETE'), use: () => {} };
  registerSystemRoutes({ app, gateway, services, baseDir: join(tmpdir(), 'fibb-no-such-base') });
  const call = async (key: string, opts: { body?: any; noBody?: boolean } = {}) => {
    const res: any = { code: 200, body: undefined };
    res.status = (c: number) => { res.code = c; return res; };
    res.json = (b: any) => { res.body = b; return res; };
    const req: any = { params: {}, query: {} };
    if (!opts.noBody) req.body = opts.body;
    await routes.get(key)!(req, res);
    return res as { code: number; body: any };
  };
  return { call };
}

let dir: string;
let vault: Map<string, string>;
let services: any;
let savedEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fibb-keys-'));
  vault = new Map();
  services = {
    vault: {
      set: async (k: string, v: string) => { vault.set(k, v); },
      get: async (k: string) => vault.get(k),
      list: async () => [...vault.keys()],
    },
    audit: { log: async () => {} },
    aiRouter: { reinitialize: async () => {} },
    config: { get: (_k: string, d: any) => d, setAndPersist: async () => {} },
  };
  savedEnv = process.env.AUTHORCLAW_KEYS_DIR;
  process.env.AUTHORCLAW_KEYS_DIR = dir;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.AUTHORCLAW_KEYS_DIR; else process.env.AUTHORCLAW_KEYS_DIR = savedEnv;
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/vault/load-from-files', () => {
  it.each(['../../etc/passwd', 'a b', 'key.name', 'x/y', '', 42, { a: 1 }, 'ключ'])('refuses fallbackKeyName %j before reading anything', async (name) => {
    writeFileSync(join(dir, 'key.txt'), 'test-value-not-a-real-key');
    const r = await harness(services).call('POST /api/vault/load-from-files', { body: { fallbackKeyName: name } });
    expect(r.code).toBe(400);
    expect(vault.size).toBe(0);
  });

  it('accepts a well-formed fallbackKeyName, and a missing body', async () => {
    writeFileSync(join(dir, 'key.txt'), 'test-value-not-a-real-key');
    const named = await harness(services).call('POST /api/vault/load-from-files', { body: { fallbackKeyName: 'My_custom-key2' } });
    expect(named.code).toBe(200);
    expect(vault.get('My_custom-key2')).toBe('test-value-not-a-real-key');
    vault.clear();
    const bare = await harness(services).call('POST /api/vault/load-from-files', { noBody: true });
    expect(bare.code).toBe(200);
    expect(vault.get('gemini_api_key')).toBe('test-value-not-a-real-key');
  });

  it('errors[] holds file base names only: no absolute path, no raw error text', async () => {
    // Directories where files are expected make the reads fail.
    mkdirSync(join(dir, 'gemini_api_key.txt'));
    mkdirSync(join(dir, 'key.txt'));
    writeFileSync(join(dir, 'deepseek_api_key.txt'), 'test-value-not-a-real-key');
    const r = await harness(services).call('POST /api/vault/load-from-files', { body: {} });
    expect(r.code).toBe(200);
    expect(r.body.errors).toEqual(['gemini_api_key.txt', 'key.txt']);
    expect(r.body.loaded).toEqual(['deepseek_api_key']);
    const text = JSON.stringify(r.body);
    expect(text).not.toContain(dir);
    expect(text).not.toContain(dir.replace(/\\/g, '\\\\'));
    expect(text).not.toMatch(/EISDIR|Error:|illegal operation/i);
  });
});

describe('Telegram test and connect routes', () => {
  it('test: a missing body does not crash', async () => {
    const r = await harness(services).call('POST /api/telegram/test', { noBody: true });
    expect(r.code).toBe(400);
    expect(r.body).toEqual({ error: 'No token provided or stored' });
  });

  it('test: a network failure returns a fixed message, not the error text', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('getaddrinfo ENOTFOUND api.telegram.org at C:\\Users\\someone'); });
    const r = await harness(services).call('POST /api/telegram/test', { body: { token: '123:test-token' } });
    expect(r.code).toBe(500);
    expect(r.body).toEqual({ error: 'Could not reach Telegram to test the token.' });
  });

  it('test: a rejected token returns a fixed message, not Telegram\'s description', async () => {
    vi.stubGlobal('fetch', async () => ({ json: async () => ({ ok: false, description: 'Unauthorized <raw upstream text>' }) }));
    const r = await harness(services).call('POST /api/telegram/test', { body: { token: '123:test-token' } });
    expect(r.code).toBe(400);
    expect(r.body).toEqual({ error: 'Telegram did not accept that token.' });
  });

  it('test: a good token still reports the bot', async () => {
    vi.stubGlobal('fetch', async () => ({ json: async () => ({ ok: true, result: { username: 'fibb_bot', first_name: 'Fibb' } }) }));
    const r = await harness(services).call('POST /api/telegram/test', { body: { token: '123:test-token' } });
    expect(r.body).toEqual({ success: true, bot: { username: 'fibb_bot', name: 'Fibb' } });
  });

  it('connect: a missing body does not crash and saves nothing', async () => {
    const gateway = { connectTelegram: async () => ({ error: 'No telegram_bot_token in vault. Save your bot token first.' }) };
    const r = await harness(services, gateway).call('POST /api/telegram/connect', { noBody: true });
    expect(r.code).toBe(400);
    expect(r.body).toEqual({ error: 'No Telegram bot token saved yet. Add your bot token first.' });
    expect(vault.size).toBe(0);
  });

  it('connect: failures return fixed short messages, never the raw error', async () => {
    const leaky = { connectTelegram: async () => ({ error: 'TypeError: fetch failed at C:\\Users\\someone\\gateway\\src\\bridges\\telegram.ts:76' }) };
    const soft = await harness(services, leaky).call('POST /api/telegram/connect', { body: {} });
    expect(soft.code).toBe(400);
    expect(soft.body).toEqual({ error: 'Could not connect Telegram. Check the bot token and try again.' });

    const throwing = { connectTelegram: async () => { throw new Error('ECONNRESET secret detail'); } };
    const hard = await harness(services, throwing).call('POST /api/telegram/connect', { body: {} });
    expect(hard.code).toBe(500);
    expect(hard.body).toEqual({ error: 'Could not connect Telegram. Check the bot token and try again.' });
  });
});
