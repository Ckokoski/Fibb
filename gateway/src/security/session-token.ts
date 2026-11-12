/**
 * Fibb session token: a per-install secret that every /api/* request and every
 * Socket.IO handshake must present.
 *
 * The request guard (request-guard.ts) stops other web sites from driving the
 * local server. This closes the remaining gap: a caller that is not a browser
 * page (or a page the guard cannot tell apart) must also know a secret that
 * only Fibb's own app is handed.
 *
 *  - The token is 256 random bits, stored at <workspace>/.config/session-token
 *    (mode 0600 where the platform supports it), created on first start and
 *    regenerated when missing or malformed. It is never logged.
 *  - When the server serves the app's HTML (the static index pages and the
 *    SPA fallbacks, never JSON such as /healthz) it sets
 *      fibb_session=<token>; Path=/; HttpOnly; SameSite=Strict
 *    (a session cookie, re-set on every HTML load; no Secure, this is http on
 *    loopback).
 *  - /api/* and the Socket.IO handshake accept the token from that cookie or
 *    from an X-Fibb-Token header, compared in constant time.
 *  - The only exemption is GET /api/google/callback: a top-level navigation
 *    from Google, which SameSite=Strict strips the cookie from. It carries its
 *    own single-use OAuth state.
 *
 * Runs after the Host/Origin guard.
 */
import { randomBytes, timingSafeEqual, createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync, unlinkSync } from 'fs';
import { join } from 'path';
import { isAllowedHost, type GuardOptions } from './request-guard.js';

export const SESSION_COOKIE = 'fibb_session';
export const SESSION_HEADER = 'x-fibb-token';
export const SESSION_DENIED_MESSAGE = 'Not signed in to Fibb. Reload the page.';

const TOKEN_RE = /^[0-9a-f]{64}$/;

export function isValidSessionToken(v: unknown): v is string {
  return typeof v === 'string' && TOKEN_RE.test(v);
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('hex');
}

export function sessionTokenPath(workspaceDir: string): string {
  return join(workspaceDir, '.config', 'session-token');
}

/**
 * Read the install's token, creating it when missing or malformed.
 * Synchronous on purpose: the gateway needs it before the first request.
 */
export function loadOrCreateSessionToken(workspaceDir: string): string {
  const file = sessionTokenPath(workspaceDir);
  try {
    if (existsSync(file)) {
      const current = readFileSync(file, 'utf-8').trim();
      if (isValidSessionToken(current)) {
        try { chmodSync(file, 0o600); } catch { /* not supported here */ }
        return current;
      }
    }
  } catch { /* unreadable: replace it */ }
  const token = generateSessionToken();
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, token + '\n', { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw err;
  }
  try { chmodSync(file, 0o600); } catch { /* not supported here */ }
  return token;
}

/** Constant-time comparison (hashes first, so lengths never leak or throw). */
export function tokensEqual(presented: unknown, expected: unknown): boolean {
  if (typeof presented !== 'string' || typeof expected !== 'string' || !presented || !expected) return false;
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Every value of one cookie in a Cookie header (a name can legally repeat). */
export function readCookies(header: unknown, name: string): string[] {
  if (typeof header !== 'string' || !header) return [];
  const out: string[] = [];
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    let v = part.slice(i + 1).trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (v) out.push(v);
  }
  return out;
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`;
}

export interface SessionRequest {
  method: string;
  /** Path without the query string. */
  path: string;
  cookie?: string;
  headerToken?: string;
}

/** The one route that may be reached without the token. */
export function isSessionExempt(method: string, path: string): boolean {
  return String(method).toUpperCase() === 'GET' && /^\/api\/google\/callback\/?$/.test(path);
}

export function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/** Does this request carry the install's token (header or cookie)? */
export function hasSessionToken(req: Pick<SessionRequest, 'cookie' | 'headerToken'>, token: string): boolean {
  if (!isValidSessionToken(token)) return false; // fail closed
  let ok = false;
  // No early exit: check every candidate.
  if (tokensEqual(req.headerToken, token)) ok = true;
  for (const c of readCookies(req.cookie, SESSION_COOKIE)) {
    if (tokensEqual(c, token)) ok = true;
  }
  return ok;
}

/** Pure decision for an HTTP request. Non-API paths always pass. */
export function evaluateSession(req: SessionRequest, token: string): boolean {
  if (!isApiPath(req.path)) return true;
  if (isSessionExempt(req.method, req.path)) return true;
  return hasSessionToken(req, token);
}

type AuditFn = (category: string, action: string, data: Record<string, any>) => unknown;

const header = (req: any, name: string): string | undefined => {
  const v = req?.headers?.[name];
  return Array.isArray(v) ? v[0] : (typeof v === 'string' ? v : undefined);
};
const pathOf = (req: any): string => String(req?.originalUrl ?? req?.url ?? '').split('?')[0];

function describe(req: any): SessionRequest {
  return {
    method: String(req?.method || 'GET'),
    path: pathOf(req),
    cookie: header(req, 'cookie'),
    headerToken: header(req, SESSION_HEADER),
  };
}

function safeAudit(audit: AuditFn | undefined, action: string, data: Record<string, any>): void {
  try {
    const r = audit?.('security', action, data);
    if (r && typeof (r as any).catch === 'function') (r as Promise<unknown>).catch(() => {});
  } catch { /* auditing must never break the refusal */ }
}

/** Express middleware: 401 for any /api/* request without the token. */
export function createSessionGuard(getToken: () => string, audit?: AuditFn) {
  return (req: any, res: any, next: (err?: any) => void): void => {
    const info = describe(req);
    if (evaluateSession(info, getToken())) return next();
    safeAudit(audit, 'session_missing', { method: info.method.slice(0, 10), path: info.path.slice(0, 120) });
    res.status(401).json({ error: SESSION_DENIED_MESSAGE });
  };
}

/**
 * Hand the cookie to a page the server is about to send. Only for a Host Fibb
 * answers to, so a rebound name never receives it. Never throws.
 */
export function grantSessionCookie(req: any, res: any, token: string, opts: GuardOptions): void {
  try {
    if (!isValidSessionToken(token) || !isAllowedHost(header(req, 'host'), opts)) return;
    res.append('Set-Cookie', sessionCookie(token));
  } catch { /* never block a page load */ }
}

/**
 * `setHeaders` for express.static: every HTML file it serves (including a 304
 * for one) carries the cookie; scripts, styles and images do not.
 */
export function createSessionStaticHeaders(getToken: () => string, opts: GuardOptions) {
  return (res: any, filePath: string): void => {
    if (/\.html?$/i.test(String(filePath))) grantSessionCookie(res?.req, res, getToken(), opts);
  };
}

type AllowRequest = (req: any, callback: (err: string | null | undefined, success: boolean) => void) => void;

/**
 * Socket.IO `allowRequest`: runs the Host/Origin guard (`inner`) first, then
 * requires the token on the handshake (cookie or X-Fibb-Token).
 */
export function createSocketSessionGuard(getToken: () => string, inner?: AllowRequest, audit?: AuditFn): AllowRequest {
  return (req, callback) => {
    const check = () => {
      const ok = hasSessionToken({ cookie: header(req, 'cookie'), headerToken: header(req, SESSION_HEADER) }, getToken());
      if (!ok) safeAudit(audit, 'websocket_rejected', { reason: 'session_missing' });
      callback(null, ok);
    };
    if (!inner) return check();
    inner(req, (err, success) => {
      if (err || !success) return callback(err, false);
      check();
    });
  };
}
