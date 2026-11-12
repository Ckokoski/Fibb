/**
 * Connectors by link (Fibb P5): remote MCP (Model Context Protocol) servers.
 *
 * The author signs in to their apps at a hosted connector service, pastes ONE
 * link into Fibb, and that server's tools join Fibb's own tool loop with the
 * same safety rules as the built-in tools.
 *
 * Secrets: the server URL (it often carries a key in its path or query) and
 * an optional bearer token live ONLY in the vault (`mcp_<id>_url`,
 * `mcp_<id>_token`). They are never logged, audited, returned, or put in an
 * error message; only the host is ever shown. Non-secret metadata is in
 * <workspace>/.config/mcp.json.
 *
 * Trust: everything a server says about its tools (names, titles,
 * descriptions, schemas) and everything its tools return is untrusted text
 * written by a third party. Descriptions are sanitized and capped, schema
 * descriptions are never copied into the prompt, a description the injection
 * detector flags hides the tool, and a tool is `read` only when the server
 * says `readOnlyHint: true` and does not say `destructiveHint: true`.
 * Everything else needs the author's approval card.
 *
 * Not supported (on purpose): OAuth sign-in to the MCP server, local stdio
 * servers (they would run programs on the author's PC), and MCP resources,
 * prompts and sampling.
 */
import { randomBytes } from 'crypto';
import { mkdir, readFile, writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { checkUrl, type LookupFn } from './browser.js';
import { logger } from './logger.js';
import type { Tool, ToolRegistry } from './tools/registry.js';

// ───────────────────────── Limits ─────────────────────────

export const MCP_MAX_CONNECTIONS = 10;
export const MCP_MAX_TOOLS_PER_CONNECTION = 60;
export const MCP_TOOL_NAME_MAX = 64;
export const MCP_SLUG_MAX = 12;
export const MCP_DESCRIPTION_MAX = 200;
export const MCP_ARGS_HINT_MAX = 160;
export const MCP_ARGS_HINT_PROPS = 12;
export const MCP_APPROVAL_ARGS_MAX = 200;
/** The runner shortens (or refuses) approval text past this, so we never exceed it. */
export const MCP_APPROVAL_TEXT_MAX = 300;
export const MCP_ARGS_MAX_BYTES = 20_000;
export const MCP_CONNECT_TIMEOUT_MS = 15_000;
export const MCP_CALL_TIMEOUT_MS = 60_000;
export const MCP_CACHE_MS = 10 * 60_000;
export const MCP_ERROR_RETRY_MS = 60_000;
export const MCP_MAX_REDIRECTS = 3;
const TITLE_MAX = 60;
const APPROVAL_TITLE_MAX = 40;
const NAME_MAX = 40;
const RESULT_MAX_CHARS = 50_000;

export const MCP_UNREACHABLE = 'Could not reach that connector. Check the link and try again.';
export const MCP_SIGN_IN_UNSUPPORTED = 'That connector asked for a sign-in Fibb does not support yet.';

// ───────────────────────── Types ─────────────────────────

export type McpOverride = 'read' | 'write' | 'off';
export type McpToolState = 'on' | 'off' | 'hidden';
export type McpStatus = 'ok' | 'error' | 'unknown';

/** What is stored in mcp.json. Never the URL or the token. */
export interface McpConnectionMeta {
  id: string;
  name: string;
  /** Fixed when the connection is added, so tool names survive a rename. */
  slug: string;
  host: string;
  addedAt: string;
  enabled: boolean;
  /** Keyed by the REMOTE tool name. */
  toolOverrides?: Record<string, McpOverride>;
}

/** A tool as an MCP server lists it. All of it is untrusted. */
export interface RemoteTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; [k: string]: unknown };
}

export interface McpCallResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
  [k: string]: unknown;
}

/** The small part of an MCP client this module needs (injectable in tests). */
export interface McpClientLike {
  listTools(cursor?: string): Promise<{ tools: RemoteTool[]; nextCursor?: string }>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  close(): Promise<void>;
}

export interface McpTarget { url: string; token?: string; lookup?: LookupFn }
export type McpClientFactory = (target: McpTarget) => Promise<McpClientLike>;

export interface MappedTool {
  /** Fibb tool name: `<slug>__<sanitized remote name>`. */
  name: string;
  remoteName: string;
  title: string;
  description: string;
  args: string;
  /** The injection detector flagged the raw description, title or name. */
  flagged: boolean;
  /** Risk from the server's annotations alone. */
  baseRisk: 'read' | 'write';
  readOnly: boolean;
}

export interface McpToolView {
  name: string;
  title: string;
  description: string;
  risk: 'read' | 'write';
  state: McpToolState;
}

export interface McpConnectionView {
  id: string;
  name: string;
  host: string;
  enabled: boolean;
  status: McpStatus;
  error?: string;
  tools: McpToolView[];
  /** Tools the server offers that Fibb left out (over the limit, unusable or clashing names). */
  hiddenCount: number;
}

export interface McpVaultLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface McpConnectionsOptions {
  vault: McpVaultLike;
  workspaceDir: string;
  registry: ToolRegistry;
  injection: { detect: (input: string) => { detected: boolean } };
  audit?: { log: (category: string, action: string, data: Record<string, any>) => unknown };
  /** DNS lookup used by the URL guard (tests inject a fake). */
  lookup?: LookupFn;
  /** Defaults to the official SDK client over Streamable HTTP, then SSE. */
  clientFactory?: McpClientFactory;
  now?: () => number;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
}

