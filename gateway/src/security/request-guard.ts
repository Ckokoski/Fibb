/**
 * Fibb request guard: stops a web page the author happens to visit from
 * driving the local server (CSRF, cross-origin calls, DNS rebinding).
 *
 * The server has no login: it trusts whoever can reach 127.0.0.1. A hostile
 * page in the author's everyday browser can reach it too, so every /api/*
 * request must prove it comes from Fibb's own app (same origin) or from a
 * non-browser client on this machine (curl, the Telegram bridge's internal
 * calls), never from another site.
 *
 * Rules, in order (see evaluateRequest):
 *  1. Host must be localhost / 127.0.0.1 / [::1] on the configured port, or an
 *     explicitly configured extra host. Defeats DNS rebinding.
 *  2. If an Origin header is present it must be one of Fibb's own origins.
 *  3. State-changing methods (POST/PUT/PATCH/DELETE) with no Origin must have
 *     Sec-Fetch-Site same-origin/none, or no Sec-Fetch-Site at all (non-browser).
 *  4. Other methods with no Origin are refused when the browser says the
 *     request is cross-site/same-site, unless it is a top-level navigation
 *     (the Google OAuth callback, a link the author clicked).
 *  5. State-changing requests may not use a CORS "simple" content type
 *     (text/plain, application/x-www-form-urlencoded, multipart/form-data),
 *     except multipart on the known upload routes.
 *
 * Extra hosts/origins come from the environment:
 *   FIBB_ALLOWED_HOSTS    comma-separated Host values, e.g. "fibb.lan:3847"
 *   FIBB_ALLOWED_ORIGINS  comma-separated origins, e.g. "http://localhost:5173"
 * The Vite dev origin (http://localhost:5173) is allowed automatically only in
 * development (NODE_ENV=development, FIBB_DEV=1, or `npm run dev`).
 */

export interface GuardRequest {
  method: string;
  /** Path without the query string. */
  path: string;
  host?: string;
  origin?: string;
  secFetchSite?: string;
  secFetchMode?: string;
  contentType?: string;
}

export interface GuardOptions {
  /** The port the server listens on (a getter, because config loads late). */
  port: number | (() => number);
  /** Extra Host header values to accept, e.g. "fibb.lan:3847". */
  extraHosts?: string[];
  /** Extra origins to accept, e.g. the Vite dev server. */
  extraOrigins?: string[];
  /** Routes that take multipart uploads. */
  uploadPaths?: RegExp[];
}

export type GuardDecision = { ok: true } | { ok: false; status: number; code: string; message: string };

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SIMPLE_TYPES = ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data'];
const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '[::1]'];

/** The multer routes. Keep in sync with api/routes/{audio,documents,kdp-track-changes}.ts. */
export const UPLOAD_PATHS: RegExp[] = [
  /^\/api\/audio\/transcribe\/?$/,
  /^\/api\/documents\/upload\/?$/,
  /^\/api\/projects\/[^/]+\/upload\/?$/,
  /^\/api\/track-changes\/parse\/?$/,
];

const VITE_DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

function portOf(opts: GuardOptions): number {
  const p = typeof opts.port === 'function' ? opts.port() : opts.port;
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : 3847;
}

function csv(v: string | undefined): string[] {
  return String(v || '').split(',').map(s => s.trim()).filter(Boolean);
}

/** Host header values Fibb answers to. */
export function allowedHosts(opts: GuardOptions): string[] {
  const port = portOf(opts);
  const out = LOOPBACK_NAMES.map(h => `${h}:${port}`);
  if (port === 80) out.push(...LOOPBACK_NAMES);
  for (const h of opts.extraHosts || []) out.push(h.toLowerCase());
  return out;
}

/** Origins Fibb accepts: http://<each allowed host>, plus configured extras. */
export function allowedOrigins(opts: GuardOptions): string[] {
  const out = allowedHosts(opts).map(h => `http://${h}`);
  for (const o of opts.extraOrigins || []) out.push(o.toLowerCase().replace(/\/+$/, ''));
  return out;
}

export function isAllowedHost(host: string | undefined, opts: GuardOptions): boolean {
  if (typeof host !== 'string' || !host) return false;
  return allowedHosts(opts).includes(host.trim().toLowerCase());
}

