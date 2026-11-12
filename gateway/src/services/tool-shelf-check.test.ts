import { describe, it, expect } from 'vitest';
import { checkTool, REASONS, LIMITS, type ToolFile, type ToolKind, type CheckOptions } from './tool-shelf-check.js';

const bm = (code: string) => checkTool('bookmarklet', [{ path: 'tool.js', content: code }]);
const gs = (code: string) => checkTool('apps-script', [{ path: 'code.gs', content: code }]);

// ── Benign samples ──

const WORD_COUNTER = `(function () {
  // Count the words on this page and show the number in a small panel.
  var text = document.body.innerText;
  var words = text.split(/\\s+/).filter(function (w) { return w.length > 0; });
  var panel = document.createElement('div');
  panel.textContent = 'Words on this page: ' + words.length + ' (click to close)';
  panel.style.position = 'fixed';
  panel.style.top = '12px';
  panel.style.right = '12px';
  panel.style.zIndex = '99999';
  panel.style.padding = '10px 14px';
  panel.style.backgroundColor = '#222';
  panel.style.color = '#fff';
  panel.style.borderRadius = '8px';
  panel.addEventListener('click', function () { panel.remove(); });
  document.body.appendChild(panel);
})();`;

const HIGHLIGHTER = `(function () {
  // Ask for a word, then wrap every match on the page in a yellow <mark>.
  var word = window.prompt('Highlight which word?');
  if (!word) { return; }
  var needle = word.toLowerCase();
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var nodes = [];
  while (walker.nextNode()) { nodes.push(walker.currentNode); }
  var found = 0;
  nodes.forEach(function (node) {
    var at = node.nodeValue.toLowerCase().indexOf(needle);
    while (at !== -1) {
      var rest = node.splitText(at);
      var after = rest.splitText(needle.length);
      var mark = document.createElement('mark');
      mark.textContent = rest.nodeValue;
      rest.parentNode.replaceChild(mark, rest);
      found += 1;
      node = after;
      at = node.nodeValue.toLowerCase().indexOf(needle);
    }
  });
  window.alert('Highlighted ' + found + ' places.');
})();`;

const READING_TIME = `(() => {
  // Estimate the reading time at 230 words a minute.
  const words = document.body.innerText.split(/\\s+/).filter(Boolean).length;
  const minutes = Math.max(1, Math.ceil(words / 230));
  const panel = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = 'Reading time';
  const line = document.createElement('p');
  line.textContent = \`About \${minutes} min (\${words} words)\`;
  panel.append(title, line);
  panel.style.position = 'fixed';
  panel.style.bottom = '16px';
  panel.style.left = '16px';
  panel.style.padding = '12px';
  panel.style.backgroundColor = 'white';
  panel.style.border = '1px solid #999';
  panel.style.zIndex = '99999';
  panel.addEventListener('click', () => panel.remove());
  document.body.appendChild(panel);
  setTimeout(() => { panel.style.opacity = '0.8'; }, 4000);
})();`;

const FOCUS_MODE = `(function () {
  // Narrow the text column and fade everything that is not the article.
  const sheet = document.createElement('style');
  sheet.textContent = 'body { max-width: 40em; margin: 0 auto; line-height: 1.7; font-size: 19px; } aside, nav, footer, header { opacity: 0.15; }';
  document.head.appendChild(sheet);
})();`;

const NAME_COUNTER = `(function () {
  var names = window.prompt('Names to count, separated by commas:');
  if (!names) { return; }
  var text = document.body.innerText;
  var lines = [];
  var list = names.split(',');
  for (let i = 0; i < list.length; i++) {
    var name = list[i].trim();
    if (!name) { continue; }
    var count = text.split(name).length - 1;
    lines.push(name + ': ' + count);
  }
  var tally = new Map();
  for (const line of lines) { tally.set(line, (tally.get(line) || 0) + 1); }
  var panel = document.createElement('pre');
  panel.textContent = lines.join('\\n');
  panel.style.position = 'fixed';
  panel.style.top = '10px';
  panel.style.left = '10px';
  panel.style.backgroundColor = '#fffbe6';
  panel.style.padding = '10px';
  panel.addEventListener('click', function () { panel.remove(); });
  document.body.appendChild(panel);
})();`;

const SELECTION_COPY = `(function () {
  var picked = String(window.getSelection());
  var words = picked.split(/\\s+/).filter(Boolean).length;
  navigator.clipboard.writeText(words + ' words selected');
})();`;

const DOCS_WORD_FREQUENCY = `// Adds a "Word tools" menu that lists the most used words in this document.
function onOpen() {
  DocumentApp.getUi().createMenu('Word tools').addItem('Most used words', 'showWordFrequency').addToUi();
}

function showWordFrequency() {
  var text = DocumentApp.getActiveDocument().getBody().getText().toLowerCase();
  var words = text.split(/[^a-z']+/).filter(function (w) { return w.length > 3; });
  var counts = new Map();
  words.forEach(function (w) { counts.set(w, (counts.get(w) || 0) + 1); });
  var ranked = Array.from(counts.entries()).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 15);
  var lines = ranked.map(function (pair) { return pair[0] + ': ' + pair[1]; });
  var stamp = Utilities.formatDate(new Date(), 'GMT', 'yyyy-MM-dd');
  Logger.log(stamp);
  DocumentApp.getUi().alert(lines.join('\\n'));
}`;

