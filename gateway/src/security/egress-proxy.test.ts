/**
 * The egress proxy against real loopback sockets. Hostnames here do not exist
 * in DNS: `allow` maps them to 127.0.0.1 (the test upstream), which also
 * proves the proxy connects to the address it was given, never to the name.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import net from 'net';
import type { AddressInfo } from 'net';
import { EgressProxy, parseAuthority } from './egress-proxy.js';

let upstream: http.Server;
let upstreamPort = 0;
let echo: net.Server;
let echoPort = 0;
let proxy: EgressProxy;
let proxyPort = 0;
let hits: string[] = [];
let asked: string[] = [];
let blocked: string[] = [];

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.headers.host} ${req.url}`);
    if (req.url === '/redirect-to-internal') {
      res.writeHead(302, { Location: `http://internal.test:${upstreamPort}/secret` });
      return res.end();
    }
    if (req.url === '/redirect-to-loopback') {
      res.writeHead(302, { Location: `http://127.0.0.1:${upstreamPort}/secret` });
      return res.end();
    }
    if (req.url === '/redirect-ok') {
      res.writeHead(302, { Location: `http://public.test:${upstreamPort}/page` });
      return res.end();
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(`got:${body}`); });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Seen-Proxy-Header': String(req.headers['proxy-connection'] ?? 'none') });
    res.end(req.url === '/secret' ? 'TOP SECRET' : 'public page');
  });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = (upstream.address() as AddressInfo).port;

  echo = net.createServer((s) => { s.on('data', d => s.write(Buffer.concat([Buffer.from('echo:'), d]))); s.on('error', () => {}); });
  await new Promise<void>(r => echo.listen(0, '127.0.0.1', r));
  echoPort = (echo.address() as AddressInfo).port;

  proxy = new EgressProxy({
    allow: async (hostname) => { asked.push(hostname); return hostname === 'public.test' ? '127.0.0.1' : null; },
    onBlocked: (hostname) => { blocked.push(hostname); },
    connectTimeoutMs: 2000,
  });
  proxyPort = Number(new URL(await proxy.start()).port);
});
afterAll(async () => {
  await proxy.stop();
  await new Promise(r => upstream.close(r));
  await new Promise(r => echo.close(r));
});
beforeEach(() => { hits = []; asked = []; blocked = []; });

/** One plain-http request through the proxy (absolute URL in the request line). */
function viaProxy(url: string, opts: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: proxyPort, method: opts.method || 'GET', path: url,
      headers: { Host: new URL(url, 'http://x').host, 'Proxy-Connection': 'keep-alive', ...opts.headers }, agent: false,
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

/** Follow redirects the way a browser does: every hop is a new request through the proxy. */
async function browse(url: string) {
  const chain: number[] = [];
  let current = url;
  for (let i = 0; i < 5; i++) {
    const r = await viaProxy(current);
    chain.push(r.status);
    if (r.status >= 300 && r.status < 400 && r.headers.location) { current = String(r.headers.location); continue; }
    return { chain, final: r };
  }
  throw new Error('too many redirects');
}

/** CONNECT through the proxy; resolves with the status line and the tunnel socket. */
function connect(authority: string): Promise<{ status: number; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    socket.once('data', (d) => resolve({ status: Number(String(d).split(' ')[1]), socket }));
    socket.once('error', reject);
  });
}

