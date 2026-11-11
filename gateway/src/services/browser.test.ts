import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BrowserService, checkUrl, isBlockedIp, type LookupFn, type BrowserChannel } from './browser.js';

// DNS is stubbed everywhere: no test touches the network or a real browser.
const DNS: Record<string, string[]> = {
  'example.com': ['93.184.216.34'],
  'kdp.amazon.com': ['52.94.236.248'],
  'v6.example.com': ['2606:2800:220:1:248:1893:25c8:1946'],
  'evil.example.com': ['10.0.0.5'],
  'mixed.example.com': ['93.184.216.34', '127.0.0.1'],
  'meta.example.com': ['169.254.169.254'],
  'v6local.example.com': ['fd12:3456:789a::1'],
  'mapped.example.com': ['::ffff:192.168.1.10'],
};
const lookup: LookupFn = async (host) => {
  const a = DNS[host];
  if (!a) throw new Error('ENOTFOUND');
  return a.map(address => ({ address }));
};

describe('checkUrl', () => {
  const allowed = [
    'https://example.com/',
    'http://example.com:8080/path?q=1',
    'https://v6.example.com/',
    'https://93.184.216.34/',
    'https://[2606:2800:220:1:248:1893:25c8:1946]/',
    'https://172.32.0.1/',
    'https://100.128.0.1/',
  ];
  const blocked: Array<[string, RegExp]> = [
    ['not a url', /not a valid/],
    ['file:///etc/passwd', /Only http and https/],
    ['ftp://example.com/', /Only http and https/],
    ['javascript:alert(1)', /Only http and https/],
    ['chrome://settings', /Only http and https/],
    ['about:blank', /Only http and https/],
    ['https://user:pass@example.com/', /username or password/],
    ['https://user@example.com/', /username or password/],
    ['http://localhost:3847/api/vault', /private or local/],
    ['http://LOCALHOST/', /private or local/],
    ['http://app.localhost/', /private or local/],
    ['http://localhost./', /private or local/],
    ['http://printer.local/', /private or local/],
    ['http://db.corp.internal/', /private or local/],
    ['http://metadata.google.internal/', /private or local/],
    ['http://127.0.0.1/', /private or local/],
    ['http://127.1.2.3:3847/', /private or local/],
    ['http://2130706433/', /private or local/],       // decimal form of 127.0.0.1
    ['http://0x7f.0.0.1/', /private or local/],        // hex form
    ['http://0.0.0.0/', /private or local/],
    ['http://10.1.2.3/', /private or local/],
    ['http://172.16.0.1/', /private or local/],
    ['http://172.31.255.255/', /private or local/],
    ['http://192.168.0.1/', /private or local/],
    ['http://169.254.169.254/latest/meta-data/', /private or local/],
    ['http://100.64.0.1/', /private or local/],
    ['http://100.127.255.254/', /private or local/],
    ['http://224.0.0.1/', /private or local/],
    ['http://255.255.255.255/', /private or local/],
    ['http://[::1]/', /private or local/],
    ['http://[::]/', /private or local/],
    ['http://[fe80::1]/', /private or local/],
    ['http://[fc00::1]/', /private or local/],
    ['http://[fd00:ec2::254]/', /private or local/],
    ['http://[::ffff:127.0.0.1]/', /private or local/],
    ['http://[::ffff:10.0.0.1]/', /private or local/],
    ['http://[64:ff9b::7f00:1]/', /private or local/],
    ['http://[ff02::1]/', /private or local/],
    ['https://evil.example.com/', /private or local/],
    ['https://mixed.example.com/', /private or local/],
    ['https://meta.example.com/', /private or local/],
    ['https://v6local.example.com/', /private or local/],
    ['https://mapped.example.com/', /private or local/],
    ['https://does-not-exist.example/', /could not be found/],
  ];
  it.each(allowed)('allows %s', async (url) => {
    expect(await checkUrl(url, lookup)).toEqual({ ok: true });
  });
  it.each(blocked)('blocks %s', async (url, reason) => {
    const r = await checkUrl(url, lookup);
    expect(r.ok).toBe(false);
    expect((r as any).reason).toMatch(reason);
  });
  it('never throws on odd input', async () => {
    expect((await checkUrl(undefined as any, lookup)).ok).toBe(false);
    expect((await checkUrl('', lookup)).ok).toBe(false);
    expect((await checkUrl('https://empty.example.com/', async () => [])).ok).toBe(false);
  });
  it('isBlockedIp treats non-IPs as blocked', () => {
    expect(isBlockedIp('example.com')).toBe(true);
    expect(isBlockedIp('8.8.8.8')).toBe(false);
    expect(isBlockedIp('2001:4860:4860::8888')).toBe(false);
  });
});