const DOCS_WORD_GOAL = `function onOpen() {
  DocumentApp.getUi().createMenu('Word goal').addItem('Check my goal', 'checkGoal').addToUi();
}
function checkGoal() {
  var GOAL = 50000;
  var body = DocumentApp.getActiveDocument().getBody();
  var count = body.getText().split(/\\s+/).filter(Boolean).length;
  var html = HtmlService.createHtmlOutput('<p><b>Keep going.</b> Your goal is 50,000 words.</p>');
  DocumentApp.getUi().showSidebar(html);
  body.appendParagraph('Words so far: ' + count + ' of ' + GOAL);
}`;

const MANIFEST_POPUP = JSON.stringify({
  manifest_version: 3,
  name: 'Page word counter',
  version: '1.0',
  description: 'Counts the words on the page you are looking at.',
  action: { default_popup: 'popup.html', default_title: 'Count words' },
  permissions: ['activeTab', 'scripting'],
}, null, 2);
const POPUP_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <!-- One button, one result line. -->
  <button id="count">Count words</button>
  <p id="result"></p>
  <script src="popup.js"></script>
</body>
</html>`;
const POPUP_CSS = `body { font-family: sans-serif; min-width: 220px; padding: 12px; }
button { padding: 6px 10px; }
/* The result line. */
#result { font-weight: bold; }`;
const POPUP_JS = `// Runs inside the page: counts its words.
function countWords() {
  return document.body.innerText.split(/\\s+/).filter(Boolean).length;
}

document.getElementById('count').addEventListener('click', function () {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, func: countWords }, function (results) {
      document.getElementById('result').textContent = 'Words: ' + results[0].result;
    });
  });
});`;
const popupExtension = (over: Record<string, string> = {}): ToolFile[] => Object.entries({
  'manifest.json': MANIFEST_POPUP, 'popup.html': POPUP_HTML, 'popup.css': POPUP_CSS, 'popup.js': POPUP_JS, ...over,
}).map(([path, content]) => ({ path, content }));

const contentExtension = (matches: string[], extra: Record<string, unknown> = {}): ToolFile[] => [
  { path: 'manifest.json', content: JSON.stringify({
    manifest_version: 3, name: 'Calm reading', version: '1.0.0',
    content_scripts: [{ matches, js: ['calm.js'], css: ['calm.css'], run_at: 'document_idle' }], ...extra,
  }) },
  { path: 'calm.js', content: 'document.body.classList.add("calm-reading");' },
  { path: 'calm.css', content: '.calm-reading { max-width: 42em; margin: 0 auto; }' },
];
const manifestWith = (patch: Record<string, unknown>): ToolFile[] =>
  popupExtension({ 'manifest.json': JSON.stringify({ ...JSON.parse(MANIFEST_POPUP), ...patch }) });

describe('checkTool: benign tools pass', () => {
  const benign: Array<[string, ToolKind, ToolFile[], CheckOptions?]> = [
    ['word counter bookmarklet', 'bookmarklet', [{ path: 'tool.js', content: WORD_COUNTER }]],
    ['highlighter with <mark> and textContent', 'bookmarklet', [{ path: 'tool.js', content: HIGHLIGHTER }]],
    ['reading-time panel', 'bookmarklet', [{ path: 'reading-time.js', content: READING_TIME }]],
    ['focus-mode style injection without url(', 'bookmarklet', [{ path: 'tool.js', content: FOCUS_MODE }]],
    ['name counter with a loop counter and a Map', 'bookmarklet', [{ path: 'tool.js', content: NAME_COUNTER }]],
    ['selection word count to the clipboard', 'bookmarklet', [{ path: 'tool.js', content: SELECTION_COPY }]],
    ['Docs word-frequency menu script', 'apps-script', [{ path: 'code.gs', content: DOCS_WORD_FREQUENCY }]],
    ['Docs word goal with a fixed sidebar', 'apps-script', [{ path: 'code.gs', content: DOCS_WORD_GOAL }]],
    ['extension popup counting words on the active tab', 'extension', popupExtension()],
    ['extension content script on one named site', 'extension', contentExtension(['https://www.example.com/*'])],
    ['extension on every page when the author asked for it', 'extension', contentExtension(['<all_urls>']), { allowAllPages: true }],
  ];
  it.each(benign)('%s', (_label, kind, files, opts) => {
    const r = checkTool(kind, files, opts);
    expect(r.details).toEqual([]);
    expect(r.reasons).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.access.at(-1)).toBe('Sends nothing anywhere');
    expect(r.access.length).toBeGreaterThan(1);
  });

  it('describes what a bookmarklet touches, in plain words', () => {
    expect(bm(WORD_COUNTER)).toMatchObject({
      ok: true,
      access: ['Reads the text on the page you are on', 'Changes how the page looks', 'Runs when you click it', 'Sends nothing anywhere'],
      warnings: ['It changes what you see on the page. Reload the page to put it back.'],
    });
    const copy = bm(SELECTION_COPY);
    expect(copy.access).toEqual(['Reads the text you selected', 'Writes to your clipboard', 'Runs when you click it', 'Sends nothing anywhere']);
    expect(copy.warnings).toEqual([]);
  });

  it('describes a Docs script and warns that it changes the document and runs on open', () => {
    const menu = gs(DOCS_WORD_FREQUENCY);
    expect(menu.access).toEqual([
      'Reads and changes the Google Doc it is attached to', 'Adds a menu to your Google Doc',
      'Runs when you pick it from that menu', 'Sends nothing anywhere',
    ]);
    expect(menu.warnings).toEqual(['Part of it runs by itself when you open or edit the document.']);
    expect(gs(DOCS_WORD_GOAL).warnings).toContain('It can change your document. Use Undo or the version history to go back.');
    expect(gs('function tidy() { Logger.log(DocumentApp.getActiveDocument().getBody().getText().length); }').access)
      .toContain('Runs when you run it from the script editor');
  });

  it('describes an extension: click to run, or the pages it runs on by itself', () => {
    expect(checkTool('extension', popupExtension()).access).toContain('Runs when you click it');
    const auto = checkTool('extension', contentExtension(['https://www.example.com/*']));
    expect(auto.access).toContain('Runs automatically on pages matching https://www.example.com/*');
    expect(auto.access).not.toContain('Runs when you click it');
    expect(auto.warnings).toContain('It runs by itself on those pages, without you clicking anything.');
  });

  it('a rejected tool reports no access list', () => {
    const r = bm('fetch("/x")');
    expect(r).toMatchObject({ ok: false, access: [], warnings: [] });
    expect(r.details.join(' ')).toContain('fetch');
  });
});

