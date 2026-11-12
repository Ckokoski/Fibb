/**
 * Google connector (Fibb P4c): Drive, Docs, Gmail and Calendar over plain
 * fetch REST. No SDK.
 *
 * Secrets live only in the vault (google_client_id, google_client_secret,
 * google_refresh_token). The access token is cached in memory. The only
 * non-secret state (the connected email) is in <workspace>/.config/google.json.
 *
 * Mail: Fibb can search, read and save DRAFTS. There is deliberately no code
 * path that sends mail.
 *
 * Tokens, the client secret and the auth code are never logged or returned.
 * Errors shown to the model or the author are short and generic.
 */
import { createHash, randomBytes } from 'crypto';
import { mkdir, readFile, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { logger } from './logger.js';
import type { Tool } from './tools/registry.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const DOCS = 'https://docs.googleapis.com/v1';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALENDAR = 'https://www.googleapis.com/calendar/v3';

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar.readonly',
];

const KEY_CLIENT_ID = 'google_client_id';
const KEY_CLIENT_SECRET = 'google_client_secret';
const KEY_REFRESH = 'google_refresh_token';

const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_STATES = 20;
const TEXT_MAX = 6000;
const DOC_CONTENT_MAX = 200_000;
const ID_RE = /^[A-Za-z0-9_-]{5,}$/;
const EMAIL_RE = /^[^\s@<>,;:"'()\[\]\\]+@[^\s@<>,;:"'()\[\]\\]+\.[^\s@<>,;:"'()\[\]\\]+$/;
const GOOGLE_DOC = 'application/vnd.google-apps.document';

/** An error whose message is safe to show to the model and the author. */
export class GoogleError extends Error {}

const saidNo = (status: number) => `Google said no (${status}). The author may need to reconnect in Settings.`;
const NOT_CONNECTED = 'Google is not connected. The author can connect it in Settings.';
const UNREACHABLE = 'Could not reach Google. Check the internet connection and try again.';

export interface VaultLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<unknown>;
}