export function isAllowedOrigin(origin: string | undefined, opts: GuardOptions): boolean {
  if (typeof origin !== 'string' || !origin) return false;
  return allowedOrigins(opts).includes(origin.trim().toLowerCase());
}

const deny = (code: string, message: string, status = 403): GuardDecision => ({ ok: false, status, code, message });

/** Pure decision: may this /api request proceed? */
export function evaluateRequest(req: GuardRequest, opts: GuardOptions): GuardDecision {
  const method = String(req.method || 'GET').toUpperCase();
  const path = String(req.path || '');

  // 1. Host allowlist (DNS rebinding).
  if (!isAllowedHost(req.host, opts)) {
    return deny('bad_host', 'This address is not allowed to reach Fibb.');
  }

  const origin = typeof req.origin === 'string' && req.origin ? req.origin : undefined;
  const site = String(req.secFetchSite || '').toLowerCase();
  const mode = String(req.secFetchMode || '').toLowerCase();
  const stateChanging = STATE_CHANGING.has(method);

  // 2. An Origin header, when sent, must be Fibb's own ("null" never is).
  if (origin !== undefined) {
    if (!isAllowedOrigin(origin, opts)) return deny('cross_origin', 'Requests from other sites are not allowed.');
  } else if (stateChanging) {
    // 3. No Origin: trust the browser's Sec-Fetch-Site, or its absence (non-browser client).
    if (site && site !== 'same-origin' && site !== 'none') {
      return deny('cross_site', 'Requests from other sites are not allowed.');
    }
  } else if ((site === 'cross-site' || site === 'same-site') && mode !== 'navigate') {
    // 4. Another site embedding or fetching a GET (img/script/no-cors fetch).
    return deny('cross_site', 'Requests from other sites are not allowed.');
  }

  // 5. No CORS-simple content types on state-changing requests.
  if (stateChanging) {
    const type = String(req.contentType || '').split(';')[0].trim().toLowerCase();
    if (type && SIMPLE_TYPES.includes(type)) {
      const upload = type === 'multipart/form-data' && (opts.uploadPaths ?? UPLOAD_PATHS).some(re => re.test(path));
      if (!upload) return deny('bad_content_type', 'Send JSON (Content-Type: application/json).', 415);
    }
  }
  return { ok: true };
}

/** Guard options from the environment. `port` is read lazily on every request. */
export function guardOptionsFromEnv(port: number | (() => number), env: NodeJS.ProcessEnv = process.env, execArgv: string[] = process.execArgv): GuardOptions {
  const dev = env.NODE_ENV === 'development' || env.FIBB_DEV === '1' || execArgv.includes('--watch');
  return {
    port,
    extraHosts: csv(env.FIBB_ALLOWED_HOSTS),
    extraOrigins: [...csv(env.FIBB_ALLOWED_ORIGINS), ...(dev ? VITE_DEV_ORIGINS : [])],
  };
}

type AuditFn = (category: string, action: string, data: Record<string, any>) => unknown;

const header = (req: any, name: string): string | undefined => {
  const v = req?.headers?.[name];
  return Array.isArray(v) ? v[0] : (typeof v === 'string' ? v : undefined);
};

/** Read the guard-relevant parts of a Node/Express request. */
export function describeRequest(req: any, pathOverride?: string): GuardRequest {
  const raw = String(pathOverride ?? req?.originalUrl ?? req?.url ?? '');
  return {
    method: String(req?.method || 'GET'),
    path: raw.split('?')[0],
    host: header(req, 'host'),
    origin: header(req, 'origin'),
    secFetchSite: header(req, 'sec-fetch-site'),
    secFetchMode: header(req, 'sec-fetch-mode'),
    contentType: header(req, 'content-type'),
  };
}

/**
 * Express middleware. Guards every /api/* request; everything else (the
 * static app) passes. Refusals are audited with the reason only, never the
 * body or query string.
 */
