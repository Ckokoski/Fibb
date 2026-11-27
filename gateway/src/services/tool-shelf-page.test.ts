import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ToolShelf, buildToolPrompt, parseDraft, inferKind, hardenPage,
  PAGE_CSP, PAGE_CSP_META, PAGE_CSP_HEADER, SPRINT_TIMER_EXAMPLE,
} from './tool-shelf.js';
import {
  checkTool, REASONS as R, LIMITS, TOOL_KINDS, PAGE_TAGS, PAGE_CREATE_ELEMENTS, PAGE_ATTRS, FORBIDDEN_NAMES,
} from './tool-shelf-check.js';

const HEAD = '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Test page</title>\n';
/** A whole page around some markup, a script and extra head content. */
const page = (body = '<main><h1>Hello</h1></main>', script = '', head = '') =>
  `<!doctype html>\n<html lang="en">\n<head>\n${HEAD}${head}</head>\n<body>\n${body}\n<script>\n${script}\n</script>\n</body>\n</html>`;
const check = (html: string) => checkTool('page', [{ path: 'page.html', content: html }]);

const NAME_TRACKER = page(
  `<main class="card">
  <h1>Name tracker</h1>
  <label for="name">Character name</label>
  <input id="name" type="text" placeholder="Sam Rivers" maxlength="60">
  <button id="add" type="button">Add</button>
  <button id="copy" type="button">Copy all</button>
  <table>
    <thead><tr><th scope="col">Name</th></tr></thead>
    <tbody id="list"></tbody>
  </table>
  <p>Tom &amp; Sam &middot; 2 &lt; 3</p>
</main>`,
  `// Keep a list of character names.
const nameBox = document.getElementById('name');
const list = document.getElementById('list');
let names = [];
function load() {
  try {
    const saved = localStorage.getItem('fibb-name-tracker');
    const parsed = saved ? JSON.parse(saved) : [];
    return Array.isArray(parsed) ? parsed.filter(function (n) { return typeof n === 'string'; }) : [];
  } catch (err) {
    return [];
  }
}
function save() {
  try {
    localStorage.setItem('fibb-name-tracker', JSON.stringify(names));
  } catch (err) {
    /* The list still works without saving. */
  }
}
function draw() {
  list.replaceChildren();
  for (const name of names) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.textContent = name;
    row.appendChild(cell);
    list.appendChild(row);
  }
}
document.getElementById('add').addEventListener('click', function () {
  const value = nameBox.value.trim();
  if (!value) { return; }
  names.push(value);
  nameBox.value = '';
  save();
  draw();
});
document.getElementById('copy').addEventListener('click', function () {
  navigator.clipboard.writeText(names.join(', ')).catch(function () { });
});
names = load();
draw();`,
  '<style>\n  body { font-family: system-ui, sans-serif; background: #fbf8f3; }\n  .card { border-radius: 16px; padding: 24px; }\n  @media (prefers-color-scheme: dark) { body { background: #1b1a21; color: #eeebf6; } }\n</style>\n',
);