// ── Malicious samples ──

const R = REASONS;
type Bad = [label: string, code: string, reason?: string];

const BAD_BOOKMARKLETS: Bad[] = [
  // Network and exfiltration
  ['fetch', 'fetch("/collect?d=" + document.title);', R.net],
  ['XMLHttpRequest', 'var x = new XMLHttpRequest(); x.send();', R.net],
  ['WebSocket', 'var s = new WebSocket("wss://collect.example");', R.net],
  ['EventSource', 'new EventSource("/stream");', R.net],
  ['navigator.sendBeacon', 'navigator.sendBeacon("/b", document.title);', R.net],
  ['importScripts', 'importScripts("x.js");', R.net],
  ['dynamic import', 'import("./x.js");', R.dyn],
  ['Worker', 'new Worker("w.js");', R.net],
  ['new Image().src', 'new Image().src = "/p?d=" + document.title;', R.net],
  ['img element', 'var im = document.createElement("img"); document.body.appendChild(im);', R.element],
  ['script element', 'document.body.appendChild(document.createElement("script"));', R.element],
  ['hidden iframe', 'var f = document.createElement("iframe"); f.hidden = true; document.body.appendChild(f);', R.element],
  ['form element and submit', 'var f = document.createElement("form"); document.body.appendChild(f); f.submit();', R.element],
  ['link element', 'document.head.appendChild(document.createElement("link"));', R.element],
  ['anchor element', 'document.body.appendChild(document.createElement("a"));', R.element],
  ['object, embed, video, audio, source', 'var kinds = ["x"]; document.createElement("object"); document.createElement("embed"); document.createElement("video"); document.createElement("audio"); document.createElement("source");', R.element],
  ['createElement with a variable', 'var kind = "di" + "v"; document.createElement(kind);', R.element],
  ['createElement in upper case', 'document.createElement("SCRIPT");', R.element],
  ['existing image .src', 'document.querySelector("img").src = "/p?d=" + document.title;', R.net],
  ['existing link .href', 'var a = document.querySelector("a"); a.href = "/go?d=" + document.title;', R.net],
  ['<a href> click', 'document.querySelector("a").click();', R.act],
  ['existing link .search', 'document.querySelector("a").search = "?d=" + document.title;', R.net],
  ['existing link .hostname', 'document.querySelector("a").hostname = "collect.example";', R.net],
  ['existing form submit', 'document.querySelector("form").submit();', R.act],
  ['document.forms', 'document.forms[0].submit();', R.act],
  ['form .action', 'document.querySelector("form").action = "/x";', R.net],
  ['setAttribute src', 'document.querySelector("img").setAttribute("src", "/x");', R.net],
  ['setAttribute href', 'document.querySelector("a").setAttribute("href", "/x");', R.net],
  ['setAttribute with a variable name', 'var n = "sr" + "c"; document.body.setAttribute(n, "/x");', R.net],
  ['setAttribute onclick', 'document.body.setAttribute("onclick", "run()");', R.net],
  ['attribute node', 'document.querySelector("img").getAttributeNode("src").value = "/x";', R.unclear],
  ['innerHTML', 'document.body.innerHTML = "<b>hi</b>";', R.html],
  ['outerHTML', 'document.body.outerHTML = "";', R.html],
  ['insertAdjacentHTML', 'document.body.insertAdjacentHTML("beforeend", "hi");', R.html],
  ['document.write', 'document.write("hi");', R.html],
  ['DOMParser', 'new DOMParser().parseFromString("x", "text/html");', R.html],
  ['HTML as text', 'var t = "<img onerror=run()>"; document.body.textContent = t;', R.html],
  ['window.open', 'window.open("/x");', R.net],
  ['open()', 'open("/x");', R.net],
  ['location.href', 'location.href = "/x?d=" + document.title;', R.net],
  ['location.assign', 'location.assign("/x");', R.net],
  ['document.location.replace', 'document.location.replace("/x");', R.net],
  ['window.location', 'window.location = "/x";', R.net],
  ['postMessage', 'window.postMessage(document.title, "*");', R.net],
  ['http literal', 'var u = "http://collect.example/x";', R.net],
  ['https literal in a comment', '// see https://collect.example\nvar a = 1;', R.net],
  ['protocol-relative literal', 'var u = "//collect.example/x";', R.net],
  ['ws literal', 'var u = "ws://collect.example";', R.net],
  ['data literal', 'var u = "data:text/html,hi";', R.net],
  ['blob literal', 'var u = "blob:abc";', R.net],
  ['javascript literal', 'var u = "javascript:run()";', R.net],
  ['CSS url() in injected style text', 'const sheet = document.createElement("style"); sheet.textContent = "body { background: url(/p.png) }"; document.head.appendChild(sheet);', R.net],
  ['CSS @import in injected style text', 'const sheet = document.createElement("style"); sheet.textContent = "@import \'x.css\';"; document.head.appendChild(sheet);', R.net],
  ['style text built at run time', 'const sheet = document.createElement("style"); sheet.textContent = "body {" + document.title + "}"; document.head.appendChild(sheet);', R.unclear],
  ['style element handed around', 'const sheet = document.createElement("style"); var other = sheet; document.head.appendChild(sheet);', R.unclear],
  ['style.backgroundImage', 'document.body.style.backgroundImage = "none";', R.net],
  ['style.cssText', 'document.body.style.cssText = "color: red";', R.net],
  ['style as a whole', 'document.body.style = "color: red";', R.unclear],
  ['style.setProperty', 'document.body.style.setProperty("color", "red");', R.net],
  ['insertRule', 'document.styleSheets[0].insertRule("p { color: red }");', R.net],

  // Dynamic code
  ['eval', 'eval("1 + 1");', R.dyn],
  ['new Function', 'new Function("return 1")();', R.dyn],
  ['Function()', 'var f = Function("return 1");', R.dyn],
  ['Function via constructor chain', '[].filter.constructor("return 1")();', R.dyn],
  ['constructor.constructor', '(function () {}).constructor.constructor("return 1")();', R.dyn],
  ['setTimeout with a string', 'setTimeout("run()", 10);', R.dyn],
  ['setInterval with a string', 'setInterval("run()", 10);', R.dyn],
  ['setTimeout with a built string', 'var s = "ru" + "n()"; setTimeout(s, 10);', R.dyn],
  ['setTimeout with a function that turns into a string', 'var s = "run()"; setTimeout(function () {}.x || s, 10);', R.dyn],
  ['setTimeout through an alias', 'var later = setTimeout; later("run()", 10);', R.dyn],
  ['setTimeout.call', 'setTimeout.call(null, "run()", 10);', R.dyn],
  ['setTimeout as a tagged template', 'setTimeout`run()`;', R.dyn],
  ['atob', 'var s = atob("ZmV0Y2g=");', R.dyn],
  ['btoa', 'var s = btoa(document.title);', R.dyn],
  ['String.fromCharCode', 'var s = String.fromCharCode(102, 101);', R.dyn],
  ['fromCodePoint', 'var s = String.fromCodePoint(102);', R.dyn],
  ['unescape', 'var s = unescape("%66");', R.dyn],
  ['decodeURIComponent', 'var s = decodeURIComponent("%66");', R.dyn],
  ['Reflect', 'Reflect.get(document, "title");', R.dyn],
  ['Proxy', 'var p = new Proxy({}, {});', R.dyn],
  ['with', 'with (document) { title = "x"; }', R.dyn],
  ['__proto__', 'var o = ({}).__proto__;', R.dyn],
  ['prototype', 'var f = Array.prototype.slice;', R.dyn],

  // Obfuscation
  ['string concatenation to build fetch', 'var w = window; w["fe" + "tch"]("/x");'],
  ['bracket access on window with concatenation', 'window["fe" + "tch"]("/x");', R.dyn],
  ['bracket access on window with a literal', 'window["alert"]("x");', R.dyn],
  ['bracket access on document', 'var c = document["coo" + "kie"];', R.dyn],
  ['bracket access on top', 'top["loc" + "ation"] = "/x";', R.escape],
  ['unicode escape in an identifier', '\\u0066etch("/x");', R.obf],
  ['hex escape in a string', 'window["\\x66etch"]("/x");', R.obf],
  ['comment trick fe/**/tch', 'var fe = 1, tch = 2; fe/**/tch;', R.net],
  ['template literal key', 'window[`fe${"tch"}`]("/x");', R.dyn],
  ['computed property write', 'var k = "sr" + "c"; document.querySelector("img")[k] = "/x";', R.unclear],
  ['computed property read then call', 'var d = document.body.ownerDocument; var k = "defa" + "ultView"; var w = d[k];', R.unclear],
  ['computed key destructuring', 'var k = "x"; const { [k]: f } = document.body;', R.unclear],
  ['a counter that stops being a number', 'for (let i = 0; i < 1; i++) { } var el = document.body; i = "x"; el[i] = 1;', R.unclear],
  ['Object.assign onto an element', 'Object.assign(document.body, { title: "x" });', R.unclear],
  ['Object.entries to find functions', 'var all = Object.entries(document.body);', R.unclear],
  ['window on its own', 'var w = window;', R.escape],
  ['document on its own', 'var d = document;', R.unclear],
  ['this as the window', 'var w = this; w.alert("x");', R.unclear],
  ['regex that hides code after if ()', 'if (document.title) /\'/.test("x"), location.assign("/x"); //\'', R.net],
  ['division that is not a regex', 'var n = 1; var x = n++ / location.assign("/x") / 1;', R.net],
  ['division after a template literal', 'var n = 2; var x = `${n}` / location.assign("/x") / 1;', R.net],
  ['regex after break on a new line', 'for (;;) { break\n/\'/.test("x"), location.assign("/x") //\'\n}', R.unclear],
  ['regex after a block', 'function f() {}\n/\'/.test("x"), location.assign("/x"); //\'', R.unclear],
  ['block comment around the payload', '/* quiet */ fetch("/x") /* quiet */;', R.net],
  ['minified one-liner', 'var a = 1;' + ' a = a + 1;'.repeat(220), R.obf],
  ['zero-width character', 'var a = "x\u200B";', R.obf],
  ['bidi override', 'var a = "x\u202E";', R.obf],
  ['control character', 'var a = "x\u0000";', R.obf],
  ['line continuation in a string', 'var a = "x\\\ny";', R.unclear],
  ['non-ASCII identifier', 'var f\u0435tch = 1;', R.unclear],

  // Secrets and storage
  ['document.cookie', 'var c = document.cookie;', R.secret],
  ['cookie by destructuring', 'const { cookie } = document.body.ownerDocument;', R.secret],
  ['localStorage', 'localStorage.getItem("draft");', R.secret],
  ['sessionStorage', 'sessionStorage.setItem("a", "b");', R.secret],
  ['indexedDB', 'indexedDB.open("x");', R.secret],
  ['caches', 'caches.keys();', R.secret],
  ['navigator.credentials', 'navigator.credentials.get({});', R.secret],
  ['navigator.clipboard.readText', 'navigator.clipboard.readText();', R.browser],
  ['navigator.clipboard.read', 'navigator.clipboard.read();', R.browser],
  ['clipboard through an alias', 'var c = navigator.clipboard; c.readText();', R.browser],
  ['password field', 'var v = document.querySelector("input[type=password]").value;', R.secret],
  ['the word token', 'var token = document.title;', R.secret],
  ['the word secret in a string', 'var label = "my secret plan";', R.secret],
  ['api_key', 'var api_key = "abc";', R.secret],
  ['Authorization', 'var h = { Authorization: "x" };', R.secret],

  // Page escape
  ['top.', 'var t = top.document.title;', R.escape],
  ['parent.', 'var t = parent.document.title;', R.escape],
  ['window.top', 'var t = window.top;', R.escape],
  ['window.parent', 'var t = window.parent;', R.escape],
  ['opener', 'var o = window.opener;', R.escape],
  ['frames', 'var f = frames[0];', R.escape],
  ['contentWindow', 'var w = document.querySelector("iframe").contentWindow;', R.escape],
  ['contentDocument', 'var d = document.querySelector("iframe").contentDocument;', R.escape],
  ['defaultView', 'var w = document.body.ownerDocument.defaultView;', R.escape],
  ['chrome.* in a bookmarklet', 'chrome.runtime.sendMessage("x");', R.escape],
  ['browser.* in a bookmarklet', 'browser.runtime.sendMessage("x");', R.escape],
  ['dispatchEvent', 'document.body.dispatchEvent(new Event("submit"));', R.act],

  // Renaming and pulling methods out
  ['open pulled out by destructuring', 'window.addEventListener("click", function (e) { const { open: o } = e.currentTarget; o(["x", "y"].join("")); });', R.unclear],
  ['open pulled out with a dot', 'window.addEventListener("click", function (e) { var o = e.currentTarget.open; o("x"); });', R.net],
  ['click pulled out with a dot', 'var el = document.querySelector("button"); var c = el.click; c.call(el);', R.act],
  ['style pulled out by destructuring', 'const { style } = document.body; style.content = "x";', R.unclear],
  ['style renamed by destructuring', 'const { style: s } = document.body; s.content = "x";', R.unclear],
  ['destructuring in a parameter', 'document.body.addEventListener("click", function ({ view }) { view.alert("x"); });', R.unclear],
  ['destructuring in a loop', 'for (const { ownerDocument: d } of [document.body]) { d.title = "x"; }', R.unclear],
  ['window reached through an event', 'window.addEventListener("click", function (e) { var w = e.currentTarget; w.document.title = "x"; });', R.escape],
  ['event.view', 'document.body.addEventListener("click", function (e) { var w = e.view; });', R.escape],
  ['history', 'window.addEventListener("click", function (e) { e.currentTarget.history.back(); });', R.net],
  ['animation keyframes', 'document.body.animate({ opacity: [0, 1] }, 500);', R.net],
  ['speech (sends text to a voice service)', 'speechSynthesis.cancel();', R.net],
  ['meta content', 'document.querySelector("meta").content = "0";', R.net],

  // Unterminated or unreadable
  ['a string that never ends', 'var a = "x;', R.unclear],
  ['a comment that never ends', 'var a = 1; /* x', R.unclear],
  ['brackets that do not match', 'var a = (1;', R.unclear],
];