/** A problem the author can fix; `message` is plain and never holds a secret. */
export class McpError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
    this.name = 'McpError';
  }
}

/** Thrown by a client factory when the server wants an OAuth sign-in. */
export class McpSignInRequired extends Error {
  constructor() {
    super('sign-in required');
    this.name = 'McpSignInRequired';
  }
}

// ───────────────────────── Sanitizing (pure, exported for tests) ─────────────────────────

// C0/C1 controls plus zero-width, bidi and other invisible format characters.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff9-\ufffb]|[\u{e0000}-\u{e007f}]/gu;
const TOOL_TAGS = /<\s*\/?\s*tool(?:_result)?\b[^>]*>?|tool_result/gi;

/**
 * Make third-party text safe to show or to put in the prompt: no control or
 * invisible characters, no `<tool>` / `</tool>` / `tool_result` tags, single
 * spaces, capped (with an ellipsis so a cut is visible).
 */
export function sanitizeMcpText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // Bound the work first; a server can send megabytes.
  let s = value.slice(0, Math.max(max * 20, 4000));
  s = s.replace(CONTROL_CHARS, ' ');
  // Twice: removing a tag must not splice a new one together.
  s = s.replace(TOOL_TAGS, ' ').replace(TOOL_TAGS, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
  return s;
}

const SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']);

/**
 * One-line args hint built from the JSON schema's TOP-LEVEL property names
 * and types only. Schema `description` fields are never read. Property names
 * that are not plain identifiers are left out.
 */
export function mcpArgsHint(schema: unknown): string {
  const props = schema && typeof schema === 'object' && !Array.isArray(schema)
    ? (schema as any).properties
    : undefined;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return '{}';
  const required = new Set<string>(
    Array.isArray((schema as any).required) ? (schema as any).required.filter((r: unknown) => typeof r === 'string') : [],
  );
  const names = Object.keys(props).filter(k => /^[a-zA-Z0-9_]{1,40}$/.test(k));
  if (!names.length) return '{}';
  const parts: string[] = [];
  let more = names.length > MCP_ARGS_HINT_PROPS;
  for (const k of names.slice(0, MCP_ARGS_HINT_PROPS)) {
    const raw = (props as any)[k]?.type;
    const first = Array.isArray(raw) ? raw.find((t: unknown) => t !== 'null') : raw;
    const type = typeof first === 'string' && SCHEMA_TYPES.has(first) ? first : 'any';
    const part = `"${k}"${required.has(k) ? '' : '?'}: ${type}`;
    // Keep room for ", …}".
    if (1 + [...parts, part].join(', ').length + 4 > MCP_ARGS_HINT_MAX) { more = true; break; }
    parts.push(part);
  }
  return `{${parts.join(', ')}${more ? (parts.length ? ', …' : '…') : ''}}`;
}

/** Slug for tool names: `[a-z0-9]`, starts with a letter, at most 12 chars, unique among `taken`. */
export function mcpSlug(name: string, taken: Iterable<string> = []): string {
  let s = String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, MCP_SLUG_MAX);
  if (!s) s = 'mcp';
  if (!/^[a-z]/.test(s)) s = `c${s}`.slice(0, MCP_SLUG_MAX);
  const used = new Set(taken);
  if (!used.has(s)) return s;
  for (let n = 2; n < 1000; n++) {
    const suffix = String(n);
    const candidate = s.slice(0, MCP_SLUG_MAX - suffix.length) + suffix;
    if (!used.has(candidate)) return candidate;
  }
  return s;
}

/**
 * `<slug>__<remote name>` with every character outside `[a-zA-Z0-9_]` turned
 * into `_`. Null when the result would be empty or longer than 64 chars.
 */
export function mcpToolName(slug: string, remoteName: unknown): string | null {
  if (typeof remoteName !== 'string' || !remoteName || remoteName.length > 200) return null;
  const clean = remoteName.replace(/[^a-zA-Z0-9_]/g, '_');
  if (!/[a-zA-Z0-9]/.test(clean)) return null;
  const full = `${slug}__${clean}`;
  if (full.length > MCP_TOOL_NAME_MAX || !/^[a-z][a-zA-Z0-9_]+$/.test(full)) return null;
  return full;
}

/** `read` only when the server says read-only and does not say destructive. */
export function mcpRisk(annotations: RemoteTool['annotations']): 'read' | 'write' {
  return annotations?.readOnlyHint === true && annotations?.destructiveHint !== true ? 'read' : 'write';
}

/**
 * Turn a server's tool list into Fibb tools. Keeps the first 60; skips names
 * that do not fit and names already taken. `skipped` counts everything left out.
 */