describe('page: what is accepted', () => {
  it('"page" is a kind with one file of at most 40 KB', () => {
    expect(TOOL_KINDS).toContain('page');
    expect(LIMITS.page).toEqual({ files: 1, fileBytes: 40 * 1024, totalBytes: 40 * 1024 });
  });

  it('the sprint timer example passes, with honest access lines', () => {
    const r = check(SPRINT_TIMER_EXAMPLE);
    expect(r.details).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.access).toEqual(['Runs only in its own tab', 'Can save its own notes in this browser', 'Sends nothing anywhere']);
    expect(r.warnings).toEqual([]);
  });

  it('a name tracker with a table, saving and copying passes', () => {
    const r = check(NAME_TRACKER);
    expect(r.details).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.access).toEqual(['Runs only in its own tab', 'Can save its own notes in this browser', 'Can copy text to your clipboard', 'Sends nothing anywhere']);
  });

  it('a page that saves nothing says only that it runs in its own tab', () => {
    const r = check(page('<main><h1>Goal</h1><p id="out">0</p></main>', "document.getElementById('out').textContent = String(50000 / 30);"));
    expect(r.details).toEqual([]);
    expect(r.access).toEqual(['Runs only in its own tab', 'Sends nothing anywhere']);
  });

  it.each([
    ['self-closing tags', page('<main><p>One<br/>Two<br />Three</p><input id="a" type="number"/><hr></main>')],
    ['details, progress, meter, canvas, select', page('<details open><summary>More</summary><progress value="3" max="10"></progress><meter value="2" min="0" max="5"></meter><canvas width="200" height="80"></canvas><select id="s"><option value="a" selected>A</option></select></details>')],
    ['a textarea with plain text', page('<label for="t">Notes</label><textarea id="t" rows="4">Plain text only</textarea>')],
    ['a style attribute', page('<p style="color: #7c83f7; margin: 0">Hi</p>')],
    ['no doctype', page().replace('<!doctype html>\n', '')],
    ['no script at all', page().replace('<script>\n\n</script>\n', '')],
    ['uppercase tags', page('<MAIN><H1>Hello</H1></MAIN>')],
    ['a timer with a function written in place', page(undefined, "setInterval(function () { document.title = String(Date.now()); }, 1000);")],
  ])('accepts %s', (_label, html) => {
    const r = check(html);
    expect(r.details).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe('page: attacks are refused', () => {
  const script = (code: string) => page(undefined, code);
  const body = (markup: string) => page(markup);
  const head = (markup: string) => page(undefined, '', markup);

  it.each<[string, string, string]>([
    // Loading from, or sending to, the internet
    ['an external script', page().replace('<script>', '<script src="https://evil.example/x.js">'), R.net],
    ['a local script file', page().replace('<script>', '<script src="x.js">'), R.unclear],
    ['a protocol-relative script', page().replace('<script>', '<script src="//evil.example/x.js">'), R.unclear],
    ['an image beacon with a query string', body('<img src="/log?words=1200">'), R.element],
    ['a data: image', body('<img src="data:image/png;base64,AAAA">'), R.element],
    ['a CSS url() beacon in <style>', head('<style>body { background: url(/log?x=1); }</style>'), R.net],
    ['a CSS url() beacon in a style attribute', body('<p style="background: url(/log?x=1)">x</p>'), R.net],
    ['a CSS url() hidden behind character codes', body('<p style="background: url&lpar;/log&rpar;">x</p>'), R.obf],
    ['a CSS @import', head('<style>@import "theme.css";</style>'), R.net],
    ['a CSS @font-face', head('<style>@font-face { font-family: x; src: local(x); }</style>'), R.net],
    ['fetch', script("fetch('/api/vault');"), R.net],
    ['fetch built from pieces', script("var f = window['fe' + 'tch']; f('/x');"), R.net],
    ['XMLHttpRequest', script('var x = new XMLHttpRequest();'), R.net],
    ['WebSocket', script("var s = new WebSocket('wss:' + name);"), R.net],
    ['sendBeacon', script("navigator.sendBeacon('/x', 'y');"), R.net],
    ['an image made in script', script("var i = new Image(); i.src = '/log';"), R.net],
    ['a web address in visible text', body('<p>See https://evil.example/collect</p>'), R.net],
    ['"//" in the markup', body('<p title="//evil.example">x</p>'), R.net],
    ['a web address spelled as a pattern', script('var u = /https:\\/\\/evil.example/.source;'), R.net],
    ['a file export with Blob', script("var b = new Blob(['x']);"), R.net],
    // Leaving the page
    ['location =', script("location = '/x';"), R.net],
    ['location.href =', script("location.href = '/x';"), R.net],
    ['location.assign()', script("location.assign('/x');"), R.net],
    ['location.replace()', script("location.replace('/x');"), R.net],
    ['window.location =', script("window.location = '/x';"), R.net],
    ['window.location.href =', script("window.location.href = '/x';"), R.net],
    ['document.location =', script("document.location = '/x';"), R.net],
    ['location under another name', script("var w = window; w.location = '/x';"), R.net],
    ['location read off an element', script("document.body.ownerDocument.location = '/x';"), R.net],
    ['top.location', script("top.location = '/x';"), R.net],
    ['parent.location', script("parent.location = '/x';"), R.net],
    ['self.location', script("self.location = '/x';"), R.net],
    ['window.open', script("window.open('/x');"), R.net],
    ['open()', script("open('/x');"), R.net],
    ['history.pushState', script("history.pushState(null, '', '/x');"), R.net],
    ['navigation.navigate', script("navigation.navigate('/x');"), R.net],
    ['opener', script('var o = window.opener;'), R.escape],
    ['postMessage', script("parent.postMessage('x', '*');"), R.net],
    ['a meta refresh', head('<meta http-equiv="refresh" content="0;url=/x">'), R.access],
    ['a meta refresh without quotes', head('<meta http-equiv=refresh content=0>'), R.access],
    ['a form with an action', body('<form action="/collect"><input name="a"></form>'), R.element],
    ['a form without an action', body('<form><input name="a"></form>'), R.element],
    ['a button with formaction', body('<button formaction="/x">Go</button>'), R.net],
    ['an iframe', body('<iframe src="/x"></iframe>'), R.element],
    ['a frame', body('<frame src="/x">'), R.element],
    ['an object', body('<object data="/x"></object>'), R.element],
    ['an embed', body('<embed src="/x">'), R.element],
    ['a link tag', head('<link rel="stylesheet" href="theme.css">'), R.element],
    ['a dns-prefetch link', head('<link rel="dns-prefetch" href="evil.example">'), R.element],
    ['a base tag', head('<base href="/x/">'), R.element],
    ['an anchor to a remote address', body('<a href="https://evil.example/">Next</a>'), R.net],
    ['an anchor to a relative address', body('<a href="collect?x=1">Next</a>'), R.element],
    ['an anchor to a fragment (pages have no links at all)', body('<a href="#top">Top</a>'), R.element],
    ['a link created in script', script("var a = document.createElement('a');"), R.element],
    ['a link rewritten through a list pattern', script("var el = document.querySelector('p'); [el.host] = ['evil.example'];"), R.unclear],
    ['svg', body('<svg><circle r="4"></circle></svg>'), R.element],
    ['audio', body('<audio src="/x"></audio>'), R.element],
    ['a srcset', body('<p srcset="/x 1x">x</p>'), R.net],
    ['an image input', body('<input type="image" src="/x">'), R.net],
    ['a file input', body('<input type="file">'), R.unclear],
    ...['iframe', 'img', 'script', 'form', 'meta', 'link', 'base', 'object', 'style'].map((el): [string, string, string] =>
      [`createElement('${el}')`, script(`var e = document.createElement('${el}');`), R.element]),
    // Running hidden code, raw HTML
    ['an inline event handler', body('<button onclick="go()">Go</button>'), R.dyn],
    ['an inline handler on body', page().replace('<body>', '<body onload="go()">'), R.dyn],
    ['eval', script("eval('1');"), R.dyn],
    ['new Function', script("var f = new Function('return 1');"), R.dyn],
    ['a timer given text', script("setTimeout('go()', 10);"), R.dyn],
    ['a module script', page().replace('<script>', '<script type="module">'), R.unclear],
    ['dynamic import', script("import('./x.js');"), R.dyn],
    ['document.write', script("document.write('<p>x</p>');"), R.html],
    ['innerHTML', script("document.body.innerHTML = 'x';"), R.html],
    ['HTML as text in script', script("var t = '<img src=x>'; document.body.textContent = t;"), R.html],
    // Protections and saved data
    ['a Content-Security-Policy of its own', head(`<meta http-equiv="Content-Security-Policy" content="default-src *">`), R.access],
    ['the exact policy Fibb adds', head(PAGE_CSP_META), R.access],
    ['a referrer meta', head('<meta name="referrer" content="unsafe-url">'), R.unclear],
    ['localStorage under another name', script('var s = localStorage; s.clear();'), R.secret],
    ['localStorage with a computed key', script("var k = 'a'; localStorage.getItem(k);"), R.secret],
    ['localStorage.clear()', script('localStorage.clear();'), R.secret],
    ['localStorage.key()', script('var k = localStorage.key(0);'), R.secret],
    ['window.localStorage', script("window.localStorage.getItem('a');"), R.escape],
    ['sessionStorage', script("sessionStorage.setItem('a', 'b');"), R.secret],
    ['indexedDB', script("indexedDB.open('x');"), R.secret],
    ['cookies', script('var c = document.cookie;'), R.secret],
    ['reading the clipboard', script('navigator.clipboard.readText();'), R.secret],
    // Ways to make the checker and a browser read the page differently
    ['an HTML comment', body('<!-- hello --><p>x</p>'), R.unclear],
    ['a script hidden in a textarea', body('<textarea><script></textarea><img src=x onerror=go()><p>x</script></textarea>'), R.unclear],
    ['a tag inside the title', page().replace('<title>Test page</title>', '<title><b>x</b></title>'), R.unclear],
    ['a quote trick that hides a handler', body('<p id=b"hidden title="lang><b title="x onclick=go()">y</b></p>'), R.unclear],
    ['the same attribute twice', body('<input type="image" type="text">'), R.unclear],
    ['an attribute glued to the one before', body('<p id="a"class="b">x</p>'), R.unclear],
    ['numeric character codes', body('<p title="&#106;">x</p>'), R.obf],
    ['an unknown character code', body('<p>a &colon; b</p>'), R.obf],
    ['a bare "<" in text', body('<p>1 < 2</p>'), R.unclear],
    ['two scripts', page().replace('</body>', '<script>var a = 1;</script></body>'), R.unclear],
    ['a script that is not closed', page().replace('</script>', ''), R.unclear],
    ['"<head" in a script comment', script('/* <head> */ var a = 1;'), R.shape],
    ['no <head>', page().replace('<head>', '').replace('</head>', ''), R.shape],
    ['markup before <html>', '<p>x</p>' + page(), R.shape],
    ['a script "closed" with a no-break space, hiding code after it', page(undefined, "var a = 1; //</script\u00A0>\nlocation = '/x';"), R.unclear],
    ['a no-break space before the doctype', '\u00A0' + page(), R.shape],
    ['a no-break space between attributes', body('<p id="a"\u00A0onclick="go()">x</p>'), R.unclear],
    ['a closing script tag with something extra', page().replace('</script>', '</script x>'), R.unclear],
    ['an invisible character', body('<p>x​</p>'), R.obf],
    ['an escape in the script', script("var a = '\\x66etch';"), R.obf],
    ['an unknown attribute', body('<p contenteditable="true">x</p>'), R.unclear],
  ])('refuses %s', (_label, html, reason) => {
    const r = check(html);
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain(reason);
    expect(r.access).toEqual([]);
  });

  it('refuses a page over 40 KB', () => {
    const r = check(page(`<p>${'word '.repeat(9000)}</p>`));
    expect(r.reasons).toEqual([R.size]);
  });

  it('refuses a page that is not page.html-shaped', () => {
    expect(checkTool('page', [{ path: 'page.js', content: 'var a = 1;' }]).reasons).toEqual([R.shape]);
    expect(checkTool('page', [{ path: 'page.html', content: page() }, { path: 'b.html', content: page() }]).reasons).toEqual([R.size]);
  });

  it('localStorage stays refused for every other kind', () => {
    const code = "(function () { try { localStorage.setItem('a', 'b'); } catch (err) { return; } })();";
    expect(checkTool('bookmarklet', [{ path: 'bookmarklet.js', content: code }]).reasons).toContain(R.secret);
    expect(checkTool('apps-script', [{ path: 'code.gs', content: `function run() { localStorage.getItem('a'); }` }]).reasons).toContain(R.secret);
    const ext = [
      { path: 'manifest.json', content: JSON.stringify({ manifest_version: 3, name: 'Calm', version: '1.0', content_scripts: [{ matches: ['https://www.example.com/*'], js: ['calm.js'] }] }) },
      { path: 'calm.js', content: "localStorage.getItem('a');" },
    ];
    expect(checkTool('extension', ext).reasons).toContain(R.secret);
  });

  it('the wider element list is for pages only', () => {
    const code = "(function () { var box = document.createElement('input'); document.body.appendChild(box); })();";
    expect(checkTool('bookmarklet', [{ path: 'bookmarklet.js', content: code }]).reasons).toContain(R.element);
    expect(check(page(undefined, "var box = document.createElement('input'); document.body.appendChild(box);")).ok).toBe(true);
  });

  it('a list pattern cannot set a property in any kind', () => {
    const code = "(function () { var el = document.querySelector('p'); [el.host] = ['x']; })();";
    expect(checkTool('bookmarklet', [{ path: 'bookmarklet.js', content: code }]).reasons).toContain(R.unclear);
  });

  it('the lists leave out everything that takes an address', () => {
    for (const tag of ['a', 'form', 'img', 'iframe', 'frame', 'object', 'embed', 'link', 'base', 'svg', 'audio', 'video', 'source', 'template', 'area', 'picture']) {
      expect(PAGE_TAGS, tag).not.toContain(tag);
      expect(PAGE_CREATE_ELEMENTS, tag).not.toContain(tag);
    }
    for (const el of ['script', 'style', 'meta', 'html', 'head', 'body']) expect(PAGE_CREATE_ELEMENTS, el).not.toContain(el);
    for (const attr of ['src', 'srcset', 'href', 'action', 'formaction', 'http-equiv', 'target', 'download', 'ping', 'rel', 'srcdoc']) {
      expect(PAGE_ATTRS, attr).not.toContain(attr);
    }
  });
});

describe('hardenPage', () => {
  it('the policy is fixed text', () => {
    expect(PAGE_CSP).toBe("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'");
    expect(PAGE_CSP_META).toBe(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">`);
    expect(PAGE_CSP_HEADER).toBe("sandbox allow-scripts allow-downloads; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'");
  });

  it('existing head: the policy becomes its first child', () => {
    expect(hardenPage('<!doctype html><html><head><title>T</title></head><body></body></html>'))
      .toBe(`<!doctype html><html><head>${PAGE_CSP_META}<title>T</title></head><body></body></html>`);
  });

  it('uppercase HEAD, and a head with attributes', () => {
    expect(hardenPage('<HTML><HEAD><TITLE>T</TITLE></HEAD></HTML>')).toBe(`<HTML><HEAD>${PAGE_CSP_META}<TITLE>T</TITLE></HEAD></HTML>`);
    expect(hardenPage('<html><head class="x">\n<title>T</title></head></html>')).toBe(`<html><head class="x">${PAGE_CSP_META}\n<title>T</title></head></html>`);
  });

  it('no head: one is made right after <html>', () => {
    expect(hardenPage('<!doctype html>\n<html lang="en"><body><p>x</p></body></html>'))
      .toBe(`<!doctype html>\n<html lang="en"><head>${PAGE_CSP_META}</head><body><p>x</p></body></html>`);
  });

  it('doctype but no html or head: the head goes right after the doctype', () => {
    expect(hardenPage('<!DOCTYPE html>\n<p>x</p>')).toBe(`<!DOCTYPE html><head>${PAGE_CSP_META}</head>\n<p>x</p>`);
  });

  it('nothing at all: the head goes first', () => {
    expect(hardenPage('<p>x</p>')).toBe(`<head>${PAGE_CSP_META}</head><p>x</p>`);
    expect(hardenPage('')).toBe(`<head>${PAGE_CSP_META}</head>`);
  });

  it('<header> is not mistaken for <head>', () => {
    expect(hardenPage('<html><body><header>x</header></body></html>')).toBe(`<html><head>${PAGE_CSP_META}</head><body><header>x</header></body></html>`);
  });

  it('only the first head is touched, and the checker refuses what hardenPage adds', () => {
    const out = hardenPage(SPRINT_TIMER_EXAMPLE);
    expect(out.split(PAGE_CSP_META)).toHaveLength(2);
    expect(out.indexOf(PAGE_CSP_META)).toBe(out.indexOf('<head>') + '<head>'.length);
    expect(out.replace(PAGE_CSP_META, '')).toBe(SPRINT_TIMER_EXAMPLE);
    // The model can never supply the policy itself: a hardened page does not pass the check.
    expect(check(out).ok).toBe(false);
  });
});

describe('ToolShelf: pages', () => {
  let dir: string;
  let replies: string[];
  let calls: Array<{ system: string; user: string }>;
  let shelf: ToolShelf;
  const file = () => join(dir, 'tools', 'shelf.json');
  const reply = (html: string) => JSON.stringify({ name: 'Sprint Timer!', summary: 'Counts down a writing sprint.', files: [{ path: 'index.htm', content: html }] });
  const REQUEST = 'A writing sprint timer with a start button.';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fibb-shelf-page-'));
    replies = [];
    calls = [];
    shelf = new ToolShelf(dir, {
      now: () => new Date('2026-11-27T09:00:00.000Z'),
      complete: async (system, user) => { calls.push({ system, user }); return replies.shift() ?? 'nothing'; },
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates a page: stored as written, handed out hardened', async () => {
    replies = [reply(SPRINT_TIMER_EXAMPLE)];
    const r = await shelf.create({ request: REQUEST });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tool).toEqual({
      id: expect.stringMatching(/^[a-f0-9]{24}$/),
      name: 'Sprint Timer!',
      kind: 'page',
      summary: 'Counts down a writing sprint.',
      access: ['Runs only in its own tab', 'Can save its own notes in this browser', 'Sends nothing anywhere'],
      warnings: [],
      code: hardenPage(SPRINT_TIMER_EXAMPLE),
      createdAt: '2026-11-27T09:00:00.000Z',
    });
    expect(r.tool.code).toContain(`<head>${PAGE_CSP_META}`);
    expect(calls[0].user).toContain('Kind of tool: page');
    expect(calls[0].system).toContain('This tool is a page');
    const stored = JSON.parse(readFileSync(file(), 'utf-8')).tools;
    expect(stored[0].files).toEqual([{ path: 'page.html', content: SPRINT_TIMER_EXAMPLE }]);
    expect(JSON.stringify(stored)).not.toContain('Content-Security-Policy');
    expect(await shelf.list()).toEqual([r.tool]);

    expect(await shelf.page(r.tool.id)).toEqual({ ok: true, html: hardenPage(SPRINT_TIMER_EXAMPLE), filename: 'sprint-timer.html' });
    expect(await shelf.page('nope')).toEqual({ ok: false, reason: 'not_found' });
    expect(await shelf.zip(r.tool.id)).toEqual({ ok: false, reason: 'not_extension' });
  });

  it('a refused page gets one retry that names what was found, then a plain error', async () => {
    const leaky = SPRINT_TIMER_EXAMPLE.replace('  show();\n</script>', "  location = '/api/vault?n=' + finished;\n</script>");
    replies = [reply(leaky), reply(SPRINT_TIMER_EXAMPLE)];
    const ok = await shelf.create({ request: REQUEST, kind: 'page' });
    expect(ok.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].user).toContain('refused by the safety checker');
    expect(calls[1].user).toContain('location');

    replies = [reply(leaky), reply(leaky)];
    const no = await shelf.create({ request: REQUEST, kind: 'page' });
    expect(no).toEqual({ ok: false, error: 'Fibb could not make a safe version of that. It kept trying to contact the internet.' });
    expect(await shelf.list()).toHaveLength(1);
  });

  it('a model that supplies its own policy is refused', async () => {
    const own = hardenPage(SPRINT_TIMER_EXAMPLE);
    replies = [reply(own), reply(own)];
    const r = await shelf.create({ request: REQUEST, kind: 'page' });
    expect(r).toEqual({ ok: false, error: 'Fibb could not make a safe version of that. It kept trying to get more access than Fibb allows.' });
  });

  it('page() is only for pages, and a page edited on disk is no longer served', async () => {
    const mark = JSON.stringify({ name: 'Counter', summary: 'Counts words.', files: [{ path: 'a.js', content: "(function () { var p = document.createElement('div'); p.textContent = 'Hi'; document.body.appendChild(p); })();" }] });
    replies = [mark, reply(SPRINT_TIMER_EXAMPLE)];
    const a = await shelf.create({ request: 'Count the words on the page I am reading.', kind: 'bookmarklet' });
    const b = await shelf.create({ request: REQUEST, kind: 'page' });
    if (!a.ok || !b.ok) throw new Error('setup failed');
    expect(await shelf.page(a.tool.id)).toEqual({ ok: false, reason: 'not_page' });

    const data = JSON.parse(readFileSync(file(), 'utf-8'));
    data.tools[1].files[0].content = SPRINT_TIMER_EXAMPLE.replace('  show();\n</script>', "  fetch('/api/vault');\n</script>");
    writeFileSync(file(), JSON.stringify(data));
    expect(await shelf.page(b.tool.id)).toEqual({ ok: false, reason: 'not_found' });
    expect((await shelf.list()).map(t => t.kind)).toEqual(['bookmarklet']);
  });
});

describe('page: prompt and helpers', () => {
  it('the page prompt is built from the page lists and asks for the look', () => {
    const p = buildToolPrompt('page');
    for (const tag of PAGE_TAGS) expect(p).toContain(tag);
    for (const attr of PAGE_ATTRS) expect(p).toContain(attr);
    expect(p).toContain('"page.html"');
    expect(p).toContain('40 KB');
    expect(p).toContain('one JSON object');
    expect(p).toContain('#7c83f7');
    expect(p).toContain('#fbf8f3');
    expect(p).toContain('prefers-color-scheme');
    expect(p).toContain('system-ui');
    expect(p).toContain('try { } catch (err) { }');
    expect(p).toContain('addEventListener');
    expect(p).toContain('http-equiv');
    expect(p).toContain(SPRINT_TIMER_EXAMPLE);
    expect(p).not.toMatch(/[—–]/);
    // localStorage is allowed for a page, so it is not in the refused names; every other name still is.
    const refused = p.split('\n').find(l => l.startsWith('- These names are refused anywhere'))!;
    expect(refused).not.toContain('localStorage');
    for (const word of [...FORBIDDEN_NAMES.network, ...FORBIDDEN_NAMES.dynamic, 'sessionStorage', 'indexedDB']) expect(refused).toContain(word);
    // The other kinds are told exactly what they were told before.
    for (const kind of ['bookmarklet', 'extension', 'apps-script'] as const) {
      const other = buildToolPrompt(kind);
      expect(other.split('\n').find(l => l.startsWith('- These names are refused anywhere'))).toContain('localStorage');
      expect(other).toContain('store anything');
      expect(other).not.toContain('page.html');
    }
  });

  it('parseDraft forces the file name', () => {
    const d = parseDraft('page', JSON.stringify({ name: 'Timer', summary: 'A timer.', files: [{ path: '../../Evil.HTML', content: '<p>x</p>' }] }));
    expect(d!.files).toEqual([{ path: 'page.html', content: '<p>x</p>' }]);
    expect(parseDraft('page', JSON.stringify({ name: 'Timer', summary: 'A timer.', files: [{ path: 'a.html', content: 'a' }, { path: 'b.html', content: 'b' }] }))).toBeNull();
  });

  it.each([
    ['A writing sprint timer', 'page'],
    ['A character name tracker', 'page'],
    ['A word-count goal calculator', 'page'],
    ['A scene card board', 'page'],
    ['A little dashboard for my drafts', 'page'],
    ['A weekly writing planner', 'page'],
    ['A mini app for plotting', 'page'],
    ['Make me a page that lists my chapters', 'page'],
    ['A query letter tracker table', 'page'],
    ['Count names on the page', 'bookmarklet'],
    ['Count the words on the page I am reading.', 'bookmarklet'],
    ['Highlight adverbs on every web page', 'bookmarklet'],
    ['A word goal tracker in my Google Doc', 'apps-script'],
    ['An apps script that counts words', 'apps-script'],
    ['A Chrome extension with a sprint timer', 'extension'],
    ['Highlight every adverb', 'bookmarklet'],
  ])('inferKind(%j) is %s', (request, kind) => {
    expect(inferKind(request)).toBe(kind);
  });
});