describe('checkTool: malicious bookmarklets are refused', () => {
  it('has at least 60 cases', () => {
    expect(BAD_BOOKMARKLETS.length).toBeGreaterThanOrEqual(60);
  });
  it.each(BAD_BOOKMARKLETS)('%s', (_label, code, reason) => {
    const r = bm(code);
    expect(r.ok).toBe(false);
    expect(r.reasons.length).toBeGreaterThan(0);
    if (reason) expect(r.reasons).toContain(reason);
    expect(r.access).toEqual([]);
    for (const text of r.reasons) expect(Object.values(REASONS)).toContain(text);
  });

  it('refuses the same payloads wrapped inside an otherwise benign tool', () => {
    for (const payload of ['fetch("/x");', 'location.href = "/x";', 'document.querySelector("img").src = "/x";', 'var c = document.cookie;']) {
      expect(bm(WORD_COUNTER.replace('document.body.appendChild(panel);', payload)).ok).toBe(false);
    }
  });
});

describe('checkTool: limits and file names', () => {
  it('bookmarklet: one .js file of at most 6 KB', () => {
    const filler = `// ${'x'.repeat(90)}\n`.repeat(70);
    expect(Buffer.byteLength(filler)).toBeGreaterThan(LIMITS.bookmarklet.fileBytes);
    expect(bm(filler + 'var a = 1;').reasons).toEqual([R.size]);
    expect(checkTool('bookmarklet', [{ path: 'a.js', content: 'var a = 1;' }, { path: 'b.js', content: 'var b = 1;' }]).reasons).toEqual([R.size]);
    expect(checkTool('bookmarklet', [{ path: 'tool.html', content: '<p>x</p>' }]).reasons).toEqual([R.shape]);
    expect(bm('   ').reasons).toEqual([R.shape]);
  });

  it.each(['../tool.js', 'sub/tool.js', 'sub\\tool.js', 'Tool.JS', '.hidden.js', 'tool', 'tool.exe', 'a..b.js', ''])('refuses the file name %j', (path) => {
    expect(checkTool('bookmarklet', [{ path, content: 'var a = 1;' }]).reasons).toEqual([R.shape]);
  });

  it('extension: at most 6 files, 20 KB each, 60 KB in total', () => {
    const many = [...popupExtension(), ...['a', 'b', 'c'].map(n => ({ path: `${n}.js`, content: 'var a = 1;' }))];
    expect(checkTool('extension', many).reasons).toEqual([R.size]);
    const big = `/* ${'x'.repeat(90)} */\n`.repeat(230);
    expect(checkTool('extension', popupExtension({ 'popup.css': big })).reasons).toEqual([R.size]);
    const medium = `/* ${'x'.repeat(90)} */\n`.repeat(190);
    const total = popupExtension({ 'popup.css': medium + 'p { color: red; }', 'a.css': medium, 'b.css': medium, 'popup.js': `// ${'x'.repeat(90)}\n`.repeat(90) + POPUP_JS });
    for (const f of total) expect(Buffer.byteLength(f.content)).toBeLessThan(LIMITS.extension.fileBytes);
    expect(checkTool('extension', total).reasons).toEqual([R.size]);
  });

  it('apps-script: one file of at most 20 KB', () => {
    expect(gs(`// ${'x'.repeat(90)}\n`.repeat(230) + 'function a() {}').reasons).toEqual([R.size]);
    expect(checkTool('apps-script', [{ path: 'code.gs', content: 'function a() {}' }, { path: 'b.gs', content: 'function b() {}' }]).ok).toBe(false);
  });

  it('refuses bad input shapes', () => {
    expect(checkTool('bookmarklet', []).ok).toBe(false);
    expect(checkTool('bookmarklet', null as any).ok).toBe(false);
    expect(checkTool('bookmarklet', [{ path: 'tool.js' } as any]).ok).toBe(false);
    expect(checkTool('macro' as any, [{ path: 'tool.js', content: 'var a = 1;' }]).ok).toBe(false);
  });
});

