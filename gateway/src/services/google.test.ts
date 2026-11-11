import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { GoogleService, GoogleError, GOOGLE_SCOPES, buildRawEmail } from './google.js';

// Everything here uses an in-memory fake vault and a stubbed fetch. Nothing
// touches the real vault, the network, or Google.
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

type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined };
let calls: Call[];
let routes: Array<[RegExp | string, (c: Call) => { status?: number; json?: any; text?: string }]>;

function stubFetch() {
  calls = [];
  routes = [];
  vi.stubGlobal('fetch', vi.fn(async (url: any, init: any = {}) => {
    const c: Call = { url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body };
    calls.push(c);
    for (const [match, fn] of routes) {
      if (typeof match === 'string' ? c.url.startsWith(match) : match.test(c.url)) {
        const r = fn(c);
        const status = r.status ?? 200;
        return {
          ok: status >= 200 && status < 300, status,
          json: async () => r.json ?? {},
          text: async () => r.text ?? JSON.stringify(r.json ?? {}),
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  }));
}
const on = (match: RegExp | string, fn: (c: Call) => { status?: number; json?: any; text?: string }) => routes.push([match, fn]);
const tokenOk = () => on('https://oauth2.googleapis.com/token', () => ({ json: { access_token: ACCESS, expires_in: 3600 } }));
const apiCalls = () => calls.filter(c => !c.url.startsWith('https://oauth2.googleapis.com/'));

let dir: string;
let vault: FakeVault;
let google: GoogleService;

async function connected() {
  vault.store.set('google_client_id', CLIENT_ID);
  vault.store.set('google_client_secret', CLIENT_SECRET);
  vault.store.set('google_refresh_token', REFRESH);
  await google.initialize();
  tokenOk();
}
const tool = (name: string) => google.tools().find(t => t.name === name)!;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fibb-google-'));
  vault = new FakeVault();
  google = new GoogleService({ vault, workspaceDir: dir, port: 3847 });
  await google.initialize();
  stubFetch();
});
afterEach(() => { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });

describe('Google setup and OAuth', () => {
  it('status reflects configured / connected', async () => {
    expect(await google.status()).toEqual({ configured: false, connected: false });
    await google.setClient(CLIENT_ID, CLIENT_SECRET);
    expect(await google.status()).toEqual({ configured: true, connected: false });
    expect(vault.store.get('google_client_id')).toBe(CLIENT_ID);
    expect(vault.store.get('google_client_secret')).toBe(CLIENT_SECRET);
  });

  it('setClient validates shapes and stores nothing when invalid', async () => {
    await expect(google.setClient('not-a-client-id', CLIENT_SECRET)).rejects.toBeInstanceOf(GoogleError);
    await expect(google.setClient(CLIENT_ID, 'short')).rejects.toBeInstanceOf(GoogleError);
    await expect(google.setClient(CLIENT_ID, 'has spaces in the secret value')).rejects.toBeInstanceOf(GoogleError);
    await expect(google.setClient(undefined, undefined)).rejects.toBeInstanceOf(GoogleError);
    expect(vault.store.size).toBe(0);
  });

  it('authUrl needs a client, then builds the consent URL with PKCE and state', async () => {
    await expect(google.authUrl()).rejects.toBeInstanceOf(GoogleError);
    await google.setClient(CLIENT_ID, CLIENT_SECRET);
    const url = new URL(await google.authUrl());
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = url.searchParams;
    expect(p.get('client_id')).toBe(CLIENT_ID);
    expect(p.get('redirect_uri')).toBe('http://127.0.0.1:3847/api/google/callback');
    expect(p.get('response_type')).toBe('code');
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get('state')).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(p.get('scope')!.split(' ')).toEqual(GOOGLE_SCOPES);
    expect(p.get('scope')).toBe(
      'openid email https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file ' +
      'https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/gmail.readonly ' +
      'https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/calendar.readonly',
    );
    expect(url.href).not.toContain(CLIENT_SECRET);
    // A second URL gets a different state.
    expect(new URL(await google.authUrl()).searchParams.get('state')).not.toBe(p.get('state'));
    // The port comes from the server config.
    const other = new GoogleService({ vault, workspaceDir: dir, port: 4100 });
    expect(new URL(await other.authUrl()).searchParams.get('redirect_uri')).toBe('http://127.0.0.1:4100/api/google/callback');
  });

  it('callback: rejects an unknown or reused state without calling Google', async () => {
    await google.setClient(CLIENT_ID, CLIENT_SECRET);
    await google.authUrl();
    await expect(google.handleCallback('the-code', 'wrong-state')).rejects.toThrow(/expired/);
    await expect(google.handleCallback('the-code', undefined)).rejects.toBeInstanceOf(GoogleError);
    expect(calls).toHaveLength(0);
    expect(vault.store.has('google_refresh_token')).toBe(false);
  });

  it('callback: an expired state is rejected', async () => {
    await google.setClient(CLIENT_ID, CLIENT_SECRET);
    vi.useFakeTimers();
    try {
      const state = new URL(await google.authUrl()).searchParams.get('state')!;
      vi.advanceTimersByTime(10 * 60 * 1000 + 1);
      await expect(google.handleCallback('the-code', state)).rejects.toThrow(/expired/);
    } finally {
      vi.useRealTimers();
    }
    expect(calls).toHaveLength(0);
  });

  it('callback: exchanges the code with the PKCE verifier and stores the refresh token in the vault', async () => {
    await google.setClient(CLIENT_ID, CLIENT_SECRET);
    const auth = new URL(await google.authUrl());
    const state = auth.searchParams.get('state')!;
    on('https://oauth2.googleapis.com/token', () => ({ json: { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 } }));
    on('https://openidconnect.googleapis.com/v1/userinfo', () => ({ json: { email: 'author@example.com' } }));

    expect(await google.handleCallback('the-code', state)).toEqual({ email: 'author@example.com' });

    const exchange = new URLSearchParams(calls[0].body);
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token');
    expect(calls[0].method).toBe('POST');
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('code')).toBe('the-code');
    expect(exchange.get('client_id')).toBe(CLIENT_ID);
    expect(exchange.get('client_secret')).toBe(CLIENT_SECRET);
    expect(exchange.get('redirect_uri')).toBe('http://127.0.0.1:3847/api/google/callback');
    const challenge = createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url');
    expect(challenge).toBe(auth.searchParams.get('code_challenge'));
    expect(calls[1].headers.Authorization).toBe(`Bearer ${ACCESS}`);

    expect(vault.store.get('google_refresh_token')).toBe(REFRESH);
    expect(await google.status()).toEqual({ configured: true, connected: true, email: 'author@example.com' });
    expect(google.isConnected()).toBe(true);

    // Only the email is written to disk, never a token or secret.
    const file = readFileSync(join(dir, '.config', 'google.json'), 'utf-8');
    expect(JSON.parse(file)).toEqual({ email: 'author@example.com' });
    for (const secret of [REFRESH, ACCESS, CLIENT_SECRET, 'the-code']) expect(file).not.toContain(secret);

    // The state is single use.
    await expect(google.handleCallback('the-code', state)).rejects.toThrow(/expired/);

    // A new instance (restart) remembers the connection and the email.
    const again = new GoogleService({ vault, workspaceDir: dir });
    await again.initialize();
    expect(await again.status()).toEqual({ configured: true, connected: true, email: 'author@example.com' });
  });

  it('callback: a refused exchange or a missing refresh token fails with a generic message', async () => {
    await google.setClient(CLIENT_ID, CLIENT_SECRET);
    let state = new URL(await google.authUrl()).searchParams.get('state')!;
    on('https://oauth2.googleapis.com/token', () => ({ status: 400, json: { error: 'invalid_grant', error_description: 'the-code is bad' } }));
    const err: any = await google.handleCallback('the-code', state).catch(e => e);
    expect(err).toBeInstanceOf(GoogleError);
    expect(err.message).toBe('Google said no (400). The author may need to reconnect in Settings.');
    expect(err.message).not.toContain('the-code');

    routes.length = 0;
    on('https://oauth2.googleapis.com/token', () => ({ json: { access_token: ACCESS } }));
    state = new URL(await google.authUrl()).searchParams.get('state')!;
    await expect(google.handleCallback('the-code', state)).rejects.toThrow(/lasting access/);
    expect(vault.store.has('google_refresh_token')).toBe(false);
    expect(google.isConnected()).toBe(false);
  });

  it('disconnect revokes, clears the token and email; a second call clears the client too', async () => {
    await connected();
    on('https://oauth2.googleapis.com/revoke', () => ({ json: {} }));
    await google.disconnect();
    const revoke = calls.find(c => c.url.startsWith('https://oauth2.googleapis.com/revoke'))!;
    expect(revoke.url).toBe('https://oauth2.googleapis.com/revoke'); // token is in the body, not the URL
    expect(revoke.method).toBe('POST');
    expect(new URLSearchParams(revoke.body).get('token')).toBe(REFRESH);
    expect(vault.store.has('google_refresh_token')).toBe(false);
    expect(existsSync(join(dir, '.config', 'google.json'))).toBe(false);
    expect(await google.status()).toEqual({ configured: true, connected: false });
    expect(google.tools().every(t => t.available() === false)).toBe(true);

    await google.disconnect();
    expect(vault.store.size).toBe(0);
    expect(await google.status()).toEqual({ configured: false, connected: false });
  });

  it('disconnect still clears local state when the revoke call fails', async () => {
    await connected();
    on('https://oauth2.googleapis.com/revoke', () => { throw new Error('offline'); });
    await google.disconnect();
    expect(vault.store.has('google_refresh_token')).toBe(false);
    expect(google.isConnected()).toBe(false);
  });
});

