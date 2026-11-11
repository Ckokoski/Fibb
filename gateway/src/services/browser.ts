/**
 * Fibb's own browser (Fibb P4c).
 *
 * Drives the Edge or Chrome that is already installed (playwright-core, no
 * browser download) with a persistent profile in <workspace>/.browser, so the
 * author can sign in to sites once in a visible window and Fibb can read them
 * later. One context at a time: headless for tool use, visible when the
 * author opens it. playwright-core is imported lazily so the server starts
 * even when it is missing.
 *
 * Safety:
 *  - every URL passes checkUrl (http/https only, no credentials, no
 *    loopback/private/link-local/CGNAT/metadata targets, DNS-resolved);
 *  - requests made by pages are filtered through the same guard;
 *  - the final URL is re-checked after navigation and content from a blocked
 *    destination is never returned;
 *  - web_click / web_type are write tools (author approval), are bound to the
 *    page they were requested on, and web_type never fills password fields or
 *    submits a form.
 */
import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import { isIP } from 'net';
import { promises as dnsPromises } from 'dns';
import { logger } from './logger.js';
import type { Tool } from './tools/registry.js';

// ───────────────────────── URL guard ─────────────────────────

export type UrlCheck = { ok: true } | { ok: false; reason: string };
export type LookupFn = (hostname: string, options: { all: true }) => Promise<Array<{ address: string; family?: number }>>;

const defaultLookup: LookupFn = (hostname, options) => dnsPromises.lookup(hostname, options) as any;

function ipv4Blocked(ip: string): boolean {
  const p = ip.split('.').map(n => Number(n));
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = p;
  if (a === 0) return true;                               // "this" network
  if (a === 10) return true;                              // private
  if (a === 100 && b >= 64 && b <= 127) return true;      // CGNAT
  if (a === 127) return true;                             // loopback
  if (a === 169 && b === 254) return true;                // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;       // private
  if (a === 192 && b === 0 && c === 0) return true;       // IETF protocol assignments
  if (a === 192 && b === 168) return true;                // private
  if (a === 198 && (b === 18 || b === 19)) return true;   // benchmarking
  if (a >= 224) return true;                              // multicast + reserved + broadcast
  return false;
}

/** Parse an IPv6 literal into 8 16-bit groups, or null. */
function parseIpv6(input: string): number[] | null {
  let s = input;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // Dotted IPv4 tail (::ffff:1.2.3.4)
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const p = tail.split('.').map(n => Number(n));
    if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    s = s.slice(0, lastColon + 1) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':').map(h => (/^[0-9a-f]{1,4}$/i.test(h) ? parseInt(h, 16) : NaN)));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...rest].some(n => Number.isNaN(n))) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - rest.length;
  if (fill < 1) return null;
  return [...head, ...new Array(fill).fill(0), ...rest];
}

