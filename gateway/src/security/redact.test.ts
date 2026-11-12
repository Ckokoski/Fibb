import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { redactSecrets, redactDeep, scrubErrorText, createErrorScrubber, createErrorHandler } from './redact.js';
import { AuditLog } from './audit.js';

// Fake credentials, built at runtime so no scanner mistakes them for real ones.
const OPENAI = 'sk-' + 'proj-' + 'a1B2c3D4e5F6g7H8i9J0k1L2';
const GEMINI = 'AIza' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q';
const TELEGRAM = '123456789:' + 'AAH' + 'x'.repeat(32);
const REFRESH = '1//' + '0gAbCdEfGhIjKlMnOpQrStUvWxYz';
const ACCESS = 'ya29.' + 'a0AfH6SMBx-abcdefghij';
const CLIENT_SECRET = 'GOCSPX-' + 'abcdefGHIJKL123456';

describe('redactSecrets', () => {
  it('masks credential-shaped values wherever they appear', () => {
    for (const secret of [OPENAI, GEMINI, TELEGRAM, REFRESH, ACCESS, CLIENT_SECRET]) {
      const out = redactSecrets(`request failed for ${secret} (retrying)`);
      expect(out).not.toContain(secret);
      expect(out).toContain('[REDACTED]');
      expect(out).toContain('request failed for');
    }
  });
  it('masks labelled values, bearer headers, OAuth codes and bot-token URLs', () => {
    expect(redactSecrets('Authorization: Bearer abc.def.ghi-123456')).not.toContain('abc.def');
    expect(redactSecrets('{"refresh_token":"zzzzzzzzzzzz","scope":"x"}')).toBe('{"refresh_token":"[REDACTED]","scope":"x"}');
    expect(redactSecrets('client_secret=hunter2hunter2&grant_type=x')).toBe('client_secret=[REDACTED]&grant_type=x');
    expect(redactSecrets('GET /api/google/callback?code=abcdef123456&state=s1')).toBe('GET /api/google/callback?code=[REDACTED]&state=s1');
    expect(redactSecrets(`https://api.telegram.org/bot${TELEGRAM}/getMe`)).not.toContain(TELEGRAM);
    expect(redactSecrets('password: correct-horse-battery')).toBe('password: [REDACTED]');
  });
  it('leaves ordinary text alone', () => {
    const plain = 'Chapter 4: the code word was "tokens", error code ECONNREFUSED at 12:30, 1500 tokens used.';
    expect(redactSecrets(plain)).toBe(plain);
    expect(redactSecrets('')).toBe('');
    expect(redactSecrets(undefined as any)).toBe('');
  });
});

describe('redactDeep', () => {
  it('masks by key name and by value shape, keeps everything else', () => {
    const out: any = redactDeep({
      key: 'gemini_api_key', tokens: 1500, channel: 'webchat',
      token: 'whatever-it-is', headers: { Authorization: 'Bearer x', accept: 'json' },
      error: `401 for ${OPENAI}`, list: [GEMINI, 'ok'], empty: { password: '' },
    });
    expect(out).toEqual({
      key: 'gemini_api_key', tokens: 1500, channel: 'webchat',
      token: '[REDACTED]', headers: { Authorization: '[REDACTED]', accept: 'json' },
      error: '401 for [REDACTED]', list: ['[REDACTED]', 'ok'], empty: { password: '' },
    });
  });
  it('the audit log never writes a credential, whatever a caller passes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fibb-audit-'));
    try {
      const audit = new AuditLog(dir);
      await audit.initialize();
      await audit.log('error', 'ai_completion_failed', { provider: 'openai', error: `Error: 401 Incorrect API key provided: ${OPENAI}` });
      await audit.log('vault', 'key_stored', { key: 'openai_api_key', value: undefined, token: TELEGRAM });
      const text = readdirSync(dir).map(f => readFileSync(join(dir, f), 'utf-8')).join('\n');
      expect(text).toContain('ai_completion_failed');
      expect(text).toContain('openai_api_key');
      expect(text).not.toContain(OPENAI);
      expect(text).not.toContain(TELEGRAM);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('scrubErrorText', () => {
  it('removes stack traces, file paths and secrets', () => {
    const err = "ENOENT: no such file or directory, open 'C:\\Users\\chris\\OneDrive\\Documents\\Automations\\AuthorClaw\\authorclaw\\workspace\\x.json'\n    at Object.openSync (node:fs:573:18)\n    at readFileSync (node:fs:452:35)";
    const out = scrubErrorText(err);
    expect(out).toBe("ENOENT: no such file or directory, open '[path]'");
    expect(scrubErrorText('cannot read /home/chris/.authorclaw/vault.key now')).toBe('cannot read [path] now');
    expect(scrubErrorText(`bad key ${GEMINI}`)).toBe('bad key [REDACTED]');
  });
  it('keeps ordinary messages and web addresses, and caps the length', () => {
    expect(scrubErrorText('title is required')).toBe('title is required');
    expect(scrubErrorText('Route not found: GET /api/nope')).toBe('Route not found: GET /api/nope');
    expect(scrubErrorText('Could not reach https://example.com/home/page')).toBe('Could not reach https://example.com/home/page');
    expect(scrubErrorText('x'.repeat(2000)).length).toBe(500);
  });
});

describe('error middleware', () => {
  const makeRes = () => {
    const res: any = { statusCode: 200, sent: undefined, headersSent: false };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: any) => { res.sent = b; return res; };
    return res;
  };
  afterEach(() => {});

  it('scrubs error bodies on their way out and leaves successes untouched', () => {
    const res = makeRes();
    createErrorScrubber()({}, res, () => {});
    res.status(500).json({ error: 'Error: EACCES: permission denied, open \'C:\\Users\\chris\\secret\\vault.enc\'\n    at foo (bar.js:1:1)', stack: 'x', ok: false });
    expect(res.sent).toEqual({ error: "Error: EACCES: permission denied, open '[path]'", ok: false });

    const ok = makeRes();
    createErrorScrubber()({}, ok, () => {});
    const body = { path: 'C:\\Users\\chris\\book.docx', message: 'saved' };
    ok.json(body);
    expect(ok.sent).toBe(body);
  });

  it('the final handler never returns the raw error', () => {
    const logged: any[] = [];
    const handler = createErrorHandler((m, e) => logged.push([m, e]));
    const res = makeRes();
    handler(new Error(`boom at C:\\Users\\chris\\x.ts with ${OPENAI}`), {}, res, () => {});
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.sent)).not.toMatch(/boom|chris|sk-/);
    expect(logged).toHaveLength(1);
    expect(String(logged[0][1])).toContain('boom');
    expect(String(logged[0][1])).not.toContain(OPENAI);
  });

  it('client errors keep their status with a fixed message', () => {
    const handler = createErrorHandler(() => {});
    const bad = makeRes();
    handler(Object.assign(new SyntaxError('Unexpected token } in JSON at position 5'), { status: 400, type: 'entity.parse.failed' }), {}, bad, () => {});
    expect(bad.statusCode).toBe(400);
    expect(bad.sent).toEqual({ error: 'The request body is not valid JSON.' });
    const big = makeRes();
    handler(Object.assign(new Error('request entity too large'), { status: 413 }), {}, big, () => {});
    expect(big.statusCode).toBe(413);
    expect(big.sent).toEqual({ error: 'That request is too large.' });
    const sent = makeRes();
    sent.headersSent = true;
    handler(new Error('late'), {}, sent, () => {});
    expect(sent.sent).toBeUndefined();
  });
});