describe('Google tokens', () => {
  it('refreshes once, caches the access token, and refreshes again after a 401', async () => {
    await connected();
    let driveCalls = 0;
    on('https://www.googleapis.com/drive/v3/files', () => (++driveCalls === 2 ? { status: 401 } : { json: { files: [] } }));
    await tool('drive_search').run({ query: 'a' });
    await tool('drive_search').run({ query: 'b' }); // 401 -> refresh -> retry
    const tokenCalls = calls.filter(c => c.url === 'https://oauth2.googleapis.com/token');
    expect(tokenCalls).toHaveLength(2);
    const body = new URLSearchParams(tokenCalls[0].body);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe(REFRESH);
    expect(body.get('client_id')).toBe(CLIENT_ID);
    expect(body.get('client_secret')).toBe(CLIENT_SECRET);
    expect(driveCalls).toBe(3);
    expect(apiCalls().every(c => c.headers.Authorization === `Bearer ${ACCESS}`)).toBe(true);
  });

  it('errors are short and generic and never contain secrets', async () => {
    await connected();
    on('https://www.googleapis.com/drive/v3/files', () => ({ status: 403, json: { error: { message: `bad token ${ACCESS}` } } }));
    const err: any = await tool('drive_search').run({ query: 'x' }).catch(e => e);
    expect(err.message).toBe('Google said no (403). The author may need to reconnect in Settings.');

    routes.length = 0;
    on('https://oauth2.googleapis.com/token', () => ({ status: 400, json: { error: 'invalid_grant' } }));
    const fresh = new GoogleService({ vault, workspaceDir: dir });
    await fresh.initialize();
    const err2: any = await fresh.driveSearch('x').catch(e => e);
    expect(err2.message).toBe('Google said no (400). The author may need to reconnect in Settings.');
    for (const s of [REFRESH, CLIENT_SECRET, ACCESS]) expect(err2.message).not.toContain(s);
  });

  it('tools are unavailable until connected, and refuse to run', async () => {
    expect(google.tools().map(t => t.name)).toEqual([
      'drive_search', 'doc_read', 'doc_create', 'doc_append', 'gmail_search', 'gmail_read', 'gmail_draft', 'calendar_upcoming',
    ]);
    expect(google.tools().map(t => t.risk)).toEqual(['read', 'read', 'write', 'write', 'read', 'read', 'write', 'read']);
    expect(google.tools().every(t => t.available() === false)).toBe(true);
    await expect(tool('drive_search').run({ query: 'x' })).rejects.toThrow(/not connected/);
    expect(calls).toHaveLength(0);
    await connected();
    expect(google.tools().every(t => t.available() === true)).toBe(true);
  });
});