function ipv6Blocked(ip: string): boolean {
  const g = parseIpv6(ip);
  if (!g) return true;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (g.slice(0, 7).every(n => n === 0)) return true;                       // :: and ::1
  if (g.slice(0, 5).every(n => n === 0) && g[5] === 0xffff) return ipv4Blocked(v4(g[6], g[7])); // v4-mapped
  if (g.slice(0, 6).every(n => n === 0)) return ipv4Blocked(v4(g[6], g[7]));                     // v4-compatible
  if (g[0] === 0x64 && g[1] === 0xff9b) return ipv4Blocked(v4(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return ipv4Blocked(v4(g[1], g[2]));                  // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true;                              // unique local (incl. fd00:ec2::254)
  if ((g[0] & 0xffc0) === 0xfe80) return true;                              // link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true;                              // site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true;                              // multicast
  return false;
}

/** True when the IP literal is loopback / private / link-local / CGNAT / metadata / reserved. */
export function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return ipv4Blocked(ip);
  if (kind === 6) return ipv6Blocked(ip);
  return true;
}

const NOT_ALLOWED = 'That address is on a private or local network, which Fibb is not allowed to open.';

/**
 * Decide whether Fibb's browser may open a URL. Never throws.
 * `lookup` is injectable for tests; it defaults to dns.promises.lookup.
 */
export async function checkUrl(url: string, lookup: LookupFn = defaultLookup): Promise<UrlCheck> {
  let u: URL;
  try {
    u = new URL(String(url));
  } catch {
    return { ok: false, reason: 'That is not a valid web address.' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: 'Only http and https addresses can be opened.' };
  }
  if (u.username || u.password) {
    return { ok: false, reason: 'Addresses with a username or password in them cannot be opened.' };
  }
  let host = u.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.replace(/\.+$/, '');
  if (!host) return { ok: false, reason: 'That is not a valid web address.' };

  if (isIP(host)) {
    return isBlockedIp(host) ? { ok: false, reason: NOT_ALLOWED } : { ok: true };
  }
  if (
    host === 'localhost' || host.endsWith('.localhost') ||
    host.endsWith('.local') || host.endsWith('.internal')
  ) {
    return { ok: false, reason: NOT_ALLOWED };
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    return { ok: false, reason: 'That site could not be found.' };
  }
  if (!Array.isArray(addrs) || addrs.length === 0) {
    return { ok: false, reason: 'That site could not be found.' };
  }
  for (const a of addrs) {
    if (!a || typeof a.address !== 'string' || isBlockedIp(a.address)) {
      return { ok: false, reason: NOT_ALLOWED };
    }
  }
  return { ok: true };
}

// ───────────────────────── Browser plumbing ─────────────────────────

/** The small slice of Playwright's Page that Fibb uses (fakeable in tests). */
export interface PageLike {
  goto(url: string, opts?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  evaluate(expression: string): Promise<any>;
  locator(selector: string): {
    click(opts?: { timeout?: number }): Promise<void>;
    fill(text: string, opts?: { timeout?: number }): Promise<void>;
  };
  waitForLoadState?(state?: string, opts?: { timeout?: number }): Promise<void>;
  isClosed?(): boolean;
}

export interface ContextLike {
  pages(): PageLike[];
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
  on?(event: 'close', cb: () => void): unknown;
  route?(pattern: string, handler: (route: any) => unknown): Promise<unknown>;
}

export type BrowserChannel = 'msedge' | 'chrome';
export type BrowserLauncher = (userDataDir: string, opts: { channel: BrowserChannel; headless: boolean }) => Promise<ContextLike>;

export interface BrowserStatus {
  available: boolean;
  channel?: BrowserChannel;
  running: boolean;
  reason?: string;
}

const CHANNELS: BrowserChannel[] = ['msedge', 'chrome'];
const NAV_TIMEOUT_MS = 20_000;
const IDLE_MS = 5 * 60 * 1000;
const PAGE_TEXT_MAX = 6000;
const MAX_LINKS = 25;
const TYPE_MAX = 2000;
const TARGET = '[data-fibb-target="1"]';

const defaultLauncher: BrowserLauncher = async (userDataDir, opts) => {
  const mod: any = await import('playwright-core');
  const chromium = mod.chromium ?? mod.default?.chromium;
  return chromium.launchPersistentContext(userDataDir, { channel: opts.channel, headless: opts.headless }) as Promise<ContextLike>;
};

/** Cheap on-disk detection of an installed Edge / Chrome. */
export function detectInstalledChannel(): BrowserChannel | null {
  const env = process.env;
  const candidates: Record<BrowserChannel, string[]> = { msedge: [], chrome: [] };
  if (process.platform === 'win32') {
    const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean) as string[];
    for (const r of roots) {
      candidates.msedge.push(join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      candidates.chrome.push(join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.msedge.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    candidates.chrome.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    candidates.msedge.push('/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge');
    candidates.chrome.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome');
  }
  for (const ch of CHANNELS) {
    for (const p of candidates[ch]) {
      try { if (existsSync(p)) return ch; } catch { /* keep looking */ }
    }
  }
  return null;
}

// Page scripts are plain strings (not functions) so the TypeScript transform
// cannot inject helpers that do not exist inside the page.
const js = (body: string, arg: unknown) => `(function(a){${body}})(${JSON.stringify(arg)})`;

const EXTRACT_JS = `
  var clean = function(s){ return String(s || '').replace(/[ \\t\\r\\f\\v]+/g, ' ').replace(/ ?\\n[ \\n]*/g, '\\n').trim(); };
  var text = clean(document.body ? document.body.innerText : '').slice(0, a.maxText);
  var links = [], seen = {};
  var as = document.querySelectorAll('a[href]');
  for (var i = 0; i < as.length && links.length < a.maxLinks; i++) {
    var href = as[i].href || '';
    if (!/^https?:/i.test(href) || seen[href]) continue;
    var t = String(as[i].innerText || as[i].getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    if (!t) continue;
    seen[href] = 1;
    links.push({ text: t, href: href.slice(0, 300) });
  }
  return { text: text, links: links };
`;

const FIND_JS = `
  var text = String(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ');
  var lower = text.toLowerCase(), q = String(a.q).toLowerCase(), out = [], i = 0;
  while (out.length < a.max) {
    var at = lower.indexOf(q, i);
    if (at < 0) break;
    var s = Math.max(0, at - 200), e = Math.min(text.length, at + q.length + 200);
    out.push(text.slice(s, e).trim());
    i = e;
  }
  return out;
`;

const PAGE_HELPERS_JS = `
  var old = document.querySelectorAll('[data-fibb-target]');
  for (var o = 0; o < old.length; o++) old[o].removeAttribute('data-fibb-target');
  var visible = function(el){
    var r = el.getBoundingClientRect(), st = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  var norm = function(s){ return String(s || '').replace(/\\s+/g, ' ').trim(); };
`;

const MARK_CLICK_JS = PAGE_HELPERS_JS + `
  var q = norm(a.q).toLowerCase();
  var els = document.querySelectorAll('a[href], button, [role="button"], [role="link"], input[type="submit"], input[type="button"]');
  var name = function(el){ return norm(el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('title')); };
  var exact = null, partial = null;
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (!visible(el)) continue;
    var n = name(el).toLowerCase();
    if (!n) continue;
    if (n === q) { exact = el; break; }
    if (!partial && n.indexOf(q) >= 0) partial = el;
  }
  var hit = exact || partial;
  if (!hit) return null;
  hit.setAttribute('data-fibb-target', '1');
  return { name: name(hit).slice(0, 80) };
`;

const MARK_FIELD_JS = PAGE_HELPERS_JS + `
  var q = norm(a.q).toLowerCase();
  var skip = { hidden: 1, submit: 1, button: 1, checkbox: 1, radio: 1, file: 1, image: 1, reset: 1, range: 1, color: 1 };
  var els = document.querySelectorAll('input, textarea, [contenteditable="true"]');
  var labels = function(el){
    var out = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('name'), el.id];
    if (el.id) {
      var forLabels = document.querySelectorAll('label[for]');
      for (var j = 0; j < forLabels.length; j++) if (forLabels[j].htmlFor === el.id) out.push(forLabels[j].innerText);
    }
    var wrap = el.closest ? el.closest('label') : null;
    if (wrap) out.push(wrap.innerText);
    var res = [];
    for (var k = 0; k < out.length; k++) { var v = norm(out[k]).toLowerCase(); if (v) res.push(v); }
    return res;
  };
  var exact = null, partial = null;
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var type = String(el.getAttribute('type') || 'text').toLowerCase();
    if (skip[type] || !visible(el) || el.disabled || el.readOnly) continue;
    var ls = labels(el);
    for (var m = 0; m < ls.length; m++) {
      if (ls[m] === q) { exact = el; break; }
      if (!partial && ls[m].indexOf(q) >= 0) partial = el;
    }
    if (exact) break;
  }
  var hit = exact || partial;
  if (!hit) return null;
  var t = String(hit.getAttribute('type') || '').toLowerCase();
  var ac = String(hit.getAttribute('autocomplete') || '').toLowerCase();
  if (t === 'password' || /password|one-time-code|cc-/.test(ac)) return { refused: true };
  hit.setAttribute('data-fibb-target', '1');
  return { name: (labels(hit)[0] || 'field').slice(0, 80) };
`;

const SIGN_IN_YOURSELF = 'Fibb never types passwords or other sign-in secrets. The author must sign in themselves: Settings, then open Fibb\'s browser.';

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

function str(v: unknown, max: number): string {
  return (typeof v === 'string' ? v : '').slice(0, max);
}

function quote(v: unknown, max: number): string {
  const s = str(v, 2000).replace(/\s+/g, ' ').trim();
  return `"${s.length > max ? s.slice(0, max - 1) + '…' : s}"`;
}

export interface BrowserServiceOptions {
  workspaceDir: string;
  launcher?: BrowserLauncher;
  detect?: () => BrowserChannel | null;
  lookup?: LookupFn;
  idleMs?: number;
}

export class BrowserService {
  private profileDir: string;
  private launcher: BrowserLauncher;
  private detect: () => BrowserChannel | null;
  private lookup: LookupFn | undefined;
  private idleMs: number;

  private ctx: ContextLike | null = null;
  private visible = false;
  private goodChannel: BrowserChannel | null = null;
  private detected: { channel: BrowserChannel | null; at: number } | null = null;
  private launchError: string | null = null;
  private launchFailedAt = 0;
  private currentUrl = '';
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private guardCache = new Map<string, { ok: boolean; at: number }>();

  constructor(opts: BrowserServiceOptions) {
    this.profileDir = join(opts.workspaceDir, '.browser');
    this.launcher = opts.launcher ?? defaultLauncher;
    this.detect = opts.detect ?? detectInstalledChannel;
    this.lookup = opts.lookup;
    this.idleMs = opts.idleMs ?? IDLE_MS;
  }

  private check(url: string): Promise<UrlCheck> {
    return this.lookup ? checkUrl(url, this.lookup) : checkUrl(url);
  }

  /** One browser operation at a time. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  /** Never throws. Detection is cached (found: for good; not found: 60 s). */
  status(): BrowserStatus {
    try {
      const running = !!this.ctx;
      if (this.goodChannel) return { available: true, channel: this.goodChannel, running };
      const now = Date.now();
      if (!this.detected || (!this.detected.channel && now - this.detected.at > 60_000)) {
        let channel: BrowserChannel | null = null;
        try { channel = this.detect(); } catch { channel = null; }
        this.detected = { channel, at: now };
      }
      // A failed launch marks the browser unavailable for five minutes, then it may be tried again.
      const failedRecently = !!this.launchError && now - this.launchFailedAt < 5 * 60_000;
      if (this.detected.channel && !failedRecently) {
        return { available: true, channel: this.detected.channel, running };
      }
      return {
        available: false,
        running,
        reason: (failedRecently && this.launchError) || 'Microsoft Edge or Google Chrome needs to be installed for Fibb to browse.',
      };
    } catch {
      return { available: false, running: false, reason: 'The browser could not be checked.' };
    }
  }

  private touch(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    // A visible window belongs to the author (they may be mid sign-in); only
    // the headless context is closed for being idle.
    if (!this.ctx || this.visible) return;
    this.idleTimer = setTimeout(() => {
      this.close().catch(err => logger.debug('browser idle close failed', err));
    }, this.idleMs);
    if (typeof (this.idleTimer as any).unref === 'function') (this.idleTimer as any).unref();
  }

  private async launch(headless: boolean): Promise<ContextLike> {
    await mkdir(this.profileDir, { recursive: true });
    const order = this.goodChannel ? [this.goodChannel, ...CHANNELS.filter(c => c !== this.goodChannel)] : CHANNELS;
    let ctx: ContextLike | null = null;
    for (const channel of order) {
      try {
        ctx = await this.launcher(this.profileDir, { channel, headless });
        this.goodChannel = channel;
        this.launchError = null;
        break;
      } catch (err) {
        logger.debug(`browser launch failed for ${channel}`, err);
      }
    }
    if (!ctx) {
      this.launchError = 'Fibb could not start Microsoft Edge or Google Chrome.';
      this.launchFailedAt = Date.now();
      throw new Error(this.launchError);
    }
    const opened = ctx;
    try {
      opened.on?.('close', () => {
        if (this.ctx === opened) {
          this.ctx = null;
          this.visible = false;
          this.currentUrl = '';
          if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
        }
      });
      // Filter every request a page makes through the URL guard, so a page
      // cannot make the browser reach the local machine or network.
      await opened.route?.('**/*', async (route: any) => {
        try {
          const target = String(route.request().url());
          if (!/^https?:/i.test(target)) return await route.continue();
          return (await this.guardCached(target)) ? await route.continue() : await route.abort('blockedbyclient');
        } catch {
          try { await route.abort('blockedbyclient'); } catch { /* already handled */ }
        }
      });
    } catch (err) {
      logger.debug('browser guard setup failed', err);
      try { await opened.close(); } catch { /* ignore */ }
      throw new Error('Fibb could not start its browser safely.');
    }
    this.ctx = opened;
    this.visible = !headless;
    return opened;
  }

  private async guardCached(url: string): Promise<boolean> {
    const host = hostOf(url);
    const now = Date.now();
    const hit = this.guardCache.get(host);
    if (hit && now - hit.at < 60_000) {
      // Credentials in a URL are refused regardless of host.
      try { const u = new URL(url); if (u.username || u.password) return false; } catch { return false; }
      return hit.ok;
    }
    const r = await this.check(url);
    if (this.guardCache.size > 500) this.guardCache.clear();
    this.guardCache.set(host, { ok: r.ok, at: now });
    return r.ok;
  }

  private async page(): Promise<PageLike> {
    const ctx = this.ctx ?? await this.launch(true);
    const open = ctx.pages().filter(p => !p.isClosed?.());
    return open.length ? open[open.length - 1] : ctx.newPage();
  }

  /** The current page if a browser is running and showing a real page. */
  private livePage(): PageLike | null {
    if (!this.ctx) return null;
    const open = this.ctx.pages().filter(p => !p.isClosed?.());
    const p = open[open.length - 1];
    if (!p) return null;
    return /^https?:/i.test(p.url()) ? p : null;
  }

  /** Refuse to hand back anything from a destination the guard blocks. */
  private async assertAllowedPage(page: PageLike): Promise<string> {
    const finalUrl = page.url();
    const r = await this.check(finalUrl);
    if (!r.ok) {
      this.currentUrl = '';
      try { await page.goto('about:blank', { timeout: 5000 }); } catch { /* best effort */ }
      throw new Error('That page led somewhere Fibb is not allowed to read.');
    }
    this.currentUrl = finalUrl;
    return finalUrl;
  }

  private async snapshot(page: PageLike, maxText: number, withLinks: boolean): Promise<string> {
    const finalUrl = await this.assertAllowedPage(page);
    const title = String(await page.title().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);
    const data = (await page.evaluate(js(EXTRACT_JS, { maxText, maxLinks: withLinks ? MAX_LINKS : 0 }))) || {};
    const links: Array<{ text: string; href: string }> = Array.isArray(data.links) ? data.links.slice(0, MAX_LINKS) : [];
    const head = `Title: ${title || '(none)'}\nURL: ${finalUrl.slice(0, 500)}`;
    const linkBlock = links.length
      ? '\n\nLinks:\n' + links.map(l => `- ${str(l.text, 80)} -> ${str(l.href, 300)}`).join('\n')
      : '';
    // Keep the whole result inside the 6000-char tool budget without losing the links.
    const room = Math.max(1500, maxText - head.length - linkBlock.length - 4);
    const text = str(data.text, maxText).slice(0, room);
    return `${head}\n\n${text || '(The page has no readable text.)'}${linkBlock}`;
  }

  // ── Author-facing ──

  /** Open a visible window so the author can sign in to sites themselves. */
  async openForUser(url?: string): Promise<void> {
    const target = url && url !== 'about:blank' ? url : 'about:blank';
    if (target !== 'about:blank') {
      const r = await this.check(target);
      if (!r.ok) throw new Error(r.reason);
    }
    return this.exclusive(async () => {
      if (this.ctx && !this.visible) await this.closeNow();
      if (!this.ctx) await this.launch(false);
      this.touch();
      const page = await this.page();
      if (target !== 'about:blank') {
        await page.goto(target, { timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
        this.currentUrl = page.url();
      }
    });
  }

  private async closeNow(): Promise<void> {
    const ctx = this.ctx;
    this.ctx = null;
    this.visible = false;
    this.currentUrl = '';
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (ctx) {
      try { await ctx.close(); } catch (err) { logger.debug('browser close failed', err); }
    }
  }

  async close(): Promise<void> {
    return this.exclusive(() => this.closeNow());
  }

  // ── Tool operations ──

  async open(url: string): Promise<string> {
    const r = await this.check(url);
    if (!r.ok) throw new Error(r.reason);
    return this.exclusive(async () => {
      const page = await this.page();
      try {
        await page.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
        return await this.snapshot(page, PAGE_TEXT_MAX, true);
      } finally {
        this.touch();
      }
    });
  }

  async find(text: string): Promise<string> {
    const q = text.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!q) throw new Error('Say what text to look for.');
    return this.exclusive(async () => {
      const page = this.livePage();
      if (!page) throw new Error('No page is open. Use web_open first.');
      try {
        await this.assertAllowedPage(page);
        const hits: string[] = (await page.evaluate(js(FIND_JS, { q, max: 5 }))) || [];
        if (!Array.isArray(hits) || hits.length === 0) return `"${q}" does not appear on this page.`;
        return hits.map((h, i) => `${i + 1}. …${str(h, 500)}…`).join('\n');
      } finally {
        this.touch();
      }
    });
  }

  /** Return to the page an approved action was requested on. */
  private async pageFor(boundUrl: string): Promise<PageLike> {
    let page = this.livePage();
    if (!page) {
      if (!boundUrl) throw new Error('No page is open. Ask Fibb to open the page again.');
      const r = await this.check(boundUrl);
      if (!r.ok) throw new Error(r.reason);
      page = await this.page();
      await page.goto(boundUrl, { timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
    }
    await this.assertAllowedPage(page);
    if (boundUrl && hostOf(page.url()) !== hostOf(boundUrl)) {
      throw new Error('The page has changed since this was approved. Ask Fibb again.');
    }
    return page;
  }

  async click(text: string, boundUrl = ''): Promise<string> {
    const q = text.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!q) throw new Error('Say what to click.');
    return this.exclusive(async () => {
      try {
        const page = await this.pageFor(boundUrl);
        const hit = await page.evaluate(js(MARK_CLICK_JS, { q }));
        if (!hit) throw new Error(`There is no visible link or button called "${q}" on this page.`);
        await page.locator(TARGET).click({ timeout: 5000 });
        try { await page.waitForLoadState?.('domcontentloaded', { timeout: 10_000 }); } catch { /* slow page */ }
        const snap = await this.snapshot(page, 2000, false);
        return `Clicked "${str(hit.name, 80)}" on ${hostOf(boundUrl || page.url())}.\n\n${snap}`;
      } finally {
        this.touch();
      }
    });
  }

  async type(field: string, text: string, boundUrl = ''): Promise<string> {
    const q = field.replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!q) throw new Error('Say which field to type into.');
    if (text.length > TYPE_MAX) throw new Error(`That is too much text to type at once (max ${TYPE_MAX} characters).`);
    return this.exclusive(async () => {
      try {
        const page = await this.pageFor(boundUrl);
        const hit = await page.evaluate(js(MARK_FIELD_JS, { q }));
        if (!hit) throw new Error(`There is no field called "${q}" on this page.`);
        if (hit.refused) throw new Error(SIGN_IN_YOURSELF);
        await page.locator(TARGET).fill(text, { timeout: 5000 });
        return `Typed into "${str(hit.name, 80)}" on ${hostOf(page.url())}. Nothing was submitted.`;
      } finally {
        this.touch();
      }
    });
  }

  /** The four browser tools. */
  tools(): Tool[] {
    const available = () => this.status().available;
    const needPage = () => {
      if (!this.currentUrl) throw new Error('No page is open. Use web_open first.');
      return this.currentUrl;
    };
    return [
      {
        name: 'web_open',
        description: 'Open a web page in Fibb\'s browser and read its title, text and links.',
        args: '{"url": "https://..."}',
        risk: 'read',
        summary: 'Reading a web page…',
        available,
        run: async (a) => this.open(str(a.url, 2000)),
      },
      {
        name: 'web_find',
        description: 'Find passages containing some text on the page that is currently open.',
        args: '{"text": "words to find"}',
        risk: 'read',
        summary: 'Looking through the page…',
        available,
        run: async (a) => this.find(str(a.text, 500)),
      },
      {
        name: 'web_click',
        description: 'Click a link or button on the open page, by its visible text.',
        args: '{"text": "link or button text"}',
        risk: 'write',
        summary: 'Clicking on the page…',
        available,
        describe: (a) => `Click ${quote(a.text, 60)} on ${hostOf(this.currentUrl) || 'the open page'}`,
        bind: (a) => {
          const text = str(a.text, 200).trim();
          if (!text) throw new Error('Say what to click.');
          return { text, _url: needPage() };
        },
        run: async (a) => this.click(str(a.text, 200), str(a._url, 2000)),
      },
      {
        name: 'web_type',
        description: 'Type text into a field on the open page (by its label). Never submits; never passwords.',
        args: '{"field": "field label", "text": "what to type"}',
        risk: 'write',
        summary: 'Typing on the page…',
        available,
        describe: (a) => `Type ${quote(a.text, 60)} into ${quote(a.field, 40)} on ${hostOf(this.currentUrl) || 'the open page'}`,
        bind: (a) => {
          const field = str(a.field, 100);
          if (/pass(word|code|phrase)?\b|\bpin\b|\botp\b|cvv|cvc|card\s*number|security\s*code/i.test(field)) {
            throw new Error(SIGN_IN_YOURSELF);
          }
          if (typeof a.text !== 'string') throw new Error('Say what to type.');
          if (a.text.length > TYPE_MAX) throw new Error(`That is too much text to type at once (max ${TYPE_MAX} characters).`);
          return { field, text: a.text, _url: needPage() };
        },
        run: async (a) => this.type(str(a.field, 100), str(a.text, TYPE_MAX + 1), str(a._url, 2000)),
      },
    ];
  }
}
