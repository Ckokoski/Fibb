/**
 * Egress proxy for Fibb's browser: a tiny forward proxy on 127.0.0.1 that
 * every browser connection goes through.
 *
 * Why: a URL check before navigation cannot see what the browser does next.
 * Redirect hops, subresources, service workers, WebSockets and DNS answers
 * that change between the check and the connect (DNS rebinding) all bypass
 * it. Here the decision and the connection are the same step: the proxy asks
 * `allow(hostname)` for an address, and connects to exactly that address
 * (never to the name), for every single connection the browser makes.
 *
 *  - CONNECT host:port  -> tunnel to the pinned address (https, wss, ws)
 *  - GET http://host/.. -> forwarded to the pinned address (plain http)
 *  - anything `allow` refuses -> 403, nothing is sent upstream
 *
 * It only accepts proxy-style requests, so a web page that reaches the port
 * directly (GET /path) gets a 400 and cannot use it to reach anything.
 */
import http from 'http';
import net from 'net';
import type { AddressInfo } from 'net';
import type { Duplex } from 'stream';

/** Returns the IP address to connect to for a hostname, or null to refuse. */
export type AllowFn = (hostname: string) => Promise<string | null>;

export interface EgressProxyOptions {
  allow: AllowFn;
  /** Called for every refused destination (hostname only). */
  onBlocked?: (hostname: string) => void;
  connectTimeoutMs?: number;
}

const HOP_BY_HOP = new Set([
  'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'connection', 'keep-alive',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/** Split "host:port" / "[v6]:port". Returns null when malformed. */
export function parseAuthority(authority: string, defaultPort: number): { host: string; port: number } | null {
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([^:\s/\\@]+))(?::(\d{1,5}))?$/.exec(String(authority || '').trim());
  if (!m) return null;
  const host = (m[1] ?? m[2] ?? '').toLowerCase();
  const port = m[3] === undefined ? defaultPort : Number(m[3]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

export class EgressProxy {
  private server: http.Server | null = null;
  private sockets = new Set<Duplex>();
  private allow: AllowFn;
  private onBlocked?: (hostname: string) => void;
  private connectTimeoutMs: number;

  constructor(opts: EgressProxyOptions) {
    this.allow = opts.allow;
    this.onBlocked = opts.onBlocked;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 15_000;
  }

  /** Start listening on a free loopback port. Returns the proxy URL. */
  async start(): Promise<string> {
    if (this.server) return this.url();
    const server = http.createServer((req, res) => { void this.onRequest(req, res); });
    server.on('connect', (req, socket, head) => { void this.onConnect(req, socket, head); });
    server.on('connection', (s) => this.track(s));
    server.on('clientError', (_err, socket) => { try { socket.destroy(); } catch { /* gone */ } });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    server.unref();
    this.server = server;
    return this.url();
  }

  url(): string {
    const addr = this.server?.address() as AddressInfo | null;
    if (!addr) throw new Error('The egress proxy is not running.');
    return `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const s of this.sockets) { try { s.destroy(); } catch { /* gone */ } }
    this.sockets.clear();
    if (server) await new Promise<void>(r => server.close(() => r()));
  }

  private track(s: Duplex): void {
    this.sockets.add(s);
    s.once('close', () => this.sockets.delete(s));
  }

  private async pin(hostname: string): Promise<string | null> {
    let ip: string | null = null;
    try { ip = await this.allow(hostname); } catch { ip = null; }
    if (!ip || !net.isIP(ip)) {
      try { this.onBlocked?.(hostname); } catch { /* reporting must not break the refusal */ }
      return null;
    }
    return ip;
  }

  private async onConnect(req: http.IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    const refuse = (status: string) => {
      try { client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); } catch { /* gone */ }
    };
    client.on('error', () => { /* browser went away */ });
    const target = parseAuthority(req.url || '', 443);
    if (!target) return refuse('400 Bad Request');
    const ip = await this.pin(target.host);
    if (!ip) return refuse('403 Forbidden');
    if (client.destroyed) return;

    const upstream = net.connect({ host: ip, port: target.port });
    this.track(upstream);
    upstream.setTimeout(this.connectTimeoutMs, () => { upstream.destroy(); refuse('504 Gateway Timeout'); });
    upstream.once('connect', () => {
      upstream.setTimeout(0);
      try { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); } catch { upstream.destroy(); return; }
      if (head && head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => { if (!client.destroyed) refuse('502 Bad Gateway'); try { client.destroy(); } catch { /* gone */ } });
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => { try { client.destroy(); } catch { /* gone */ } });
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const fail = (status: number) => {
      if (res.headersSent) { try { res.destroy(); } catch { /* gone */ } return; }
      res.writeHead(status, { 'Content-Type': 'text/plain', Connection: 'close' });
      res.end();
    };
    let u: URL;
    try {
      // Only proxy-style requests (absolute http URL). A page that reaches this
      // port directly sends a path and is turned away.
      if (!/^http:\/\//i.test(req.url || '')) return fail(400);
      u = new URL(req.url!);
    } catch {
      return fail(400);
    }
    if (u.username || u.password) return fail(403);
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const ip = await this.pin(host);
    if (!ip) return fail(403);

    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue;
      headers[k] = v as string | string[];
    }
    headers.host = u.host;
    const upstream = http.request({
      host: ip,
      port: u.port ? Number(u.port) : 80,
      method: req.method,
      path: `${u.pathname}${u.search}`,
      headers,
      setHost: false,
      agent: false,
      timeout: this.connectTimeoutMs,
    }, (up) => {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(up.headers)) {
        if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue;
        out[k] = v as string | string[];
      }
      res.writeHead(up.statusCode || 502, out);
      up.pipe(res);
    });
    upstream.on('socket', (s) => this.track(s));
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.on('error', () => fail(502));
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  }
}