describe('checkTool: extensions', () => {
  const bad: Array<[string, ToolFile[], string?]> = [
    ['<all_urls> without being asked', contentExtension(['<all_urls>']), R.allPages],
    ['*://*/* without being asked', contentExtension(['*://*/*']), R.allPages],
    ['https://*/* without being asked', contentExtension(['https://*/*']), R.allPages],
    ['every .com site', contentExtension(['https://*.com/*']), R.allPages],
    ['a file: match pattern', contentExtension(['file:///*']), R.shape],
    ['host_permissions', manifestWith({ host_permissions: ['https://www.example.com/*'] }), R.access],
    ['background service worker', manifestWith({ background: { service_worker: 'popup.js' } }), R.access],
    ['optional_permissions', manifestWith({ optional_permissions: ['tabs'] }), R.access],
    ['optional_host_permissions', manifestWith({ optional_host_permissions: ['*://*/*'] }), R.access],
    ['web_accessible_resources', manifestWith({ web_accessible_resources: [{ resources: ['popup.js'], matches: ['<all_urls>'] }] }), R.access],
    ['externally_connectable', manifestWith({ externally_connectable: { matches: ['https://www.example.com/*'] } }), R.access],
    ['content_security_policy', manifestWith({ content_security_policy: { extension_pages: "script-src 'self'" } }), R.access],
    ['commands', manifestWith({ commands: {} }), R.access],
    ['update_url', manifestWith({ update_url: 'https://updates.example/x.xml' }), R.access],
    ['key', manifestWith({ key: 'abc' }), R.access],
    ['oauth2', manifestWith({ oauth2: { client_id: 'x', scopes: [] } }), R.access],
    ['the tabs permission', manifestWith({ permissions: ['activeTab', 'tabs'] }), R.access],
    ['the storage permission', manifestWith({ permissions: ['storage'] }), R.access],
    ['manifest_version 2', manifestWith({ manifest_version: 2 }), R.shape],
    ['an unknown key inside action', manifestWith({ action: { default_popup: 'popup.html', default_icon: 'icon.png' } }), R.access],
    ['a popup that is not in the bundle', manifestWith({ action: { default_popup: 'other.html' } }), R.shape],
    ['a popup that is not html', manifestWith({ action: { default_popup: 'popup.js' } }), R.shape],
    ['a web address as the name', manifestWith({ name: 'https://collect.example' }), R.shape],
    ['a manifest that is not JSON', popupExtension({ 'manifest.json': '{ manifest_version: 3 }' }), R.shape],
    ['no manifest', popupExtension().filter(f => f.path !== 'manifest.json'), R.shape],
    ['a second json file', popupExtension({ 'data.json': '{}' }), R.shape],
    ['a file in a folder', popupExtension({ 'js/extra.js': 'var a = 1;' }), R.shape],
    ['an image file', popupExtension({ 'icon.png': 'x' }), R.shape],
    ['a content script file that is missing', [contentExtension(['https://www.example.com/*'])[0]], R.shape],
    ['content script options Fibb does not allow', [
      { path: 'manifest.json', content: JSON.stringify({ manifest_version: 3, name: 'X tool', version: '1.0', content_scripts: [{ matches: ['https://www.example.com/*'], js: ['calm.js'], all_frames: true }] }) },
      { path: 'calm.js', content: 'var a = 1;' },
    ], R.access],
    ['a remote script in the popup', popupExtension({ 'popup.html': POPUP_HTML.replace('src="popup.js"', 'src="https://cdn.example/lib.js"') }), R.net],
    ['a protocol-relative script in the popup', popupExtension({ 'popup.html': POPUP_HTML.replace('src="popup.js"', 'src="//cdn.example/lib.js"') }), R.net],
    ['a script that is not in the bundle', popupExtension({ 'popup.html': POPUP_HTML.replace('src="popup.js"', 'src="other.js"') }), R.net],
    ['an inline script in the popup', popupExtension({ 'popup.html': POPUP_HTML.replace('<script src="popup.js"></script>', '<script>run()</script>') }), R.dyn],
    ['a script with both a file and inline code', popupExtension({ 'popup.html': POPUP_HTML.replace('></script>', '>run()</script>') }), R.dyn],
    ['an inline event handler', popupExtension({ 'popup.html': POPUP_HTML.replace('<button id="count">', '<button id="count" onclick="run()">') }), R.dyn],
    ['an event handler hidden behind a quoted >', popupExtension({ 'popup.html': POPUP_HTML.replace('<button id="count">', '<button title="a>b" onclick="run()">') })],
    ['an image in the popup', popupExtension({ 'popup.html': POPUP_HTML.replace('<p id="result"></p>', '<img src="p.png">') }), R.element],
    ['an iframe in the popup', popupExtension({ 'popup.html': POPUP_HTML.replace('<p id="result"></p>', '<iframe></iframe>') }), R.element],
    ['a link in the popup', popupExtension({ 'popup.html': POPUP_HTML.replace('<p id="result"></p>', '<a href="popup.html">x</a>') }), R.element],
    ['a form in the popup', popupExtension({ 'popup.html': POPUP_HTML.replace('<p id="result"></p>', '<form></form>') }), R.element],
    ['a meta refresh', popupExtension({ 'popup.html': POPUP_HTML.replace('<meta charset="utf-8">', '<meta http-equiv="refresh" content="0">') }), R.unclear],
    ['a remote stylesheet', popupExtension({ 'popup.html': POPUP_HTML.replace('href="popup.css"', 'href="https://cdn.example/x.css"') }), R.net],
    ['inline style with url(', popupExtension({ 'popup.html': POPUP_HTML.replace('<p id="result">', '<p id="result" style="background: url(p.png)">') }), R.net],
    ['a style block with @import', popupExtension({ 'popup.html': POPUP_HTML.replace('</head>', '<style>@import "x.css";</style></head>') }), R.net],
    ['numeric character codes', popupExtension({ 'popup.html': POPUP_HTML.replace('Count words', '&#106;oin') }), R.obf],
    ['css url(', popupExtension({ 'popup.css': 'body { background: url(p.png); }' }), R.net],
    ['css URL( in upper case with a space', popupExtension({ 'popup.css': 'body { background: URL (p.png); }' }), R.net],
    ['css @import', popupExtension({ 'popup.css': '@import "other.css";' }), R.net],
    ['css expression(', popupExtension({ 'popup.css': 'p { width: expression(run()); }' }), R.dyn],
    ['css escapes', popupExtension({ 'popup.css': 'p { background: u\\72l(p.png); }' }), R.obf],
    ['css @font-face', popupExtension({ 'popup.css': '@font-face { font-family: x; }' }), R.net],
    ['chrome.storage', popupExtension({ 'popup.js': 'chrome.storage.local.get("a", function () {});' }), R.browser],
    ['chrome.runtime.sendMessage', popupExtension({ 'popup.js': 'chrome.runtime.sendMessage("x");' }), R.browser],
    ['chrome.runtime.getURL', popupExtension({ 'popup.js': 'var u = chrome.runtime.getURL("popup.html");' }), R.browser],
    ['chrome.tabs.create', popupExtension({ 'popup.js': 'chrome.tabs.create({});' }), R.browser],
    ['chrome through an alias', popupExtension({ 'popup.js': 'var c = chrome; c.tabs.create({});' }), R.browser],
    ['chrome.cookies', popupExtension({ 'popup.js': 'chrome.cookies.getAll({}, function () {});' }), R.secret],
    ['fetch in the popup script', popupExtension({ 'popup.js': POPUP_JS + '\nfetch("/x");' }), R.net],
    ['injecting a script file that is not in the bundle', popupExtension({ 'popup.js': 'chrome.scripting.executeScript({ target: { tabId: 1 }, files: ["other.js"] });' }), R.unclear],
    ['injecting a script file by variable', popupExtension({ 'popup.js': 'var list = ["popup.js"]; chrome.scripting.executeScript({ target: { tabId: 1 }, files: list });' }), R.unclear],
  ];
  it.each(bad)('refuses %s', (_label, files, reason) => {
    const r = checkTool('extension', files);
    expect(r.ok).toBe(false);
    if (reason) expect(r.reasons).toContain(reason);
  });

  it('allowAllPages only widens the match patterns', () => {
    expect(checkTool('extension', contentExtension(['*://*/*']), { allowAllPages: true }).ok).toBe(true);
    expect(checkTool('extension', contentExtension(['https://*.com/*']), { allowAllPages: true }).ok).toBe(false);
    expect(checkTool('extension', contentExtension(['<all_urls>'], { host_permissions: ['<all_urls>'] }), { allowAllPages: true }).ok).toBe(false);
    expect(checkTool('extension', contentExtension(['<all_urls>']), { allowAllPages: false }).ok).toBe(false);
  });

  it('allows injecting a bundled script file', () => {
    const js = 'chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) { chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, files: ["page.js"] }); });';
    expect(checkTool('extension', popupExtension({ 'popup.js': js, 'page.js': 'document.body.classList.add("x");' })).ok).toBe(true);
  });
});