export function mapRemoteTools(
  slug: string,
  remote: RemoteTool[],
  opts: { detect: (text: string) => boolean; taken?: (name: string) => boolean },
): { tools: MappedTool[]; skipped: number } {
  const list = Array.isArray(remote) ? remote : [];
  const tools: MappedTool[] = [];
  const seen = new Set<string>();
  let skipped = Math.max(0, list.length - MCP_MAX_TOOLS_PER_CONNECTION);
  for (const r of list.slice(0, MCP_MAX_TOOLS_PER_CONNECTION)) {
    const name = mcpToolName(slug, (r as any)?.name);
    if (!name || seen.has(name) || opts.taken?.(name)) { skipped++; continue; }
    seen.add(name);
    const rawDescription = typeof r.description === 'string' ? r.description : '';
    const rawTitle = typeof r.annotations?.title === 'string' ? r.annotations.title
      : typeof r.title === 'string' ? r.title : '';
    let flagged = false;
    try {
      flagged = opts.detect(`${rawDescription.slice(0, 20_000)}\n${rawTitle.slice(0, 2000)}\n${r.name}`) === true;
    } catch { flagged = true; }
    const title = sanitizeMcpText(rawTitle, TITLE_MAX) || sanitizeMcpText(r.name, TITLE_MAX) || name;
    const baseRisk = mcpRisk(r.annotations);
    tools.push({
      name,
      remoteName: r.name,
      title,
      description: sanitizeMcpText(rawDescription, MCP_DESCRIPTION_MAX) || title,
      args: mcpArgsHint(r.inputSchema),
      flagged,
      baseRisk,
      readOnly: baseRisk === 'read',
    });
  }
  return { tools, skipped };
}

/** The risk and on/off state the author gets, after their overrides. */
export function effectiveMcpTool(
  tool: MappedTool,
  overrides: Record<string, McpOverride> | undefined,
): { risk: 'read' | 'write'; state: McpToolState } {
  const o = overrides && Object.prototype.hasOwnProperty.call(overrides, tool.remoteName) ? overrides[tool.remoteName] : undefined;
  if (tool.flagged) {
    // Flagged for safety: hidden unless the author turns it on WITH approval.
    return { risk: 'write', state: o === 'write' ? 'on' : o === 'off' ? 'off' : 'hidden' };
  }
  if (o === 'off') return { risk: tool.baseRisk, state: 'off' };
  return { risk: o === 'read' || o === 'write' ? o : tool.baseRisk, state: 'on' };
}

const RECIPIENT_KEY = /^(to|cc|bcc|emails?|recipient.*|url|channel)$/i;