describe('Google tools: request shapes', () => {
  beforeEach(connected);

  it('drive_search', async () => {
    on('https://www.googleapis.com/drive/v3/files', () => ({ json: { files: [
      { id: 'file_id_12345', name: 'Book 2 outline', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-01T10:00:00Z' },
    ] } }));
    const out = await tool('drive_search').run({ query: "Dana's \\ outline" });
    const u = new URL(apiCalls()[0].url);
    expect(u.origin + u.pathname).toBe('https://www.googleapis.com/drive/v3/files');
    expect(u.searchParams.get('q')).toBe("(fullText contains 'Dana\\'s \\\\ outline' or name contains 'Dana\\'s \\\\ outline') and trashed = false");
    expect(u.searchParams.get('pageSize')).toBe('10');
    expect(u.searchParams.get('fields')).toBe('files(id,name,mimeType,modifiedTime)');
    expect(apiCalls()[0].method).toBe('GET');
    expect(out).toBe('1. Book 2 outline | Google document | modified 2026-10-01 | id: file_id_12345');
  });

  it('doc_read: Google Docs are exported as text and cut at 6000 chars', async () => {
    on(/drive\/v3\/files\/doc_id_12345\?fields=/, () => ({ json: { id: 'doc_id_12345', name: 'Chapter 1', mimeType: 'application/vnd.google-apps.document' } }));
    on(/drive\/v3\/files\/doc_id_12345\/export/, () => ({ text: 'w'.repeat(7000) }));
    const out = await tool('doc_read').run({ id: 'doc_id_12345' });
    expect(apiCalls().map(c => c.url)).toEqual([
      'https://www.googleapis.com/drive/v3/files/doc_id_12345?fields=id,name,mimeType,size',
      'https://www.googleapis.com/drive/v3/files/doc_id_12345/export?mimeType=text%2Fplain',
    ]);
    expect(out.startsWith('Chapter 1\n\n')).toBe(true);
    expect(out).toContain('w'.repeat(6000));
    expect(out).not.toContain('w'.repeat(6001));
  });

  it('doc_read: plain text uses alt=media; other types are declined', async () => {
    on(/files\/text_id_12345\?fields=/, () => ({ json: { name: 'notes.txt', mimeType: 'text/plain', size: '12' } }));
    on(/files\/text_id_12345\?alt=media/, () => ({ text: 'plain notes' }));
    expect(await tool('doc_read').run({ id: 'text_id_12345' })).toBe('notes.txt\n\nplain notes');
    expect(apiCalls()[1].url).toBe('https://www.googleapis.com/drive/v3/files/text_id_12345?alt=media');

    on(/files\/pdf_id_123456\?fields=/, () => ({ json: { name: 'cover.pdf', mimeType: 'application/pdf' } }));
    expect(await tool('doc_read').run({ id: 'pdf_id_123456' })).toBe('Fibb cannot read this type of file (application/pdf): "cover.pdf".');
    expect(apiCalls()).toHaveLength(3);
  });

  it('ids are validated before any request', async () => {
    for (const id of ['abc', '../../etc', 'id with space', 'a/b/c/d/e', '', undefined, 12345]) {
      await expect(tool('doc_read').run({ id })).rejects.toThrow(/id does not look right/);
      await expect(tool('gmail_read').run({ id })).rejects.toThrow(/id does not look right/);
      await expect(tool('doc_append').run({ id, text: 'x' })).rejects.toThrow(/id does not look right/);
    }
    expect(calls).toHaveLength(0);
  });

  it('doc_create: creates, inserts the text, returns the URL', async () => {
    on('https://docs.googleapis.com/v1/documents', (c) => c.url.endsWith(':batchUpdate') ? { json: {} } : { json: { documentId: 'new_doc_12345' } });
    const t = tool('doc_create');
    expect(t.describe!({ title: 'Series  bible\nnotes', content: 'x' })).toBe('Create a Google Doc titled "Series bible notes"');
    const out = await t.run({ title: 'Series bible', content: 'Line one\nLine two' });
    const [create, update] = apiCalls();
    expect(create.url).toBe('https://docs.googleapis.com/v1/documents');
    expect(create.method).toBe('POST');
    expect(JSON.parse(create.body!)).toEqual({ title: 'Series bible' });
    expect(create.headers['Content-Type']).toBe('application/json');
    expect(update.url).toBe('https://docs.googleapis.com/v1/documents/new_doc_12345:batchUpdate');
    expect(JSON.parse(update.body!)).toEqual({ requests: [{ insertText: { location: { index: 1 }, text: 'Line one\nLine two' } }] });
    expect(out).toBe('Created the Google Doc "Series bible": https://docs.google.com/document/d/new_doc_12345/edit');
    expect(() => t.bind!({ title: '  ', content: 'x' })).toThrow(/needs a title/);
  });

  it('doc_append: inserts at the end', async () => {
    on('https://docs.googleapis.com/v1/documents', () => ({ json: {} }));
    const out = await tool('doc_append').run({ id: 'doc_id_12345', text: '\nMore.' });
    expect(apiCalls()[0].url).toBe('https://docs.googleapis.com/v1/documents/doc_id_12345:batchUpdate');
    expect(JSON.parse(apiCalls()[0].body!)).toEqual({ requests: [{ insertText: { endOfSegmentLocation: {}, text: '\nMore.' } }] });
    expect(out).toContain('https://docs.google.com/document/d/doc_id_12345/edit');
    expect(tool('doc_append').describe!({ id: 'doc_id_12345', text: 'abc' })).toMatch(/^Add 3 characters to the end of a Google Doc/);
  });

  it('gmail_search: lists then fetches metadata for each message', async () => {
    on(/gmail\/v1\/users\/me\/messages\?/, () => ({ json: { messages: [{ id: '18c2f0a1b2c3d4e5' }, { id: '18c2f0a1b2c3d4e6' }] } }));
    on(/gmail\/v1\/users\/me\/messages\/18c2/, (c) => ({ json: {
      snippet: 'Hi, the edits are attached',
      payload: { headers: [
        { name: 'From', value: 'Editor <ed@example.com>' }, { name: 'Subject', value: `Edits ${c.url.includes('e5') ? 'one' : 'two'}` },
        { name: 'Date', value: 'Mon, 9 Nov 2026 10:00:00 -0500' },
      ] },
    } }));
    const out = await tool('gmail_search').run({ query: 'from:editor newer_than:7d' });
    const list = new URL(apiCalls()[0].url);
    expect(list.origin + list.pathname).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    expect(list.searchParams.get('q')).toBe('from:editor newer_than:7d');
    expect(list.searchParams.get('maxResults')).toBe('10');
    expect(apiCalls()[1].url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/18c2f0a1b2c3d4e5?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date');
    expect(out).toContain('1. From: Editor <ed@example.com> | Subject: Edits one | Date: Mon, 9 Nov 2026 10:00:00 -0500');
    expect(out).toContain('Hi, the edits are attached');
    expect(out).toContain('id: 18c2f0a1b2c3d4e6');
  });

  it('gmail_read: decodes the text/plain part', async () => {
    const data = Buffer.from('Dear author,\nYour proofs are ready. ✓', 'utf8').toString('base64url');
    on(/gmail\/v1\/users\/me\/messages\/18c2f0a1b2c3d4e5/, () => ({ json: {
      snippet: 'Dear author',
      payload: {
        mimeType: 'multipart/alternative',
        headers: [{ name: 'From', value: 'ed@example.com' }, { name: 'Subject', value: 'Proofs' }, { name: 'Date', value: 'today' }],
        parts: [{ mimeType: 'text/html', body: { data: Buffer.from('<p>html</p>').toString('base64url') } }, { mimeType: 'text/plain', body: { data } }],
      },
    } }));
    const out = await tool('gmail_read').run({ id: '18c2f0a1b2c3d4e5' });
    expect(apiCalls()[0].url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/18c2f0a1b2c3d4e5?format=full');
    expect(out).toBe('From: ed@example.com\nSubject: Proofs\nDate: today\n\nDear author,\nYour proofs are ready. ✓');
  });

  it('gmail_draft: creates a DRAFT only', async () => {
    on('https://gmail.googleapis.com/gmail/v1/users/me/drafts', () => ({ json: { id: 'draft_1' } }));
    const t = tool('gmail_draft');
    expect(t.describe!({ to: 'x@y.com', subject: 'Launch plan', body: 'b' })).toBe('Save an email draft to x@y.com with subject "Launch plan"');
    const out = await t.run({ to: 'x@y.com', subject: 'Launch plan — café', body: 'Hello there.\nSecond line.' });
    expect(apiCalls()).toHaveLength(1);
    expect(apiCalls()[0].url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts');
    expect(apiCalls()[0].method).toBe('POST');
    const raw = Buffer.from(JSON.parse(apiCalls()[0].body!).message.raw, 'base64url').toString('utf8');
    const [headers, body] = raw.split('\r\n\r\n');
    expect(headers).toContain('To: x@y.com');
    expect(headers).toContain(`Subject: =?UTF-8?B?${Buffer.from('Launch plan — café').toString('base64')}?=`);
    expect(Buffer.from(body, 'base64').toString('utf8')).toBe('Hello there.\nSecond line.');
    expect(out).toBe('Saved a draft to x@y.com in Gmail Drafts. It has not been sent.');
  });

  it('gmail_draft: rejects bad recipients and header injection', async () => {
    const t = tool('gmail_draft');
    for (const to of ['not-an-email', '', 'a@b.com\r\nBcc: evil@example.com', 'Name <a@b.com>']) {
      await expect(t.run({ to, subject: 's', body: 'b' })).rejects.toThrow(/not a valid email/);
      expect(() => t.bind!({ to, subject: 's', body: 'b' })).toThrow(/not a valid email/);
    }
    expect(calls).toHaveLength(0);
    const raw = Buffer.from(buildRawEmail(['a@b.com'], 'Hi\r\nBcc: evil@example.com', 'x'), 'base64url').toString('utf8');
    expect(raw.split('\r\n\r\n')[0].split('\r\n')).toHaveLength(5);
    expect(raw).not.toMatch(/^Bcc:/m);
  });

  it('calendar_upcoming: primary calendar, default 7 days, max 30', async () => {
    on('https://www.googleapis.com/calendar/v3/calendars/primary/events', () => ({ json: { items: [
      { summary: 'Call with agent', start: { dateTime: '2026-11-12T15:00:00-05:00' }, location: 'Zoom' },
      { summary: 'Launch day', start: { date: '2026-11-20' } },
    ] } }));
    const span = (i: number) => {
      const p = new URL(apiCalls()[i].url).searchParams;
      return Math.round((Date.parse(p.get('timeMax')!) - Date.parse(p.get('timeMin')!)) / 86_400_000);
    };
    const out = await tool('calendar_upcoming').run({});
    await tool('calendar_upcoming').run({ days: 3 });
    await tool('calendar_upcoming').run({ days: 365 });
    await tool('calendar_upcoming').run({ days: 'soon' });
    const p = new URL(apiCalls()[0].url).searchParams;
    expect(p.get('singleEvents')).toBe('true');
    expect(p.get('orderBy')).toBe('startTime');
    expect([span(0), span(1), span(2), span(3)]).toEqual([7, 3, 30, 7]);
    expect(out).toBe('1. 2026-11-12T15:00:00-05:00 | Call with agent | Zoom\n2. 2026-11-20 | Launch day');
  });

  it('nothing ever calls a send endpoint', async () => {
    on('https://www.googleapis.com/drive/v3/files', () => ({ json: { files: [], name: 'n', mimeType: 'text/plain' }, text: 't' }));
    on('https://docs.googleapis.com/v1/documents', () => ({ json: { documentId: 'new_doc_12345' } }));
    on('https://gmail.googleapis.com/', () => ({ json: { messages: [{ id: '18c2f0a1b2c3d4e5' }], payload: { headers: [] } } }));
    on('https://www.googleapis.com/calendar/', () => ({ json: { items: [] } }));
    on('https://oauth2.googleapis.com/revoke', () => ({ json: {} }));
    const args: Record<string, any> = {
      drive_search: { query: 'send' }, doc_read: { id: 'doc_id_12345' }, doc_create: { title: 'send', content: 'send it' },
      doc_append: { id: 'doc_id_12345', text: 'send' }, gmail_search: { query: 'send' }, gmail_read: { id: '18c2f0a1b2c3d4e5' },
      gmail_draft: { to: 'x@y.com', subject: 'Please send', body: 'send this now' }, calendar_upcoming: { days: 7 },
    };
    for (const t of google.tools()) await t.run(args[t.name]);
    await google.disconnect();
    expect(calls.length).toBeGreaterThan(10);
    for (const c of calls) {
      expect(c.url).not.toContain('/send');
      expect(c.url).not.toMatch(/messages\/import|messages\/insert/);
    }
    const posts = calls.filter(c => c.method !== 'GET' && c.url.includes('gmail.googleapis.com'));
    expect(posts.map(c => c.url)).toEqual(['https://gmail.googleapis.com/gmail/v1/users/me/drafts']);
  });
});