export interface GoogleServiceOptions {
  vault: VaultLike;
  workspaceDir: string;
  /** The port the local server listens on (for the loopback redirect). */
  port?: number;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function str(v: unknown, max: number): string {
  return (typeof v === 'string' ? v : '').slice(0, max);
}

function oneLine(v: unknown, max: number): string {
  return str(v, max * 4).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function quote(v: unknown, max: number): string {
  const s = oneLine(v, 2000);
  return `"${s.length > max ? s.slice(0, max - 1) + '…' : s}"`;
}

function requireId(v: unknown): string {
  if (typeof v !== 'string' || !ID_RE.test(v) || v.length > 200) {
    throw new GoogleError('That id does not look right. Use an id from a search result.');
  }
  return v;
}

function parseRecipients(v: unknown): string[] {
  const list = str(v, 1000).split(',').map(s => s.trim()).filter(Boolean);
  if (list.length === 0 || list.length > 10 || list.some(a => !EMAIL_RE.test(a) || a.length > 254)) {
    throw new GoogleError('The "to" address is not a valid email address.');
  }
  return list;
}

/** All recipients, in full, for the approval card. Falls back to the raw text when it does not parse. */
function describeRecipients(v: unknown): string {
  try { return parseRecipients(v).join(', '); } catch { return oneLine(v, 1000); }
}

/** RFC 2047 encode a header value when it is not plain ASCII. */
function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Build a plain-text RFC 822 message (headers cannot be injected: no CR/LF). */
export function buildRawEmail(to: string[], subject: string, body: string): string {
  const b64 = Buffer.from(body, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  const msg = [
    `To: ${to.join(', ')}`,
    `Subject: ${encodeHeader(oneLine(subject, 250))}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64,
  ].join('\r\n');
  return b64url(Buffer.from(msg, 'utf8'));
}

function decodeBody(data: unknown): string {
  if (typeof data !== 'string' || !data) return '';
  try { return Buffer.from(data, 'base64url').toString('utf8'); } catch { return ''; }
}

/** Pull the readable text out of a Gmail message payload. */
function extractMailText(payload: any): string {
  const find = (part: any, mime: string): string => {
    if (!part || typeof part !== 'object') return '';
    if (part.mimeType === mime && part.body?.data) return decodeBody(part.body.data);
    if (Array.isArray(part.parts)) {
      for (const p of part.parts) {
        const hit = find(p, mime);
        if (hit) return hit;
      }
    }
    return '';
  };
  const plain = find(payload, 'text/plain');
  if (plain) return plain;
  const html = find(payload, 'text/html');
  if (!html) return '';
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

function header(payload: any, name: string): string {
  const h = Array.isArray(payload?.headers)
    ? payload.headers.find((x: any) => String(x?.name).toLowerCase() === name.toLowerCase())
    : null;
  return oneLine(h?.value, 200);
}

export class GoogleService {
  private vault: VaultLike;
  private configDir: string;
  private configFile: string;
  private port: number;

  private access: { token: string; expires: number } | null = null;
  private states = new Map<string, { verifier: string; expires: number }>();
  private connected = false;
  private email: string | undefined;

  constructor(opts: GoogleServiceOptions) {
    this.vault = opts.vault;
    this.configDir = join(opts.workspaceDir, '.config');
    this.configFile = join(this.configDir, 'google.json');
    this.port = Number.isInteger(opts.port) && (opts.port as number) > 0 ? (opts.port as number) : 3847;
  }

  async initialize(): Promise<void> {
    try {
      this.connected = !!(await this.vault.get(KEY_REFRESH));
    } catch {
      this.connected = false;
    }
    try {
      const raw = JSON.parse(await readFile(this.configFile, 'utf-8'));
      if (typeof raw?.email === 'string') this.email = raw.email.slice(0, 254);
    } catch { /* no state yet */ }
    if (!this.connected) this.email = undefined;
  }

  isConnected(): boolean {
    return this.connected;
  }

  redirectUri(): string {
    return `http://127.0.0.1:${this.port}/api/google/callback`;
  }

  private async client(): Promise<{ id: string; secret: string } | null> {
    const [id, secret] = await Promise.all([this.vault.get(KEY_CLIENT_ID), this.vault.get(KEY_CLIENT_SECRET)]);
    return id && secret ? { id, secret } : null;
  }

  async status(): Promise<{ configured: boolean; connected: boolean; email?: string }> {
    let configured = false;
    try {
      configured = !!(await this.client());
      this.connected = !!(await this.vault.get(KEY_REFRESH));
    } catch { /* report what we know */ }
    const out: { configured: boolean; connected: boolean; email?: string } = { configured, connected: this.connected };
    if (this.connected && this.email) out.email = this.email;
    return out;
  }

  /** Store the OAuth client. Shapes are validated; values are never echoed. */
  async setClient(clientId: unknown, clientSecret: unknown): Promise<void> {
    const id = typeof clientId === 'string' ? clientId.trim() : '';
    const secret = typeof clientSecret === 'string' ? clientSecret.trim() : '';
    if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(id) || id.length > 200) {
      throw new GoogleError('That client ID does not look right. It ends with .apps.googleusercontent.com.');
    }
    if (!/^[A-Za-z0-9_-]{16,200}$/.test(secret)) {
      throw new GoogleError('That client secret does not look right.');
    }
    await this.vault.set(KEY_CLIENT_ID, id);
    await this.vault.set(KEY_CLIENT_SECRET, secret);
  }

  /** Build the consent URL (desktop loopback flow, PKCE S256). */
  async authUrl(): Promise<string> {
    const client = await this.client();
    if (!client) throw new GoogleError('Google is not set up yet. Add the client ID and secret first.');
    const now = Date.now();
    for (const [k, v] of this.states) if (v.expires <= now) this.states.delete(k);
    while (this.states.size >= MAX_STATES) {
      const oldest = this.states.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.states.delete(oldest);
    }
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(48));
    this.states.set(state, { verifier, expires: now + STATE_TTL_MS });
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const params = new URLSearchParams({
      client_id: client.id,
      redirect_uri: this.redirectUri(),
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      scope: GOOGLE_SCOPES.join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  /** Finish the OAuth flow. Throws a GoogleError with a safe message on failure. */
  async handleCallback(code: unknown, state: unknown): Promise<{ email?: string }> {
    const entry = typeof state === 'string' ? this.states.get(state) : undefined;
    if (typeof state === 'string') this.states.delete(state); // one use only
    if (!entry || entry.expires <= Date.now()) {
      throw new GoogleError('That sign-in link has expired. Start again from Settings.');
    }
    if (typeof code !== 'string' || !code || code.length > 2000) {
      throw new GoogleError('Google did not finish the sign-in. Start again from Settings.');
    }
    const client = await this.client();
    if (!client) throw new GoogleError('Google is not set up yet. Add the client ID and secret first.');

    let res: any;
    try {
      res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: client.id,
          client_secret: client.secret,
          redirect_uri: this.redirectUri(),
          code_verifier: entry.verifier,
        }).toString(),
      });
    } catch {
      throw new GoogleError(UNREACHABLE);
    }
    if (!res.ok) throw new GoogleError(saidNo(res.status));
    let data: any = null;
    try { data = await res.json(); } catch { data = null; }
    if (!data || typeof data.refresh_token !== 'string' || !data.refresh_token || typeof data.access_token !== 'string') {
      throw new GoogleError('Google did not give Fibb lasting access. Start again from Settings.');
    }
    await this.vault.set(KEY_REFRESH, data.refresh_token);
    this.access = { token: data.access_token, expires: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
    this.connected = true;

    let email: string | undefined;
    try {
      const info = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${data.access_token}` } });
      if (info.ok) {
        const j: any = await info.json();
        if (typeof j?.email === 'string' && EMAIL_RE.test(j.email)) email = j.email.slice(0, 254);
      }
    } catch { /* the email is a nicety */ }
    this.email = email;
    try {
      await mkdir(this.configDir, { recursive: true });
      await writeFile(this.configFile, JSON.stringify({ email: email ?? null }, null, 2), 'utf-8');
    } catch (err) {
      logger.debug('google state save failed', err);
    }
    return email ? { email } : {};
  }

  /**
   * Disconnect. Revokes the token (best effort), deletes the refresh token
   * and the email. When called while NOT connected, it also removes the
   * client ID and secret (a full reset).
   */
  async disconnect(): Promise<void> {
    let refresh: string | null = null;
    try { refresh = await this.vault.get(KEY_REFRESH); } catch { refresh = null; }
    if (refresh) {
      try {
        await fetch(REVOKE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: refresh }).toString(),
        });
      } catch { /* best effort */ }
      await this.vault.delete(KEY_REFRESH);
    } else {
      await this.vault.delete(KEY_CLIENT_ID);
      await this.vault.delete(KEY_CLIENT_SECRET);
    }
    this.access = null;
    this.connected = false;
    this.email = undefined;
    this.states.clear();
    try { await rm(this.configFile, { force: true }); } catch { /* nothing to remove */ }
  }

  // ── Authenticated requests ──

  private async accessToken(): Promise<string> {
    if (this.access && this.access.expires - 60_000 > Date.now()) return this.access.token;
    const client = await this.client();
    const refresh = await this.vault.get(KEY_REFRESH);
    if (!client || !refresh) throw new GoogleError(NOT_CONNECTED);
    let res: any;
    try {
      res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refresh,
          client_id: client.id,
          client_secret: client.secret,
        }).toString(),
      });
    } catch {
      throw new GoogleError(UNREACHABLE);
    }
    if (!res.ok) throw new GoogleError(saidNo(res.status));
    let data: any = null;
    try { data = await res.json(); } catch { data = null; }
    if (!data || typeof data.access_token !== 'string' || !data.access_token) throw new GoogleError(saidNo(res.status));
    this.access = { token: data.access_token, expires: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
    return this.access.token;
  }

  private async api(url: string, init: { method?: string; body?: unknown } = {}, as: 'json' | 'text' = 'json'): Promise<any> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken();
      let res: any;
      try {
        res = await fetch(url, {
          method: init.method || 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        });
      } catch {
        throw new GoogleError(UNREACHABLE);
      }
      if (res.status === 401 && attempt === 0) {
        this.access = null; // stale token: refresh once and retry
        continue;
      }
      if (!res.ok) throw new GoogleError(saidNo(res.status));
      try {
        return as === 'text' ? await res.text() : await res.json();
      } catch {
        throw new GoogleError('Google sent back something Fibb could not read.');
      }
    }
    throw new GoogleError(saidNo(401));
  }

  // ── Operations behind the tools ──

  async driveSearch(query: string): Promise<string> {
    const q = oneLine(query, 200);
    if (!q) throw new GoogleError('Say what to search for.');
    const esc = q.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const params = new URLSearchParams({
      q: `(fullText contains '${esc}' or name contains '${esc}') and trashed = false`,
      pageSize: '10',
      fields: 'files(id,name,mimeType,modifiedTime)',
    });
    const data = await this.api(`${DRIVE}/files?${params.toString()}`);
    const files: any[] = Array.isArray(data?.files) ? data.files.slice(0, 10) : [];
    if (!files.length) return `Nothing in Drive matches "${q}".`;
    return files.map((f, i) => {
      const type = String(f.mimeType || '').replace('application/vnd.google-apps.', 'Google ').slice(0, 60);
      return `${i + 1}. ${oneLine(f.name, 120)} | ${type} | modified ${oneLine(f.modifiedTime, 10)} | id: ${oneLine(f.id, 100)}`;
    }).join('\n');
  }

  async docRead(idArg: unknown): Promise<string> {
    const id = requireId(idArg);
    const meta = await this.api(`${DRIVE}/files/${id}?fields=id,name,mimeType,size`);
    const mime = String(meta?.mimeType || '');
    const name = oneLine(meta?.name, 120);
    let text: string;
    if (mime === GOOGLE_DOC) {
      text = await this.api(`${DRIVE}/files/${id}/export?mimeType=${encodeURIComponent('text/plain')}`, {}, 'text');
    } else if (mime.startsWith('text/') || mime === 'application/json') {
      if (Number(meta?.size) > 5_000_000) return `"${name}" is too large to read here.`;
      text = await this.api(`${DRIVE}/files/${id}?alt=media`, {}, 'text');
    } else {
      return `Fibb cannot read this type of file (${mime.slice(0, 80) || 'unknown'}): "${name}".`;
    }
    const body = String(text ?? '').replace(/^﻿/, '').trim();
    const cut = body.length > TEXT_MAX;
    return `${name}\n\n${body.slice(0, TEXT_MAX)}${cut ? '\n(Cut off at 6000 characters.)' : ''}`;
  }

  async docCreate(titleArg: unknown, contentArg: unknown): Promise<string> {
    const title = oneLine(titleArg, 200);
    if (!title) throw new GoogleError('The document needs a title.');
    const content = typeof contentArg === 'string' ? contentArg : '';
    if (content.length > DOC_CONTENT_MAX) throw new GoogleError('That is too much text for one document.');
    const doc = await this.api(`${DOCS}/documents`, { method: 'POST', body: { title } });
    const id = requireId(doc?.documentId);
    if (content) {
      await this.api(`${DOCS}/documents/${id}:batchUpdate`, {
        method: 'POST',
        body: { requests: [{ insertText: { location: { index: 1 }, text: content } }] },
      });
    }
    return `Created the Google Doc "${title}": https://docs.google.com/document/d/${id}/edit`;
  }

  async docAppend(idArg: unknown, textArg: unknown): Promise<string> {
    const id = requireId(idArg);
    const text = typeof textArg === 'string' ? textArg : '';
    if (!text) throw new GoogleError('There is no text to add.');
    if (text.length > DOC_CONTENT_MAX) throw new GoogleError('That is too much text to add at once.');
    await this.api(`${DOCS}/documents/${id}:batchUpdate`, {
      method: 'POST',
      body: { requests: [{ insertText: { endOfSegmentLocation: {}, text } }] },
    });
    return `Added the text to the end of the document: https://docs.google.com/document/d/${id}/edit`;
  }

  async gmailSearch(query: string): Promise<string> {
    const q = oneLine(query, 300);
    if (!q) throw new GoogleError('Say what to search for.');
    const list = await this.api(`${GMAIL}/messages?${new URLSearchParams({ q, maxResults: '10' }).toString()}`);
    const ids: string[] = (Array.isArray(list?.messages) ? list.messages : [])
      .map((m: any) => m?.id).filter((id: unknown) => typeof id === 'string' && ID_RE.test(id)).slice(0, 10);
    if (!ids.length) return `No email matches "${q}".`;
    const meta = 'format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date';
    const msgs = await Promise.all(ids.map(id => this.api(`${GMAIL}/messages/${id}?${meta}`)));
    return msgs.map((m, i) =>
      `${i + 1}. From: ${header(m?.payload, 'From')} | Subject: ${header(m?.payload, 'Subject')} | Date: ${header(m?.payload, 'Date')}\n` +
      `   ${oneLine(m?.snippet, 200)}\n   id: ${ids[i]}`,
    ).join('\n');
  }

  async gmailRead(idArg: unknown): Promise<string> {
    const id = requireId(idArg);
    const m = await this.api(`${GMAIL}/messages/${id}?format=full`);
    const body = (extractMailText(m?.payload) || oneLine(m?.snippet, 500) || '(No readable text.)').trim();
    const cut = body.length > TEXT_MAX;
    return `From: ${header(m?.payload, 'From')}\nSubject: ${header(m?.payload, 'Subject')}\nDate: ${header(m?.payload, 'Date')}\n\n` +
      `${body.slice(0, TEXT_MAX)}${cut ? '\n(Cut off at 6000 characters.)' : ''}`;
  }

  /** Saves a DRAFT only. Nothing in this service sends mail. */
  async gmailDraft(toArg: unknown, subjectArg: unknown, bodyArg: unknown): Promise<string> {
    const to = parseRecipients(toArg);
    const subject = oneLine(subjectArg, 250);
    const body = typeof bodyArg === 'string' ? bodyArg : '';
    if (!subject && !body) throw new GoogleError('The draft needs a subject or some text.');
    if (body.length > 100_000) throw new GoogleError('That is too much text for one email.');
    await this.api(`${GMAIL}/drafts`, { method: 'POST', body: { message: { raw: buildRawEmail(to, subject, body) } } });
    return `Saved a draft to ${to.join(', ')} in Gmail Drafts. It has not been sent.`;
  }

  async calendarUpcoming(daysArg: unknown): Promise<string> {
    let days = Number(daysArg);
    if (!Number.isFinite(days) || days < 1) days = 7;
    days = Math.min(30, Math.floor(days));
    const now = new Date();
    const params = new URLSearchParams({
      timeMin: now.toISOString(),
      timeMax: new Date(now.getTime() + days * 86_400_000).toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '25',
    });
    const data = await this.api(`${CALENDAR}/calendars/primary/events?${params.toString()}`);
    const items: any[] = Array.isArray(data?.items) ? data.items.slice(0, 25) : [];
    if (!items.length) return `Nothing on the calendar in the next ${days} day${days === 1 ? '' : 's'}.`;
    return items.map((e, i) => {
      const start = oneLine(e?.start?.dateTime || e?.start?.date, 30);
      const where = oneLine(e?.location, 80);
      return `${i + 1}. ${start} | ${oneLine(e?.summary, 120) || '(no title)'}${where ? ` | ${where}` : ''}`;
    }).join('\n');
  }

  /** The Google tools. All are available only while connected. */
  tools(): Tool[] {
    const available = () => this.connected;
    return [
      {
        name: 'drive_search', risk: 'read', source: 'drive', available, summary: 'Searching your Drive…',
        description: 'Search the author\'s Google Drive by name and content.',
        args: '{"query": "words"}',
        run: (a) => this.driveSearch(str(a.query, 500)),
      },
      {
        name: 'doc_read', risk: 'read', source: 'drive', available, summary: 'Reading a document…',
        description: 'Read a Google Doc or text file from Drive by id.',
        args: '{"id": "file id"}',
        run: (a) => this.docRead(a.id),
      },
      {
        name: 'doc_create', risk: 'write', available, summary: 'Creating a Google Doc…',
        description: 'Create a new Google Doc with a title and text.',
        args: '{"title": "...", "content": "..."}',
        // The whole title is shown (never shortened) so the author sees exactly what is created.
        describe: (a) => `Create a Google Doc titled ${quote(a.title, 200)}`,
        bind: (a) => {
          if (!oneLine(a.title, 200)) throw new GoogleError('The document needs a title.');
          return { title: a.title, content: typeof a.content === 'string' ? a.content : '' };
        },
        run: (a) => this.docCreate(a.title, a.content),
      },
      {
        name: 'doc_append', risk: 'write', available, summary: 'Adding to a Google Doc…',
        description: 'Add text to the end of a Google Doc by id.',
        args: '{"id": "doc id", "text": "..."}',
        describe: (a) => `Add ${typeof a.text === 'string' ? a.text.length : 0} characters to the end of a Google Doc (id ${oneLine(a.id, 200)})`,
        bind: (a) => ({ id: requireId(a.id), text: typeof a.text === 'string' ? a.text : '' }),
        run: (a) => this.docAppend(a.id, a.text),
      },
      {
        name: 'gmail_search', risk: 'read', source: 'email', available, summary: 'Searching your email…',
        description: 'Search the author\'s Gmail (Gmail search syntax works).',
        args: '{"query": "words"}',
        run: (a) => this.gmailSearch(str(a.query, 500)),
      },
      {
        name: 'gmail_read', risk: 'read', source: 'email', available, summary: 'Reading an email…',
        description: 'Read one email by id.',
        args: '{"id": "message id"}',
        run: (a) => this.gmailRead(a.id),
      },
      {
        name: 'gmail_draft', risk: 'write', available, summary: 'Drafting an email…',
        description: 'Save an email DRAFT for the author to review and send themselves. Fibb cannot send email.',
        args: '{"to": "name@example.com", "subject": "...", "body": "..."}',
        // Every recipient is shown in full, so a draft addressed to a stranger stands out.
        describe: (a) => `Save an email draft to ${describeRecipients(a.to)} with subject ${quote(a.subject, 80)}`,
        bind: (a) => ({ to: parseRecipients(a.to).join(', '), subject: oneLine(a.subject, 250), body: typeof a.body === 'string' ? a.body : '' }),
        run: (a) => this.gmailDraft(a.to, a.subject, a.body),
      },
      {
        name: 'calendar_upcoming', risk: 'read', source: 'calendar', available, summary: 'Checking your calendar…',
        description: 'List upcoming events on the author\'s main calendar.',
        args: '{"days": 7}',
        run: (a) => this.calendarUpcoming(a.days),
      },
    ];
  }
}