function collectRecipientFields(value: unknown, out: string[], depth = 0): void {
  if (!value || typeof value !== 'object' || depth > 6) return;
  if (Array.isArray(value)) {
    for (const v of value) collectRecipientFields(v, out, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (RECIPIENT_KEY.test(k)) out.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
    else collectRecipientFields(v, out, depth + 1);
  }
}

/**
 * The sentence on the approval card. Shows the exact JSON that will be sent.
 * When that is longer than 200 chars it is cut with a visible `…(more)` and
 * every recipient-like field (to, cc, bcc, email, recipient*, url, channel)
 * is then listed in full. If even that cannot fit, this throws and the
 * request is refused: the author never approves a destination they cannot see.
 */
export function describeMcpCall(connectionName: string, title: string, args: Record<string, unknown>): string {
  const json = JSON.stringify(args ?? {}) ?? '{}';
  const head = `Use ${connectionName}: ${title.length > APPROVAL_TITLE_MAX ? title.slice(0, APPROVAL_TITLE_MAX - 1) + '…' : title} with `;
  if (json.length <= MCP_APPROVAL_ARGS_MAX) return head + json;
  const fields: string[] = [];
  collectRecipientFields(args, fields);
  const tail = `…(more)${fields.length ? ` Goes to: ${fields.join('; ')}` : ''}`;
  // The recipients come first: the JSON preview shrinks to make room for
  // them, and if there is still no room the request is refused.
  const room = Math.min(MCP_APPROVAL_ARGS_MAX, MCP_APPROVAL_TEXT_MAX - head.length - tail.length);
  const text = `${head}${json.slice(0, Math.max(0, room))}${tail}`;
  // Whitespace is collapsed by the runner; measure what the author will see.
  if (room < 20 || text.replace(/\s+/g, ' ').trim().length > MCP_APPROVAL_TEXT_MAX) {
    throw new Error('the request is too long to show the author in full. Use fewer recipients or shorter values.');
  }
  return text;
}

/** Tool result -> text. Non-text parts are named, never passed through. */
export function mcpResultToText(result: McpCallResult | null | undefined): { text: string; isError: boolean } {
  const parts: string[] = [];
  const content = Array.isArray(result?.content) ? (result!.content as any[]) : [];
  for (const p of content.slice(0, 200)) {
    const type = p && typeof p === 'object' ? p.type : undefined;
    if (type === 'text' && typeof p.text === 'string') parts.push(p.text);
    else if (type === 'image') parts.push('[image omitted]');
    else if (type === 'audio') parts.push('[audio omitted]');
    else if (type === 'resource') parts.push(typeof p.resource?.text === 'string' ? p.resource.text : '[file omitted]');
    else if (type === 'resource_link') parts.push('[link omitted]');
    else parts.push('[content omitted]');
  }
  let text = parts.join('\n').trim();
  if (!text && result?.structuredContent !== undefined && result.structuredContent !== null) {
    try { text = JSON.stringify(result.structuredContent) ?? ''; } catch { text = ''; }
  }
  if (!text) text = '(The connector returned nothing.)';
  if (text.length > RESULT_MAX_CHARS) text = text.slice(0, RESULT_MAX_CHARS);
  return { text, isError: result?.isError === true };
}

// ───────────────────────── Guarded fetch + SDK client ─────────────────────────

type FetchFn = (input: any, init?: any) => Promise<Response>;

/**
 * fetch for connector traffic. Every hop (including the first) must be https
 * and pass checkUrl; redirects are followed by hand, at most 3; a redirect to
 * another host is refused when the request carries an Authorization header;
 * a POST is only re-sent on 307/308. Error messages never contain a URL.
 */
export function createGuardedFetch(opts: {
  lookup?: LookupFn;
  baseFetch?: FetchFn;
  onResponse?: (res: Response) => void;
} = {}): FetchFn {
  return async (input: any, init?: any): Promise<Response> => {
    const base: FetchFn = opts.baseFetch ?? (globalThis.fetch as FetchFn);
    let url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input?.url ?? '');
    const method = String(init?.method || 'GET').toUpperCase();
    const headers = new Headers(init?.headers ?? {});
    for (let hop = 0; ; hop++) {
      let u: URL;
      try { u = new URL(url); } catch { throw new Error('Connector request blocked: not a valid address.'); }
      if (u.protocol !== 'https:') throw new Error('Connector request blocked: only https is allowed.');
      const check = opts.lookup ? await checkUrl(u.href, opts.lookup) : await checkUrl(u.href);
      if (!check.ok) throw new Error('Connector request blocked: that address is not allowed.');
      const res = await base(u.href, { ...init, method, headers, redirect: 'manual' });
      try { opts.onResponse?.(res); } catch { /* observer only */ }
      if (![301, 302, 303, 307, 308].includes(res.status)) return res;
      const location = res.headers.get('location');
      if (!location) return res;
      try { await res.body?.cancel(); } catch { /* nothing to drain */ }
      if (hop >= MCP_MAX_REDIRECTS) throw new Error('Connector request blocked: too many redirects.');
      let next: URL;
      try { next = new URL(location, u); } catch { throw new Error('Connector request blocked: bad redirect.'); }
      if (next.host !== u.host && headers.has('authorization')) {
        throw new Error('Connector request blocked: redirect to another site while signed in.');
      }
      if (res.status !== 307 && res.status !== 308 && method !== 'GET' && method !== 'HEAD') {
        throw new Error('Connector request blocked: redirect would change the request.');
      }
      url = next.href;
    }
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    if (typeof (timer as any).unref === 'function') (timer as any).unref();
    p.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * The real client: the official SDK over Streamable HTTP, falling back to the
 * legacy SSE transport when the server answers the first request with a 4xx
 * that means "not supported here". The SDK is loaded on first use so it
 * costs nothing at startup. `baseFetch` is for tests.
 */
export function createSdkClientFactory(opts: { baseFetch?: FetchFn; connectTimeoutMs?: number; callTimeoutMs?: number } = {}): McpClientFactory {
  const connectMs = opts.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS;
  const callMs = opts.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS;
  return async (target: McpTarget): Promise<McpClientLike> => {
    const [{ Client }, { StreamableHTTPClientTransport }, { SSEClientTransport }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
      import('@modelcontextprotocol/sdk/client/sse.js'),
    ]);
    let challenged = false;
    const guarded = createGuardedFetch({
      lookup: target.lookup,
      baseFetch: opts.baseFetch,
      onResponse: res => { if (res.status === 401 && res.headers.has('www-authenticate')) challenged = true; },
    });
    const requestInit = target.token ? { headers: { Authorization: `Bearer ${target.token}` } } : undefined;
    // Redirects are handled (and re-validated) by the guarded fetch.
    const transportOpts = { fetch: guarded as any, requestInit, redirectPolicy: 'follow' as const };
    const make = () => new Client({ name: 'fibb', version: '1.0.0' }, { capabilities: {} });
    const endpoint = new URL(target.url);

    let client = make();
    try {
      await client.connect(new StreamableHTTPClientTransport(endpoint, transportOpts), { timeout: connectMs });
    } catch (err) {
      try { await client.close(); } catch { /* already closed */ }
      if (challenged && !target.token) throw new McpSignInRequired();
      const code = (err as any)?.code;
      const unsupported = typeof code === 'number' && code >= 400 && code < 500 && code !== 401 && code !== 403 && code !== 429;
      if (!unsupported) throw err;
      client = make();
      try {
        await client.connect(new SSEClientTransport(endpoint, transportOpts), { timeout: connectMs });
      } catch (sseErr) {
        try { await client.close(); } catch { /* already closed */ }
        if (challenged && !target.token) throw new McpSignInRequired();
        throw sseErr;
      }
    }
    return {
      listTools: async (cursor?: string) => {
        const r = await client.listTools(cursor ? { cursor } : undefined, { timeout: connectMs });
        return { tools: r.tools as unknown as RemoteTool[], nextCursor: r.nextCursor };
      },
      callTool: async (name, args) =>
        (await client.callTool({ name, arguments: args }, undefined, { timeout: callMs })) as McpCallResult,
      close: () => client.close(),
    };
  };
}

// ───────────────────────── McpConnections ─────────────────────────

interface ConnState {
  meta: McpConnectionMeta;
  client?: McpClientLike;
  /** Strings that must never leave this module (URL, token and their parts). */
  secrets: string[];
  tools: MappedTool[];
  skipped: number;
  /** Names this connection has put in the registry. */
  registered: Set<string>;
  status: McpStatus;
  error?: string;
  listedAt: number;
  attemptedAt: number;
  loading?: Promise<void>;
}

const cleanName = (v: unknown) => (typeof v === 'string' ? v.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim() : '');

function validName(v: unknown): string {
  const name = cleanName(v);
  if (!name || name.length > NAME_MAX) throw new McpError('Give the connector a name of 1 to 40 characters.');
  return name;
}

function secretParts(url: string, token?: string): string[] {
  const out = new Set<string>([url]);
  if (token) out.add(token);
  try {
    const u = new URL(url);
    if (u.pathname.length > 1) { out.add(u.pathname + u.search); out.add(u.pathname); }
    if (u.search.length > 1) out.add(u.search);
    for (const seg of u.pathname.split('/')) {
      if (seg.length >= 6) { out.add(seg); try { out.add(decodeURIComponent(seg)); } catch { /* keep raw */ } }
    }
    for (const v of u.searchParams.values()) if (v.length >= 6) out.add(v);
  } catch { /* not a URL: the whole string is already covered */ }
  return [...out].filter(Boolean).sort((a, b) => b.length - a.length);
}

function scrub(text: string, secrets: string[]): string {
  let s = text;
  for (const secret of secrets) s = s.split(secret).join('[hidden]');
  return s;
}

/** A JSON-RPC error the server sent back (the request was understood and refused). */
function isProtocolError(err: unknown): boolean {
  const code = (err as any)?.code;
  // -32000 (connection closed) and -32001 (request timeout) are transport trouble.
  return typeof code === 'number' && code < 0 && code !== -32000 && code !== -32001;
}

/** The server rejected the HTTP request outright, so nothing was carried out. */
function isHttpRejection(err: unknown): boolean {
  const code = (err as any)?.code;
  return typeof code === 'number' && code >= 400 && code < 500;
}

export class McpConnections {
  private readonly vault: McpVaultLike;
  private readonly registry: ToolRegistry;
  private readonly configDir: string;
  private readonly configFile: string;
  private readonly factory: McpClientFactory;
  private readonly now: () => number;
  private readonly connectMs: number;
  private readonly callMs: number;
  private states: ConnState[] = [];
  private closed = false;
  private saving: Promise<void> = Promise.resolve();

  constructor(private opts: McpConnectionsOptions) {
    this.vault = opts.vault;
    this.registry = opts.registry;
    this.configDir = join(opts.workspaceDir, '.config');
    this.configFile = join(this.configDir, 'mcp.json');
    this.connectMs = opts.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS;
    this.callMs = opts.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS;
    this.factory = opts.clientFactory ?? createSdkClientFactory({ connectTimeoutMs: this.connectMs, callTimeoutMs: this.callMs });
    this.now = opts.now ?? Date.now;
  }

  // ── Lifecycle ──

  /** Read the saved list. Local and quick: no server is contacted here. */
  async initialize(): Promise<void> {
    this.states = [];
    let raw: any;
    try {
      raw = JSON.parse(await readFile(this.configFile, 'utf-8'));
    } catch {
      return; // no file yet, or unreadable: start empty
    }
    const list = Array.isArray(raw?.connections) ? raw.connections : [];
    const slugs = new Set<string>();
    for (const c of list.slice(0, MCP_MAX_CONNECTIONS)) {
      if (!c || typeof c.id !== 'string' || !/^[a-f0-9]{8,32}$/.test(c.id)) continue;
      if (this.states.some(s => s.meta.id === c.id)) continue;
      const name = cleanName(c.name).slice(0, NAME_MAX) || 'Connector';
      const slug = typeof c.slug === 'string' && /^[a-z][a-z0-9]{0,11}$/.test(c.slug) && !slugs.has(c.slug)
        ? c.slug : mcpSlug(name, slugs);
      slugs.add(slug);
      const toolOverrides: Record<string, McpOverride> = {};
      if (c.toolOverrides && typeof c.toolOverrides === 'object' && !Array.isArray(c.toolOverrides)) {
        for (const [k, v] of Object.entries(c.toolOverrides)) {
          if (v === 'read' || v === 'write' || v === 'off') toolOverrides[k] = v;
        }
      }
      this.states.push(this.newState({
        id: c.id,
        name,
        slug,
        host: sanitizeMcpText(c.host, 255),
        addedAt: typeof c.addedAt === 'string' ? c.addedAt : new Date(this.now()).toISOString(),
        enabled: c.enabled !== false,
        toolOverrides,
      }));
    }
  }

  /**
   * Contact every enabled connector and register its tools. Meant to run in
   * the background after startup; one connector failing never affects another
   * and this never rejects.
   */
  async connectAll(): Promise<void> {
    await Promise.all(this.states.filter(s => s.meta.enabled).map(s => this.load(s).catch(() => {})));
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.states.map(s => this.dropClient(s)));
  }

  // ── Public API ──

  list(): McpConnectionView[] {
    return this.states.map(s => this.view(s));
  }

  get(id: string): McpConnectionView | null {
    const s = this.states.find(x => x.meta.id === id);
    return s ? this.view(s) : null;
  }

  /** Retry connectors that are down or stale, in the background, throttled. */
  poke(): void {
    for (const s of this.states) this.maybeReload(s);
  }

  async add(input: { name?: unknown; url?: unknown; token?: unknown }): Promise<McpConnectionView> {
    const name = validName(input?.name);
    if (typeof input?.url !== 'string' || !input.url.trim() || input.url.length > 2000) {
      throw new McpError('Paste the connector link (it starts with https://).');
    }
    const url = input.url.trim();
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new McpError('That does not look like a link. It should start with https://'); }
    if (parsed.protocol !== 'https:') throw new McpError('The connector link must start with https://');
    const check = this.opts.lookup ? await checkUrl(url, this.opts.lookup) : await checkUrl(url);
    if (!check.ok) throw new McpError(check.reason);
    let token: string | undefined;
    if (input.token !== undefined && input.token !== null && input.token !== '') {
      if (typeof input.token !== 'string') throw new McpError('That access token does not look right.');
      token = input.token.trim().replace(/^Bearer\s+/i, '');
      if (!token || token.length > 4000 || !/^[\x21-\x7e]+$/.test(token)) throw new McpError('That access token does not look right.');
    }
    if (this.states.length >= MCP_MAX_CONNECTIONS) {
      throw new McpError(`You can have up to ${MCP_MAX_CONNECTIONS} connectors. Remove one first.`);
    }

    // Handshake first: nothing is saved unless the server answers.
    let client: McpClientLike;
    let remote: RemoteTool[];
    try {
      ({ client, remote } = await this.openAndList({ url, token, lookup: this.opts.lookup }));
    } catch (err) {
      this.audit('add-failed', { host: parsed.host });
      throw new McpError(err instanceof McpSignInRequired && !token ? MCP_SIGN_IN_UNSUPPORTED : MCP_UNREACHABLE);
    }

    const id = randomBytes(8).toString('hex');
    const meta: McpConnectionMeta = {
      id, name,
      slug: mcpSlug(name, this.states.map(s => s.meta.slug)),
      host: parsed.host,
      addedAt: new Date(this.now()).toISOString(),
      enabled: true,
      toolOverrides: {},
    };
    try {
      await this.vault.set(`mcp_${id}_url`, url);
      if (token) await this.vault.set(`mcp_${id}_token`, token);
    } catch {
      try { await client.close(); } catch { /* best effort */ }
      await this.deleteSecrets(id);
      throw new McpError('Fibb could not save that connector. Try again.', 500);
    }
    const state = this.newState(meta);
    state.client = client;
    state.secrets = secretParts(url, token);
    this.states.push(state);
    this.applyTools(state, remote);
    await this.save();
    this.audit('added', { id, name, host: meta.host, tools: state.tools.length, hidden: state.skipped });
    return this.view(state);
  }

  async update(id: string, patch: { enabled?: unknown; name?: unknown; tools?: unknown }): Promise<McpConnectionView> {
    const state = this.find(id);
    const p = patch || {};
    const name = p.name !== undefined ? validName(p.name) : undefined;
    if (p.enabled !== undefined && typeof p.enabled !== 'boolean') throw new McpError('enabled must be true or false.');
    let overrides: Record<string, McpOverride> | undefined;
    if (p.tools !== undefined) {
      if (!p.tools || typeof p.tools !== 'object' || Array.isArray(p.tools)) throw new McpError('tools must list each tool as read, write or off.');
      overrides = { ...(state.meta.toolOverrides || {}) };
      for (const [key, value] of Object.entries(p.tools as Record<string, unknown>)) {
        const tool = state.tools.find(t => t.name === key) ?? state.tools.find(t => t.remoteName === key);
        if (!tool) throw new McpError('Fibb does not know one of those tools. Refresh the connector and try again.');
        if (value === null) { delete overrides[tool.remoteName]; continue; }
        if (value !== 'read' && value !== 'write' && value !== 'off') throw new McpError('Each tool must be set to read, write or off.');
        if (tool.flagged && value === 'read') {
          throw new McpError('That tool was hidden for safety. It can only be off, or on with your approval each time.');
        }
        overrides[tool.remoteName] = value;
      }
    }
    // All input is valid: apply.
    if (name !== undefined) state.meta.name = name;
    if (overrides) state.meta.toolOverrides = overrides;
    const wasEnabled = state.meta.enabled;
    if (typeof p.enabled === 'boolean') state.meta.enabled = p.enabled;
    await this.save();
    if (!state.meta.enabled) {
      this.unregisterAll(state);
      await this.dropClient(state);
      state.status = 'unknown';
      state.error = undefined;
    } else if (!wasEnabled) {
      await this.load(state);
    } else {
      this.syncRegistry(state);
    }
    this.audit('updated', {
      id, host: state.meta.host, enabled: state.meta.enabled,
      renamed: name !== undefined, toolsChanged: overrides ? Object.keys(p.tools as object).length : 0,
    });
    return this.view(state);
  }

  /** Ask the server for its tool list again. */
  async refresh(id: string): Promise<McpConnectionView> {
    const state = this.find(id);
    if (state.meta.enabled) await this.load(state);
    return this.view(state);
  }

  async remove(id: string): Promise<void> {
    const state = this.find(id);
    this.unregisterAll(state);
    await this.dropClient(state);
    this.states = this.states.filter(s => s !== state);
    await this.deleteSecrets(id);
    await this.save();
    this.audit('removed', { id, host: state.meta.host });
  }

  // ── Internals ──

  private find(id: string): ConnState {
    const s = this.states.find(x => x.meta.id === id);
    if (!s) throw new McpError('That connector no longer exists.', 404);
    return s;
  }

  private newState(meta: McpConnectionMeta): ConnState {
    return { meta, secrets: [], tools: [], skipped: 0, registered: new Set(), status: 'unknown', listedAt: 0, attemptedAt: 0 };
  }

  private view(s: ConnState): McpConnectionView {
    const tools = s.tools.map(t => {
      const e = effectiveMcpTool(t, s.meta.toolOverrides);
      return { name: t.name, title: t.title, description: t.description, risk: e.risk, state: e.state };
    });
    const out: McpConnectionView = {
      id: s.meta.id, name: s.meta.name, host: s.meta.host, enabled: s.meta.enabled,
      status: s.meta.enabled ? s.status : 'unknown',
      tools, hiddenCount: s.skipped,
    };
    if (s.meta.enabled && s.status === 'error' && s.error) out.error = s.error;
    return out;
  }

  private audit(action: string, data: Record<string, any>): void {
    try {
      const r = this.opts.audit?.log('mcp', action, data);
      if (r && typeof (r as any).catch === 'function') (r as Promise<unknown>).catch(() => {});
    } catch { /* auditing must never break a connector */ }
  }

  private save(): Promise<void> {
    const write = async () => {
      const body = JSON.stringify({ connections: this.states.map(s => s.meta) }, null, 2);
      await mkdir(this.configDir, { recursive: true });
      const tmp = `${this.configFile}.tmp`;
      await writeFile(tmp, body, 'utf-8');
      await rename(tmp, this.configFile);
    };
    this.saving = this.saving.then(write, write);
    return this.saving.catch(() => {
      logger.warn('Could not save the connector list.');
      throw new McpError('Fibb could not save your connectors. Try again.', 500);
    });
  }

  private async deleteSecrets(id: string): Promise<void> {
    for (const key of [`mcp_${id}_url`, `mcp_${id}_token`]) {
      try { await this.vault.delete(key); } catch { /* best effort */ }
    }
  }

  private async dropClient(s: ConnState): Promise<void> {
    const c = s.client;
    s.client = undefined;
    if (c) { try { await c.close(); } catch { /* already gone */ } }
  }

  private async listAll(client: McpClientLike): Promise<RemoteTool[]> {
    const all: RemoteTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await client.listTools(cursor);
      if (Array.isArray(r?.tools)) all.push(...r.tools.filter(t => t && typeof t === 'object'));
      cursor = typeof r?.nextCursor === 'string' && r.nextCursor ? r.nextCursor : undefined;
      if (!cursor || all.length >= 500) break;
    }
    return all;
  }

  /** Connect and list within the connect timeout; a late client is closed. */
  private async openAndList(target: McpTarget): Promise<{ client: McpClientLike; remote: RemoteTool[] }> {
    let abandoned = false;
    let opened: McpClientLike | undefined;
    const work = (async () => {
      const client = await this.factory(target);
      opened = client;
      if (abandoned) { try { await client.close(); } catch { /* best effort */ } throw new Error('timed out'); }
      const remote = await this.listAll(client);
      return { client, remote };
    })();
    try {
      return await withTimeout(work, this.connectMs);
    } catch (err) {
      abandoned = true;
      work.catch(() => {});
      if (opened) { try { await opened.close(); } catch { /* best effort */ } }
      throw err;
    }
  }

  private async target(s: ConnState): Promise<McpTarget | null> {
    let url: string | null = null;
    let token: string | null = null;
    try {
      url = await this.vault.get(`mcp_${s.meta.id}_url`);
      token = await this.vault.get(`mcp_${s.meta.id}_token`);
    } catch { url = null; }
    if (!url) return null;
    s.secrets = secretParts(url, token || undefined);
    return { url, token: token || undefined, lookup: this.opts.lookup };
  }

  private async client(s: ConnState): Promise<McpClientLike> {
    if (s.client) return s.client;
    const target = await this.target(s);
    if (!target) throw new McpError('The saved link for this connector is missing. Remove it and add it again.');
    const client = await withTimeout(this.factory(target), this.connectMs);
    if (this.closed || !s.meta.enabled || !this.states.includes(s)) {
      try { await client.close(); } catch { /* best effort */ }
      throw new Error('connector is off');
    }
    s.client = client;
    return client;
  }

  /** Connect (if needed) and re-read the tool list. One reconnect on failure. Never throws. */
  private load(s: ConnState): Promise<void> {
    if (s.loading) return s.loading;
    const run = async () => {
      s.attemptedAt = this.now();
      let lastErr: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          let remote: RemoteTool[];
          if (s.client) {
            remote = await withTimeout(this.listAll(s.client), this.connectMs);
          } else {
            const target = await this.target(s);
            if (!target) throw new McpError('The saved link for this connector is missing. Remove it and add it again.');
            const r = await this.openAndList(target);
            if (this.closed || !s.meta.enabled || !this.states.includes(s)) {
              try { await r.client.close(); } catch { /* best effort */ }
              return;
            }
            s.client = r.client;
            remote = r.remote;
          }
          this.applyTools(s, remote);
          return;
        } catch (err) {
          lastErr = err;
          await this.dropClient(s);
          if (err instanceof McpError || err instanceof McpSignInRequired) break;
        }
      }
      s.status = 'error';
      s.error = lastErr instanceof McpError ? lastErr.message
        : lastErr instanceof McpSignInRequired ? MCP_SIGN_IN_UNSUPPORTED
        : 'Fibb could not reach this connector. It will try again later.';
      this.audit('connect-failed', { id: s.meta.id, host: s.meta.host });
    };
    s.loading = run().catch(() => { s.status = 'error'; }).finally(() => { s.loading = undefined; });
    return s.loading;
  }

  private maybeReload(s: ConnState): void {
    if (this.closed || !s.meta.enabled || s.loading) return;
    const t = this.now();
    const due = s.status === 'error'
      ? t - s.attemptedAt >= MCP_ERROR_RETRY_MS
      : s.status === 'ok' && t - s.listedAt >= MCP_CACHE_MS;
    if (due) void this.load(s);
  }

  private applyTools(s: ConnState, remote: RemoteTool[]): void {
    const { tools, skipped } = mapRemoteTools(s.meta.slug, remote, {
      detect: text => this.opts.injection.detect(text).detected === true,
      // A name another connector or a built-in tool already uses is skipped.
      taken: name => !s.registered.has(name) && this.registry.get(name) !== undefined,
    });
    s.tools = tools;
    s.skipped = skipped;
    s.listedAt = this.now();
    s.attemptedAt = s.listedAt;
    s.status = 'ok';
    s.error = undefined;
    this.syncRegistry(s);
  }

  private unregisterAll(s: ConnState): void {
    for (const name of s.registered) this.registry.unregister(name);
    s.registered.clear();
  }

  private syncRegistry(s: ConnState): void {
    this.unregisterAll(s);
    if (!s.meta.enabled) return;
    for (const t of s.tools) {
      const e = effectiveMcpTool(t, s.meta.toolOverrides);
      if (e.state !== 'on') continue;
      if (this.registry.get(t.name)) continue; // never replace someone else's tool
      try {
        this.registry.register(this.buildTool(s, t, e.risk));
        s.registered.add(t.name);
      } catch { /* a name the registry refuses is simply not offered */ }
    }
  }

  private buildTool(s: ConnState, t: MappedTool, risk: 'read' | 'write'): Tool {
    return {
      name: t.name,
      description: t.description,
      args: t.args,
      risk,
      // Every connector result is outside content, like a web page or an email.
      source: 'mcp',
      summary: `Using ${s.meta.name}…`,
      // Room for one connect plus one call; the call itself is capped at 60 s.
      timeoutMs: this.connectMs + this.callMs + 5000,
      available: () => {
        this.maybeReload(s);
        return s.meta.enabled && s.status !== 'error' && !this.closed;
      },
      describe: args => describeMcpCall(s.meta.name, t.title, args),
      run: args => this.call(s, t, args, risk),
    };
  }

  private async call(s: ConnState, t: MappedTool, args: Record<string, unknown>, risk: 'read' | 'write'): Promise<string> {
    const name = s.meta.name;
    if (!args || typeof args !== 'object' || Array.isArray(args) || ![Object.prototype, null].includes(Object.getPrototypeOf(args))) {
      throw new Error('The details for a connector tool must be a JSON object.');
    }
    let json: string;
    try { json = JSON.stringify(args); } catch { throw new Error('Those details could not be sent to the connector.'); }
    if (Buffer.byteLength(json, 'utf-8') >= MCP_ARGS_MAX_BYTES) {
      throw new Error('That is too much to send to a connector in one go (the limit is 20 KB).');
    }
    if (!s.meta.enabled || this.closed || !this.states.includes(s)) throw new Error(`${name} is turned off.`);
    // Send a clean copy so nothing but plain JSON leaves.
    const payload = JSON.parse(json) as Record<string, unknown>;

    // Third-party text goes back as a RESULT for read tools (so the runner
    // scans and wraps it); an approved write tool reports failure by throwing.
    const refuse = (text: string): string => {
      if (risk === 'read') return text;
      throw new Error(text);
    };
    const serverSaid = (err: unknown) =>
      sanitizeMcpText(scrub(String((err as any)?.message ?? ''), s.secrets), 160) || 'no details given';

    let result: McpCallResult;
    try {
      result = await this.callOnce(s, t.remoteName, payload);
    } catch (err) {
      if (err instanceof McpError) throw err;
      if (isProtocolError(err)) return refuse(`${name} refused that request: ${serverSaid(err)}`);
      await this.dropClient(s);
      // Re-sending is only safe when the first try cannot have done anything:
      // a read-only tool, or a request the server turned away at the door
      // (for example an expired session).
      if (!t.readOnly && !isHttpRejection(err)) {
        throw new Error(`${name} did not answer, so Fibb cannot tell whether this went through. Check there before trying again.`);
      }
      try {
        result = await this.callOnce(s, t.remoteName, payload);
      } catch (again) {
        if (isProtocolError(again)) return refuse(`${name} refused that request: ${serverSaid(again)}`);
        await this.dropClient(s);
        s.status = 'error';
        s.error = 'Fibb could not reach this connector. It will try again later.';
        s.attemptedAt = this.now();
        this.audit('call-failed', { id: s.meta.id, host: s.meta.host });
        throw new Error(`${name} could not be reached. Try again in a moment.`);
      }
    }
    const { text, isError } = mcpResultToText(result);
    if (isError) return refuse(`${name} reported a problem: ${sanitizeMcpText(scrub(text, s.secrets), 300)}`);
    return text;
  }

  private async callOnce(s: ConnState, remoteName: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const client = await this.client(s);
    return withTimeout(client.callTool(remoteName, args), this.callMs);
  }
}