describe('EgressProxy: plain http', () => {
  it('forwards an allowed request to the pinned address with the original Host', async () => {
    const r = await viaProxy(`http://public.test:${upstreamPort}/page?q=1`);
    expect(r.status).toBe(200);
    expect(r.body).toBe('public page');
    expect(hits).toEqual([`GET public.test:${upstreamPort} /page?q=1`]);
    expect(asked).toEqual(['public.test']);
    expect(r.headers['x-seen-proxy-header']).toBe('none'); // hop-by-hop headers are not forwarded
    const post = await viaProxy(`http://public.test:${upstreamPort}/submit`, { method: 'POST', body: 'hello' });
    expect(post.body).toBe('got:hello');
  });

  it('refuses loopback, private names and anything allow() rejects, without touching the upstream', async () => {
    for (const url of [
      `http://127.0.0.1:${upstreamPort}/secret`, `http://localhost:${upstreamPort}/secret`, `http://[::1]:${upstreamPort}/secret`,
      `http://internal.test:${upstreamPort}/secret`, 'http://169.254.169.254/latest/meta-data/',
    ]) {
      const r = await viaProxy(url);
      expect(r.status, url).toBe(403);
      expect(r.body).toBe('');
    }
    expect(hits).toEqual([]);
    expect(blocked).toEqual(['127.0.0.1', 'localhost', '::1', 'internal.test', '169.254.169.254']);
  });

  it('checks EVERY redirect hop: a public page cannot bounce the browser to an internal address', async () => {
    const internal = await browse(`http://public.test:${upstreamPort}/redirect-to-internal`);
    expect(internal.chain).toEqual([302, 403]);
    expect(internal.final.body).not.toContain('TOP SECRET');
    const loopback = await browse(`http://public.test:${upstreamPort}/redirect-to-loopback`);
    expect(loopback.chain).toEqual([302, 403]);
    expect(hits.some(h => h.includes('/secret'))).toBe(false);
    // An allowed redirect still works.
    const ok = await browse(`http://public.test:${upstreamPort}/redirect-ok`);
    expect(ok.chain).toEqual([302, 200]);
    expect(ok.final.body).toBe('public page');
  });

  it('asks allow() again for every connection (no stale answers), and survives allow() throwing', async () => {
    let n = 0;
    const flaky = new EgressProxy({ allow: async () => { n++; if (n === 2) throw new Error('dns down'); return n === 1 ? '127.0.0.1' : null; } });
    const port = Number(new URL(await flaky.start()).port);
    const get = (url: string) => new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: url, agent: false }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode || 0)); });
      req.on('error', reject);
      req.end();
    });
    try {
      // Same name three times: allowed, then DNS fails, then it resolves somewhere private (rebinding).
      expect(await get(`http://rebind.test:${upstreamPort}/page`)).toBe(200);
      expect(await get(`http://rebind.test:${upstreamPort}/page`)).toBe(403);
      expect(await get(`http://rebind.test:${upstreamPort}/page`)).toBe(403);
      expect(n).toBe(3);
    } finally {
      await flaky.stop();
    }
  });

  it('is not an open door: direct (non-proxy) requests and credentials in URLs are refused', async () => {
    expect((await viaProxy('/api/vault/keys')).status).toBe(400);
    expect((await viaProxy('https://public.test/')).status).toBe(400);
    expect((await viaProxy(`http://user:pw@public.test:${upstreamPort}/page`)).status).toBe(403);
    expect(hits).toEqual([]);
  });

  it('an unreachable upstream is a 502, not a hang or a crash', async () => {
    const dead = net.createServer();
    await new Promise<void>(r => dead.listen(0, '127.0.0.1', r));
    const port = (dead.address() as AddressInfo).port;
    await new Promise(r => dead.close(r));
    expect((await viaProxy(`http://public.test:${port}/`)).status).toBe(502);
  });
});

describe('EgressProxy: CONNECT tunnels (https, WebSockets)', () => {
  it('tunnels to an allowed host at the pinned address', async () => {
    const { status, socket } = await connect(`public.test:${echoPort}`);
    expect(status).toBe(200);
    const reply = await new Promise<string>(r => { socket.once('data', d => r(String(d))); socket.write('ping'); });
    expect(reply).toBe('echo:ping');
    socket.destroy();
    expect(asked).toEqual(['public.test']);
  });

  it('refuses tunnels to loopback, private and unknown hosts', async () => {
    for (const authority of [`127.0.0.1:${echoPort}`, `localhost:${echoPort}`, `[::1]:${echoPort}`, `internal.test:${echoPort}`, '169.254.169.254:80']) {
      const { status, socket } = await connect(authority);
      expect(status, authority).toBe(403);
      socket.destroy();
    }
    for (const bad of ['not a host', 'public.test:99999', 'user@public.test:443']) {
      const { status, socket } = await connect(bad.replace(/ /g, '%20'));
      expect([400, 403]).toContain(status);
      socket.destroy();
    }
  });
});

describe('EgressProxy lifecycle', () => {
  it('listens on loopback only, restarts cleanly, and stop() ends open tunnels', async () => {
    const p = new EgressProxy({ allow: async () => '127.0.0.1' });
    const url = await p.start();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await p.start()).toBe(url);
    const socket = net.connect(Number(new URL(url).port), '127.0.0.1');
    await new Promise<void>(r => socket.once('connect', () => r()));
    socket.write(`CONNECT public.test:${echoPort} HTTP/1.1\r\n\r\n`);
    await new Promise<void>(r => socket.once('data', () => r()));
    const closed = new Promise<void>(r => socket.once('close', () => r()));
    await p.stop();
    await closed;
    expect(() => p.url()).toThrow(/not running/);
    const again = await p.start();
    expect(again).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await p.stop();
  });

  it('parseAuthority', () => {
    expect(parseAuthority('example.com:443', 443)).toEqual({ host: 'example.com', port: 443 });
    expect(parseAuthority('Example.COM', 443)).toEqual({ host: 'example.com', port: 443 });
    expect(parseAuthority('[2606:2800::1]:8443', 443)).toEqual({ host: '2606:2800::1', port: 8443 });
    for (const bad of ['', 'a b:1', 'x:0', 'x:70000', 'user@host:1', 'http://x', 'host/path:1']) expect(parseAuthority(bad, 443)).toBeNull();
  });
});
