import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import AdmZip from 'adm-zip';
import { registerShelfRoutes } from './shelf.js';
import { ToolShelf, SPRINT_TIMER_EXAMPLE, PAGE_CSP_META, hardenPage } from '../../services/tool-shelf.js';
import { createRateLimiter, evaluateRequest } from '../../security/request-guard.js';

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
    expect([...bare.routes.keys()].sort()).toEqual([
      'DELETE /api/shelf/:id', 'GET /api/shelf', 'GET /api/shelf/:id/download', 'GET /api/shelf/:id/page', 'GET /api/shelf/:id/page/download', 'POST /api/shelf',
    ]);
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

  describe('pages', () => {
    const PAGE = JSON.stringify({ name: 'Sprint "Timer" 25', summary: 'Counts down a writing sprint.', files: [{ path: 'x.html', content: SPRINT_TIMER_EXAMPLE }] });
    const CSP = "sandbox allow-scripts allow-downloads; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";
    const META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">`;
    const make = async () => {
      replies = [PAGE];
      const r = await h.call('POST /api/shelf', { body: { request: 'A writing sprint timer with a start button.', kind: 'page' } });
      expect(r.code).toBe(201);
      return r.body.tool;
    };

    it('POST makes a page whose code already carries the policy; a kind is guessed from "timer"', async () => {
      const tool = await make();
      expect(Object.keys(tool).sort()).toEqual(['access', 'code', 'createdAt', 'id', 'kind', 'name', 'summary', 'warnings']);
      expect(tool.kind).toBe('page');
      expect(tool.code).toBe(hardenPage(SPRINT_TIMER_EXAMPLE));
      expect(tool.code).toContain(`<head>${META}`);
      expect(tool.access).toEqual(['Runs only in its own tab', 'Can save its own notes in this browser', 'Sends nothing anywhere']);
      replies = [PAGE];
      const guessed = await h.call('POST /api/shelf', { body: { request: 'A writing sprint timer with a start button.' } });
      expect(guessed.body.tool.kind).toBe('page');
    });

    it('GET /page serves the hardened page with the sandbox policy', async () => {
      const tool = await make();
      const r = await h.call('GET /api/shelf/:id/page', { params: { id: tool.id } });
      expect(r.code).toBe(200);
      expect(r.headers).toEqual({
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': CSP,
        'x-frame-options': 'SAMEORIGIN',
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      });
      expect(typeof r.sent).toBe('string');
      expect(r.sent).toBe(hardenPage(SPRINT_TIMER_EXAMPLE));
      expect(r.sent.startsWith(`<!doctype html>\n<html lang="en">\n<head>${META}\n<meta charset="utf-8">`)).toBe(true);
      expect(r.sent.split('Content-Security-Policy')).toHaveLength(2);
      expect(PAGE_CSP_META).toBe(META);
    });

    it('GET /page/download sends the same page as an attachment named after the tool', async () => {
      const tool = await make();
      const open = await h.call('GET /api/shelf/:id/page', { params: { id: tool.id } });
      const r = await h.call('GET /api/shelf/:id/page/download', { params: { id: tool.id } });
      expect(r.code).toBe(200);
      expect(r.sent).toBe(open.sent);
      expect(r.sent).toContain(META);
      expect(r.headers['content-disposition']).toBe('attachment; filename="sprint-timer-25.html"');
      expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(r.headers['content-security-policy']).toBe(CSP);
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['cache-control']).toBe('no-store');
    });

    it('404 for an unknown id, 400 for a tool that is not a page, and the zip route stays for extensions', async () => {
      const tool = await make();
      replies = [MARK];
      const mark = await h.call('POST /api/shelf', { body: { request: REQUEST, kind: 'bookmarklet' } });
      for (const key of ['GET /api/shelf/:id/page', 'GET /api/shelf/:id/page/download']) {
        const unknown = await h.call(key, { params: { id: 'nope' } });
        expect(unknown.code, key).toBe(404);
        expect(unknown.sent).toBeUndefined();
        const notPage = await h.call(key, { params: { id: mark.body.tool.id } });
        expect(notPage.code, key).toBe(400);
        expect(notPage.body).toEqual({ error: 'Only pages can be opened this way' });
        expect(notPage.sent).toBeUndefined();
        expect(notPage.headers['content-security-policy']).toBeUndefined();
      }
      expect((await h.call('GET /api/shelf/:id/download', { params: { id: tool.id } })).code).toBe(400);
    });

    it('the request guard, unchanged, lets the app open or frame a page and refuses calls from the page itself', () => {
      const opts = { port: 3847 };
      const nav = { method: 'GET', path: '/api/shelf/abc/page', host: 'localhost:3847' };
      // A frame or a link inside the Fibb app, and the address typed by hand.
      expect(evaluateRequest({ ...nav, secFetchSite: 'same-origin', secFetchMode: 'navigate' }, opts).ok).toBe(true);
      expect(evaluateRequest({ ...nav, secFetchSite: 'none', secFetchMode: 'navigate' }, opts).ok).toBe(true);
      // Another site pulling the page in as a subresource.
      expect(evaluateRequest({ ...nav, secFetchSite: 'cross-site', secFetchMode: 'no-cors' }, opts).ok).toBe(false);
      // The sandboxed page has no origin of Fibb's: anything it sent would say "Origin: null".
      expect(evaluateRequest({ method: 'GET', path: '/api/shelf', host: 'localhost:3847', origin: 'null', secFetchSite: 'cross-site', secFetchMode: 'cors' }, opts).ok).toBe(false);
      expect(evaluateRequest({ method: 'POST', path: '/api/shelf', host: 'localhost:3847', origin: 'null', contentType: 'application/json' }, opts).ok).toBe(false);
    });

    it('a stored page that no longer passes the check is not served', async () => {
      const tool = await make();
      const file = join(dir, 'tools', 'shelf.json');
      const data = JSON.parse(readFileSync(file, 'utf-8'));
      data.tools[0].files[0].content = SPRINT_TIMER_EXAMPLE.replace('<main class="card">', '<main class="card"><img src="/api/vault">');
      writeFileSync(file, JSON.stringify(data));
      for (const key of ['GET /api/shelf/:id/page', 'GET /api/shelf/:id/page/download']) {
        const r = await h.call(key, { params: { id: tool.id } });
        expect(r.code, key).toBe(404);
        expect(r.sent).toBeUndefined();
      }
    });
  });

  it('a failing service is a 500 with a fixed message', async () => {
    const boom = async () => { throw new Error('C:\\secret\\path exploded'); };
    const broken = harness({ toolShelf: { list: boom, create: boom, remove: boom, zip: boom, page: boom } });
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