describe('checkTool: Apps Script', () => {
  const services = ['GmailApp.sendEmail("a", "b", "c")', 'MailApp.sendEmail("a", "b", "c")', 'DriveApp.getFiles()',
    'ScriptApp.newTrigger("a")', 'ScriptApp.getProjectTriggers()', 'PropertiesService.getUserProperties()',
    'CacheService.getUserCache()', 'Session.getActiveUser()', 'Jdbc.getConnection("x")', 'ContactsApp.getContacts()',
    'CalendarApp.getDefaultCalendar()', 'LockService.getScriptLock()', 'FormApp.getActiveForm()', 'Drive.Files.list()',
    'LanguageApp.translate("a", "en", "fr")'];
  it.each(services)('refuses %s', (call) => {
    expect(gs(`function run() { var x = ${call}; }`).reasons).toContain(R.service);
  });

  const bad: Bad[] = [
    ['UrlFetchApp', 'function run() { UrlFetchApp.fetch("x"); }', R.net],
    ['ScriptApp.getOAuthToken', 'function run() { return ScriptApp.getOAuthToken(); }', R.service],
    ['HtmlService with a script', 'function run() { DocumentApp.getUi().showSidebar(HtmlService.createHtmlOutput("<script>run()</script>")); }', R.element],
    ['HtmlService with an image', 'function run() { return HtmlService.createHtmlOutput("<img src=x>"); }', R.element],
    ['HtmlService with an event handler', 'function run() { return HtmlService.createHtmlOutput("<p onclick=run()>x</p>"); }', R.dyn],
    ['HtmlService with a variable', 'function run() { var h = "x"; return HtmlService.createHtmlOutput(h); }', R.service],
    ['HtmlService with joined text', 'function run() { return HtmlService.createHtmlOutput("<p>" + DocumentApp.getActiveDocument().getName() + "</p>"); }', R.service],
    ['HtmlService.createTemplate', 'function run() { return HtmlService.createTemplate("x"); }', R.service],
    ['HtmlService.createHtmlOutputFromFile', 'function run() { return HtmlService.createHtmlOutputFromFile("page"); }', R.service],
    ['Utilities.base64Encode', 'function run() { return Utilities.base64Encode("x"); }', R.service],
    ['Utilities.newBlob', 'function run() { return Utilities.newBlob("x"); }', R.service],
    ['DocumentApp.openById', 'function run() { return DocumentApp.openById("abc"); }', R.service],
    ['SpreadsheetApp.openByUrl', 'function run() { return SpreadsheetApp.openByUrl("x"); }', R.service],
    ['DocumentApp.create', 'function run() { return DocumentApp.create("x"); }', R.service],
    ['a Sheets formula', 'function run() { SpreadsheetApp.getActiveSheet().getRange("A1").setFormula("x"); }', R.service],
    ['a Sheets value (can be a formula)', 'function run() { SpreadsheetApp.getActiveSheet().getRange("A1").setValue("x"); }', R.service],
    ['a link in the document', 'function run() { DocumentApp.getActiveDocument().getBody().editAsText().setLinkUrl("x"); }', R.service],
    ['a web app', 'function doGet() { return 1; }', R.net],
    ['a Slides picture fill', 'function run() { SlidesApp.getActivePresentation().getSlides()[0].getBackground().setPictureFill("x"); }', R.service],
    ['a Slides image', 'function run() { var all = SlidesApp.getActivePresentation().getSlides()[0].getImages(); }', R.service],
    ['a Sheets find and replace', 'function run() { SpreadsheetApp.getActiveSheet().createTextFinder("a").replaceAllWith("b"); }', R.service],
    ['sharing the document', 'function run() { DocumentApp.getActiveDocument().addEditor("reader@example.com"); }', R.service],
    ['this as the global object', 'function run() { var g = this; }', R.unclear],
    ['eval', 'function run() { eval("1"); }', R.dyn],
    ['a web address', 'function run() { var u = "https://collect.example"; }', R.net],
  ];
  it.each(bad)('refuses %s', (_label, code, reason) => {
    const r = gs(code);
    expect(r.ok).toBe(false);
    if (reason) expect(r.reasons).toContain(reason);
  });
});