// ── A fake browser: pages are plain objects, navigation is a lookup table. ──
interface FakeSite { title: string; text: string; links?: Array<{ text: string; href: string }>; redirect?: string; buttons?: Record<string, string>; fields?: Record<string, 'text' | 'password'> }

function fakeBrowser(sites: Record<string, FakeSite>) {
  const log = { launches: [] as Array<{ dir: string; channel: BrowserChannel; headless: boolean }>, closed: 0, clicks: 0, fills: [] as string[], routes: 0 };
  let failChannels: BrowserChannel[] = [];
  const launcher = async (dir: string, opts: { channel: BrowserChannel; headless: boolean }) => {
    if (failChannels.includes(opts.channel)) throw new Error(`no ${opts.channel}`);
    log.launches.push({ dir, ...opts });
    let url = 'about:blank';
    let marked: { kind: 'click' | 'field'; key: string } | null = null;
    const site = () => sites[url];
    const page = {
      goto: async (u: string) => { url = sites[u]?.redirect ?? u; },
      url: () => url,
      title: async () => site()?.title ?? '',
      evaluate: async (expr: string) => {
        const arg = JSON.parse(expr.slice(expr.lastIndexOf('})(') + 3, -1));
        if ('maxText' in arg) return { text: (site()?.text ?? '').slice(0, arg.maxText), links: (site()?.links ?? []).slice(0, arg.maxLinks) };
        if ('max' in arg) return (site()?.text ?? '').toLowerCase().includes(arg.q.toLowerCase()) ? [site()!.text] : [];
        if (expr.includes('role="button"')) {
          const key = Object.keys(site()?.buttons ?? {}).find(b => b.toLowerCase().includes(arg.q.toLowerCase()));
          if (!key) return null;
          marked = { kind: 'click', key };
          return { name: key };
        }
        const key = Object.keys(site()?.fields ?? {}).find(f => f.toLowerCase().includes(arg.q.toLowerCase()));
        if (!key) return null;
        if (site()!.fields![key] === 'password') return { refused: true };
        marked = { kind: 'field', key };
        return { name: key };
      },
      locator: () => ({
        click: async () => { log.clicks++; if (marked?.kind === 'click') url = site()!.buttons![marked.key]; },
        fill: async (text: string) => { log.fills.push(text); },
      }),
      waitForLoadState: async () => {},
      isClosed: () => false,
    };
    return {
      pages: () => [page],
      newPage: async () => page,
      close: async () => { log.closed++; },
      on: () => {},
      route: async () => { log.routes++; },
    };
  };
  return { launcher, log, fail: (c: BrowserChannel[]) => { failChannels = c; } };
}

const SITES: Record<string, FakeSite> = {
  'https://example.com/': {
    title: 'Example Domain', text: 'This domain is for use in examples.',
    links: [{ text: 'More information', href: 'https://example.com/more' }],
    buttons: { 'More information': 'https://kdp.amazon.com/' },
  },
  'https://kdp.amazon.com/': {
    title: 'KDP', text: 'Bookshelf. ' + 'x'.repeat(5000),
    buttons: { Publish: 'https://kdp.amazon.com/' }, fields: { Title: 'text', Password: 'password' },
  },
  'https://example.com/sneaky': { title: 'x', text: 'x', redirect: 'http://127.0.0.1:3847/api/vault' },
};

