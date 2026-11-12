import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import AdmZip from 'adm-zip';
import { registerShelfRoutes } from './shelf.js';
import { ToolShelf } from '../../services/tool-shelf.js';
import { createRateLimiter } from '../../security/request-guard.js';

type Handler = (req: any, res: any) => any;

function harness(services: any) {
  const routes = new Map<string, Handler>();
  const reg = (m: string) => (path: string, h: Handler) => { routes.set(`${m} ${path}`, h); };
  const app: any = { get: reg('GET'), post: reg('POST'), patch: reg('PATCH'), delete: reg('DELETE') };
  registerShelfRoutes({ app, gateway: {}, services, baseDir: '' } as any);
  const call = async (key: string, opts: { params?: any; body?: any } = {}) => {
    const res: any = { code: 200, body: undefined, headers: {} as Record<string, string>, sent: undefined };
    res.status = (c: number) => { res.code = c; return res; };
    res.json = (b: any) => { res.body = b; return res; };
    res.setHeader = (k: string, v: string) => { res.headers[k.toLowerCase()] = v; return res; };
    res.send = (b: any) => { res.sent = b; return res; };
    await routes.get(key)!({ params: opts.params || {}, body: opts.body }, res);
    return res as { code: number; body: any; headers: Record<string, string>; sent: any };
  };
  return { call, routes };
}

const CODE = `(function () {
  var panel = document.createElement('div');
  panel.textContent = 'Words: ' + document.body.innerText.split(/\\s+/).length;
  panel.addEventListener('click', function () { panel.remove(); });
  document.body.appendChild(panel);
})();`;
const MARK = JSON.stringify({ name: 'Word counter', summary: 'Counts the words on the page.', files: [{ path: 'a.js', content: CODE }] });
const EXT_FILES = [
  { path: 'manifest.json', content: JSON.stringify({ manifest_version: 3, name: 'Calm', version: '1.0', content_scripts: [{ matches: ['https://www.example.com/*'], js: ['calm.js'] }] }) },
  { path: 'calm.js', content: 'document.body.classList.add("calm");' },
];
const EXT = JSON.stringify({ name: 'Calm "reading"; now', summary: 'Makes one site calmer.', files: EXT_FILES });

let dir: string;
let replies: string[];
let h: ReturnType<typeof harness>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fibb-shelf-routes-'));
  replies = [];
  const toolShelf = new ToolShelf(dir, { complete: async () => replies.shift() ?? 'nothing' });
  h = harness({ toolShelf });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const REQUEST = 'Count the words on the page I am reading.';