export function createRequestGuard(opts: GuardOptions, audit?: AuditFn) {
  return (req: any, res: any, next: (err?: any) => void): void => {
    const info = describeRequest(req);
    if (info.path !== '/api' && !info.path.startsWith('/api/')) return next();
    const decision = evaluateRequest(info, opts);
    if (decision.ok) return next();
    try {
      const r = audit?.('security', 'request_blocked', {
        reason: decision.code,
        method: info.method.slice(0, 10),
        path: info.path.slice(0, 120),
        origin: String(info.origin || '').slice(0, 120),
        host: String(info.host || '').slice(0, 120),
      });
      if (r && typeof (r as any).catch === 'function') (r as Promise<unknown>).catch(() => {});
    } catch { /* auditing must never break the refusal */ }
    res.status(decision.status).json({ error: decision.message });
  };
}

/**
 * Socket.IO `allowRequest`: the handshake must pass the same Host and Origin
 * rules as a state-changing API call (a WebSocket can send messages).
 */
export function createSocketGuard(opts: GuardOptions, audit?: AuditFn) {
  return (req: any, callback: (err: string | null | undefined, success: boolean) => void): void => {
    const info = describeRequest(req);
    const decision = evaluateRequest({ ...info, method: 'POST', contentType: undefined }, opts);
    if (!decision.ok) {
      try {
        const r = audit?.('security', 'websocket_rejected', { reason: decision.code, origin: String(info.origin || '').slice(0, 120) });
        if (r && typeof (r as any).catch === 'function') (r as Promise<unknown>).catch(() => {});
      } catch { /* ignore */ }
    }
    callback(null, decision.ok);
  };
}

export interface RateRule {
  /** Which requests this rule counts. */
  match: (method: string, path: string) => boolean;
  /** Requests allowed per window. */
  max: number;
  windowMs: number;
  name: string;
}

/** Sensible defaults for a single-user local app: stops runaway loops and brute force, never a person. */
export const DEFAULT_RATE_RULES: RateRule[] = [
  { name: 'vault', max: 30, windowMs: 60_000, match: (m, p) => m !== 'GET' && (p === '/api/vault' || p.startsWith('/api/vault/')) },
  { name: 'approvals', max: 60, windowMs: 60_000, match: (m, p) => m === 'POST' && p.startsWith('/api/approvals/') },
  { name: 'google', max: 20, windowMs: 60_000, match: (m, p) => (m === 'POST' && p === '/api/google/client') || p === '/api/google/callback' || p === '/api/google/auth-url' },
  { name: 'chat', max: 60, windowMs: 60_000, match: (m, p) => m === 'POST' && (p === '/api/chat' || p === '/api/chat/stream') },
  { name: 'mcp', max: 20, windowMs: 60_000, match: (m, p) => m !== 'GET' && (p === '/api/mcp' || p.startsWith('/api/mcp/')) },
  { name: 'browser', max: 30, windowMs: 60_000, match: (m, p) => m === 'POST' && p.startsWith('/api/browser/') },
  // Each one is a model call that writes code.
  { name: 'shelf', max: 10, windowMs: 60_000, match: (m, p) => m === 'POST' && (p === '/api/shelf' || p === '/api/shelf/') },
];

/**
 * Tiny fixed-window rate limiter (no dependency). One bucket per rule: the
 * server is single-user and loopback-only, so there is no per-client key.
 */
export function createRateLimiter(rules: RateRule[] = DEFAULT_RATE_RULES, now: () => number = Date.now) {
  const buckets = new Map<string, { start: number; count: number }>();
  return (req: any, res: any, next: (err?: any) => void): void => {
    const method = String(req?.method || 'GET').toUpperCase();
    const path = String(req?.originalUrl ?? req?.url ?? '').split('?')[0];
    const rule = rules.find(r => r.match(method, path));
    if (!rule) return next();
    const t = now();
    let b = buckets.get(rule.name);
    if (!b || t - b.start >= rule.windowMs) {
      b = { start: t, count: 0 };
      buckets.set(rule.name, b);
    }
    b.count++;
    if (b.count > rule.max) {
      const retry = Math.max(1, Math.ceil((b.start + rule.windowMs - t) / 1000));
      res.setHeader?.('Retry-After', String(retry));
      res.status(429).json({ error: 'Too many requests. Wait a moment and try again.' });
      return;
    }
    next();
  };
}