let dir: string;
let fb: ReturnType<typeof fakeBrowser>;
let browser: BrowserService;
const toolMap = () => Object.fromEntries(browser.tools().map(t => [t.name, t]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fibb-browser-'));
  fb = fakeBrowser(SITES);
  browser = new BrowserService({ workspaceDir: dir, launcher: fb.launcher, detect: () => 'msedge', lookup });
});
afterEach(async () => { await browser.close(); rmSync(dir, { recursive: true, force: true }); });

describe('BrowserService', () => {
  it('status reports availability without launching, and never throws', () => {
    expect(browser.status()).toEqual({ available: true, channel: 'msedge', running: false });
    const none = new BrowserService({ workspaceDir: dir, launcher: fb.launcher, detect: () => null });
    expect(none.status()).toMatchObject({ available: false, running: false });
    expect(none.status().reason).toMatch(/Edge or Google Chrome/);
    const broken = new BrowserService({ workspaceDir: dir, launcher: fb.launcher, detect: () => { throw new Error('x'); } });
    expect(broken.status().available).toBe(false);
    expect(fb.log.launches).toHaveLength(0);
  });

  it('web_open launches headless in <workspace>/.browser and returns title, URL, text and links', async () => {
    const out = await toolMap().web_open.run({ url: 'https://example.com/' });
    expect(fb.log.launches).toEqual([{ dir: join(dir, '.browser'), channel: 'msedge', headless: true }]);
    expect(fb.log.routes).toBe(1);
    expect(out).toContain('Title: Example Domain');
    expect(out).toContain('URL: https://example.com/');
    expect(out).toContain('This domain is for use in examples.');
    expect(out).toContain('- More information -> https://example.com/more');
    expect(browser.status().running).toBe(true);
    // Second call reuses the same context.
    await toolMap().web_open.run({ url: 'https://kdp.amazon.com/' });
    expect(fb.log.launches).toHaveLength(1);
  });

  it('falls back from msedge to chrome', async () => {
    fb.fail(['msedge']);
    await toolMap().web_open.run({ url: 'https://example.com/' });
    expect(fb.log.launches[0].channel).toBe('chrome');
    expect(browser.status()).toMatchObject({ available: true, channel: 'chrome', running: true });
  });

  it('reports unavailable after both channels fail to launch', async () => {
    fb.fail(['msedge', 'chrome']);
    await expect(toolMap().web_open.run({ url: 'https://example.com/' })).rejects.toThrow(/could not start/);
    expect(browser.status()).toMatchObject({ available: false, running: false });
  });

  it('web_open refuses blocked URLs before launching anything', async () => {
    for (const url of ['http://localhost:3847/', 'file:///c:/x', 'https://evil.example.com/', 'https://u:p@example.com/']) {
      await expect(toolMap().web_open.run({ url })).rejects.toThrow();
    }
    expect(fb.log.launches).toHaveLength(0);
  });

  it('refuses to return content when navigation ends on a blocked destination', async () => {
    await expect(toolMap().web_open.run({ url: 'https://example.com/sneaky' })).rejects.toThrow(/not allowed to read/);
    await expect(toolMap().web_find.run({ text: 'x' })).rejects.toThrow(/No page is open/);
  });

  it('web_find returns passages from the current page', async () => {
    await expect(toolMap().web_find.run({ text: 'domain' })).rejects.toThrow(/No page is open/);
    await toolMap().web_open.run({ url: 'https://example.com/' });
    expect(await toolMap().web_find.run({ text: 'DOMAIN' })).toContain('This domain is for use');
    expect(await toolMap().web_find.run({ text: 'zebra' })).toBe('"zebra" does not appear on this page.');
  });

  it('web_click and web_type are write tools with clear descriptions bound to the open page', async () => {
    const t = toolMap();
    expect(t.web_open.risk).toBe('read');
    expect(t.web_find.risk).toBe('read');
    expect(t.web_click.risk).toBe('write');
    expect(t.web_type.risk).toBe('write');
    expect(() => t.web_click.bind!({ text: 'Publish' })).toThrow(/No page is open/);
    await t.web_open.run({ url: 'https://kdp.amazon.com/' });
    expect(t.web_click.describe!({ text: 'Publish' })).toBe('Click "Publish" on kdp.amazon.com');
    expect(t.web_click.bind!({ text: 'Publish' })).toEqual({ text: 'Publish', _url: 'https://kdp.amazon.com/' });
    const long = 'A'.repeat(300);
    const d = t.web_type.describe!({ field: 'Title', text: long });
    expect(d).toMatch(/^Type "A{59}…" into "Title" on kdp\.amazon\.com$/);
    expect(t.web_type.bind!({ field: 'Title', text: 'My Book' })).toEqual({ field: 'Title', text: 'My Book', _url: 'https://kdp.amazon.com/' });
  });

  it('web_click clicks and returns the new page, capped at 2000 chars of text', async () => {
    const t = toolMap();
    await t.web_open.run({ url: 'https://example.com/' });
    const out = await t.web_click.run(t.web_click.bind!({ text: 'more information' }));
    expect(fb.log.clicks).toBe(1);
    expect(out.split('\n')[0]).toBe('Clicked "More information" on example.com.');
    expect(out).toContain('Title: KDP');
    expect(out).toContain('URL: https://kdp.amazon.com/');
    expect(out).toContain('x'.repeat(1900));
    expect(out).not.toContain('x'.repeat(2001));
    await expect(t.web_click.run({ text: 'Nope', _url: 'https://kdp.amazon.com/' })).rejects.toThrow(/no visible link or button/);
  });

  it('an approved click reopens its page if the browser closed, and refuses if the page changed', async () => {
    const t = toolMap();
    await t.web_open.run({ url: 'https://kdp.amazon.com/' });
    const bound = t.web_click.bind!({ text: 'Publish' });
    await browser.close();
    expect(await t.web_click.run(bound)).toContain('Clicked "Publish" on kdp.amazon.com.');
    await t.web_open.run({ url: 'https://example.com/' });
    await expect(t.web_click.run(bound)).rejects.toThrow(/page has changed/);
    expect(fb.log.clicks).toBe(1);
  });

  it('web_type fills a field, never submits, and never types into password fields', async () => {
    const t = toolMap();
    await t.web_open.run({ url: 'https://kdp.amazon.com/' });
    expect(await t.web_type.run(t.web_type.bind!({ field: 'title', text: 'My Book' })))
      .toBe('Typed into "Title" on kdp.amazon.com. Nothing was submitted.');
    expect(fb.log.fills).toEqual(['My Book']);
    expect(fb.log.clicks).toBe(0);
    // Refused before an approval is even created...
    expect(() => t.web_type.bind!({ field: 'Password', text: 'hunter2' })).toThrow(/never types passwords/);
    // ...and again at the page, whatever the field was called.
    await expect(t.web_type.run({ field: 'Password', text: 'hunter2', _url: 'https://kdp.amazon.com/' })).rejects.toThrow(/sign in themselves/);
    expect(fb.log.fills).toEqual(['My Book']);
  });

  it('openForUser replaces a headless context with a visible window; tools then reuse it', async () => {
    await toolMap().web_open.run({ url: 'https://example.com/' });
    await browser.openForUser('https://kdp.amazon.com/');
    expect(fb.log.closed).toBe(1);
    expect(fb.log.launches.map(l => l.headless)).toEqual([true, false]);
    await toolMap().web_open.run({ url: 'https://example.com/' });
    expect(fb.log.launches).toHaveLength(2);
    await browser.openForUser();
    expect(fb.log.launches).toHaveLength(2);
    await expect(browser.openForUser('http://127.0.0.1:3847/')).rejects.toThrow(/private or local/);
    await browser.close();
    expect(browser.status().running).toBe(false);
    expect(fb.log.closed).toBe(2);
  });

  it('closes an idle headless context, but not a visible window', async () => {
    const quick = new BrowserService({ workspaceDir: dir, launcher: fb.launcher, detect: () => 'msedge', lookup, idleMs: 30 });
    const open = quick.tools().find(t => t.name === 'web_open')!;
    await open.run({ url: 'https://example.com/' });
    expect(quick.status().running).toBe(true);
    await new Promise(r => setTimeout(r, 120));
    expect(quick.status().running).toBe(false);
    await quick.openForUser();
    await new Promise(r => setTimeout(r, 120));
    expect(quick.status().running).toBe(true);
    await quick.close();
  });
});