describe('shelf routes', () => {
  it('503 on every route when the service is missing', async () => {
    const bare = harness({});
    for (const key of bare.routes.keys()) {
      const r = await bare.call(key, { params: { id: 'x' }, body: { request: REQUEST } });
      expect(r.code, key).toBe(503);
      expect(r.body.error).toBeTruthy();
    }
    expect([...bare.routes.keys()].sort()).toEqual(['DELETE /api/shelf/:id', 'GET /api/shelf', 'GET /api/shelf/:id/download', 'POST /api/shelf']);
  });

  it('POST creates (201) and GET lists; the request text is never returned', async () => {
    expect((await h.call('GET /api/shelf')).body).toEqual({ tools: [] });
    replies = [MARK];
    const r = await h.call('POST /api/shelf', { body: { request: REQUEST, kind: 'bookmarklet' } });
    expect(r.code).toBe(201);
    expect(Object.keys(r.body)).toEqual(['tool']);
    expect(Object.keys(r.body.tool).sort()).toEqual(['access', 'code', 'createdAt', 'id', 'kind', 'name', 'summary', 'warnings']);
    expect(r.body.tool).toMatchObject({ name: 'Word counter', kind: 'bookmarklet', code: CODE });
    expect(r.body.tool.access.at(-1)).toBe('Sends nothing anywhere');
    const list = await h.call('GET /api/shelf');
    expect(list.code).toBe(200);
    expect(list.body).toEqual({ tools: [r.body.tool] });
    expect(JSON.stringify(list.body)).not.toContain(REQUEST);
  });

  it('POST without a kind guesses one', async () => {
    replies = [MARK];
    const r = await h.call('POST /api/shelf', { body: { request: REQUEST } });
    expect(r.code).toBe(201);
    expect(r.body.tool.kind).toBe('bookmarklet');
  });

  it('POST validates (400) with a plain error', async () => {
    for (const body of [undefined, {}, { request: 42 }, { request: '   ' }, { request: 'short' }, { request: REQUEST, kind: 'macro' }, { request: REQUEST, kind: 7 }]) {
      const r = await h.call('POST /api/shelf', { body });
      expect(r.code, JSON.stringify(body)).toBe(400);
      expect(typeof r.body.error).toBe('string');
    }
    expect((await h.call('GET /api/shelf')).body.tools).toEqual([]);
  });

  it('POST is a 400 with the plain reason when no safe version could be made', async () => {
    const bad = MARK.replace('document.body.appendChild(panel);', 'new Image().src = \\"/p\\";');
    replies = [bad, bad];
    const r = await h.call('POST /api/shelf', { body: { request: REQUEST, kind: 'bookmarklet' } });
    expect(r.code).toBe(400);
    expect(r.body).toEqual({ error: 'Fibb could not make a safe version of that. It kept trying to contact the internet.' });
    expect((await h.call('GET /api/shelf')).body.tools).toEqual([]);
  });

  it('DELETE removes (404 unknown)', async () => {
    replies = [MARK];
    const { body } = await h.call('POST /api/shelf', { body: { request: REQUEST } });
    expect((await h.call('DELETE /api/shelf/:id', { params: { id: 'nope' } })).code).toBe(404);
    const r = await h.call('DELETE /api/shelf/:id', { params: { id: body.tool.id } });
    expect(r.code).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect((await h.call('DELETE /api/shelf/:id', { params: { id: body.tool.id } })).code).toBe(404);
    expect((await h.call('GET /api/shelf')).body.tools).toEqual([]);
  });

  it('download: a zip attachment with a safe file name (404 unknown, 400 not an extension)', async () => {
    replies = [EXT, MARK];
    const ext = await h.call('POST /api/shelf', { body: { request: 'An extension that makes www.example.com calmer.', kind: 'extension' } });
    const mark = await h.call('POST /api/shelf', { body: { request: REQUEST, kind: 'bookmarklet' } });
    expect(ext.code).toBe(201);
    expect(ext.body.tool.files).toEqual(EXT_FILES.map(f => ({ path: f.path, size: f.content.length })));
    expect(ext.body.tool.code).toBeUndefined();

    expect((await h.call('GET /api/shelf/:id/download', { params: { id: 'nope' } })).code).toBe(404);
    const notExt = await h.call('GET /api/shelf/:id/download', { params: { id: mark.body.tool.id } });
    expect(notExt.code).toBe(400);
    expect(notExt.sent).toBeUndefined();

    const r = await h.call('GET /api/shelf/:id/download', { params: { id: ext.body.tool.id } });
    expect(r.code).toBe(200);
    expect(r.headers['content-type']).toBe('application/zip');
    expect(r.headers['content-disposition']).toBe('attachment; filename="calm-reading-now.zip"');
    expect(Buffer.isBuffer(r.sent)).toBe(true);
    expect(r.headers['content-length']).toBe(String(r.sent.length));
    const names = new AdmZip(r.sent).getEntries().filter(e => !e.isDirectory).map(e => e.entryName).sort();
    expect(names).toEqual(['calm-reading-now/calm.js', 'calm-reading-now/manifest.json']);
  });

  it('a failing service is a 500 with a fixed message', async () => {
    const boom = async () => { throw new Error('C:\\secret\\path exploded'); };
    const broken = harness({ toolShelf: { list: boom, create: boom, remove: boom, zip: boom } });
    for (const key of broken.routes.keys()) {
      const r = await broken.call(key, { params: { id: 'x' }, body: { request: REQUEST } });
      expect(r.code, key).toBe(500);
      expect(r.body).toEqual({ error: 'Fibb could not do that just now. Try again in a moment.' });
    }
  });

  it('the rate limiter allows 10 new tools a minute and leaves reads alone', () => {
    const limiter = createRateLimiter();
    const hit = (method: string, url: string) => {
      let passed = false;
      const res: any = { setHeader() {}, status() { return res; }, json() { return res; } };
      limiter({ method, originalUrl: url }, res, () => { passed = true; });
      return passed;
    };
    for (let i = 0; i < 10; i++) expect(hit('POST', '/api/shelf')).toBe(true);
    expect(hit('POST', '/api/shelf')).toBe(false);
    expect(hit('POST', '/api/shelf?x=1')).toBe(false);
    for (let i = 0; i < 30; i++) {
      expect(hit('GET', '/api/shelf')).toBe(true);
      expect(hit('DELETE', '/api/shelf/abc')).toBe(true);
      expect(hit('GET', '/api/shelf/abc/download')).toBe(true);
    }
  });
});
