// app/src/lib/starterTools.ts — hand-written bookmarklets that ship with Fibb.
// Rules every one follows: no network calls, no cookies or storage, no eval, nothing leaves the page.
// They only read the text you selected (or the page's visible text) and show a small panel.

export interface StarterTool { id: string; name: string; blurb: string; access: string[]; code: string }

// Shared helpers, inlined into each bookmarklet. T() returns the selected text, or the page text when nothing is selected.
// P() shows a small panel in the corner that closes on click or Escape.
const LIB = `
var T=function(){var s=String(window.getSelection?window.getSelection():'');return s.trim()?s:(document.body?document.body.innerText:'')};
var W=function(t){return (t.match(/[A-Za-z\\u00C0-\\u024F0-9][A-Za-z\\u00C0-\\u024F0-9'\\u2019-]*/g)||[])};
var P=function(title,rows){var id='fibb-panel',o=document.getElementById(id);if(o)o.remove();
var d=document.createElement('div');d.id=id;
d.style.cssText='position:fixed;z-index:2147483647;right:20px;top:20px;max-width:340px;max-height:70vh;overflow:auto;padding:16px 18px;border-radius:20px;background:#fff;color:#1f2238;font:14px/1.5 system-ui,sans-serif;box-shadow:0 12px 40px rgba(40,50,120,.28);border:1px solid rgba(40,45,90,.12);cursor:pointer';
var h=document.createElement('div');h.textContent=title;h.style.cssText='font-weight:700;margin-bottom:8px;color:#5265d0';d.appendChild(h);
rows.forEach(function(r){var p=document.createElement('div');p.textContent=r;p.style.cssText='margin:3px 0';d.appendChild(p)});
var f=document.createElement('div');f.textContent='Click to close';f.style.cssText='margin-top:10px;font-size:12px;color:#8689a3';d.appendChild(f);
d.onclick=function(){d.remove()};
document.addEventListener('keydown',function k(e){if(e.key==='Escape'){d.remove();document.removeEventListener('keydown',k)}});
document.body.appendChild(d)};
`.replace(/\n/g, '');

const wrap = (body: string) => `(function(){${LIB}${body.replace(/\n\s*/g, '')}})();`;

export const STARTER_TOOLS: StarterTool[] = [
  {
    id: 'word-count', name: 'Word count', blurb: 'Counts the words you selected, or the whole page, and how long it takes to read.',
    access: ['Reads the text you selected or the page text', 'Shows a small panel', 'Sends nothing anywhere'],
    code: wrap(`
      var t=T(),w=W(t).length,c=t.replace(/\\s/g,'').length,m=Math.max(1,Math.round(w/230));
      var s=(t.match(/[^.!?\\n]+[.!?]+/g)||[]).length;
      P('Word count',[w.toLocaleString()+' words',c.toLocaleString()+' characters without spaces',s.toLocaleString()+' sentences','About '+m+' minute'+(m===1?'':'s')+' to read']);
    `),
  },
  {
    id: 'overused-words', name: 'Overused words', blurb: 'Lists the words you lean on most in the selected text, skipping everyday words.',
    access: ['Reads the text you selected or the page text', 'Shows a small panel', 'Sends nothing anywhere'],
    code: wrap(`
      var stop=' the and that with have this from they them their there what when were been will would could should about into than then your you her his she him for not but was are had has its our out who all any can did one how said just like over more some only also very back after even much most such each other ';
      var c={},ws=W(T().toLowerCase());
      ws.forEach(function(x){if(x.length>3&&stop.indexOf(' '+x+' ')<0)c[x]=(c[x]||0)+1});
      var top=Object.keys(c).sort(function(a,b){return c[b]-c[a]}).slice(0,14).filter(function(x){return c[x]>1});
      P('Words you use most',top.length?top.map(function(x){return x+'  \\u00d7 '+c[x]}):['Nothing repeats. Select more text and try again.']);
    `),
  },
  {
    id: 'weak-words', name: 'Filter and filler words', blurb: 'Counts words editors often cut, like just, very, really, suddenly and words ending in -ly.',
    access: ['Reads the text you selected or the page text', 'Shows a small panel', 'Sends nothing anywhere'],
    code: wrap(`
      var ws=W(T().toLowerCase()),list=['just','very','really','suddenly','quite','rather','somewhat','actually','basically','seemed','felt','noticed','realized','began','started'];
      var c={},ly=0;
      ws.forEach(function(x){if(list.indexOf(x)>=0)c[x]=(c[x]||0)+1;if(x.length>4&&/ly$/.test(x)&&['only','early','family','reply','apply','supply','likely','lonely','lovely','ugly','holy','july','belly','silly','jolly','bully','rally','ally','folly','daily','italy'].indexOf(x)<0)ly++});
      var rows=Object.keys(c).sort(function(a,b){return c[b]-c[a]}).map(function(x){return x+'  \\u00d7 '+c[x]});
      rows.push('Words ending in -ly  \\u00d7 '+ly);
      rows.push('Out of '+ws.length.toLocaleString()+' words');
      P('Filter and filler words',rows);
    `),
  },
  {
    id: 'sentence-length', name: 'Sentence rhythm', blurb: 'Shows your average sentence length and your three longest sentences.',
    access: ['Reads the text you selected or the page text', 'Shows a small panel', 'Sends nothing anywhere'],
    code: wrap(`
      var s=(T().match(/[^.!?\\n]+[.!?]+/g)||[]).map(function(x){return x.trim()}).filter(Boolean);
      if(!s.length){P('Sentence rhythm',['Select a paragraph or more and try again.']);return}
      var n=s.map(function(x){return W(x).length}),sum=n.reduce(function(a,b){return a+b},0);
      var order=s.map(function(x,i){return i}).sort(function(a,b){return n[b]-n[a]}).slice(0,3);
      var rows=['Average: '+Math.round(sum/s.length)+' words a sentence','Shortest: '+Math.min.apply(null,n)+'   Longest: '+Math.max.apply(null,n),'Your longest:'];
      order.forEach(function(i){rows.push(n[i]+' words: '+(s[i].length>120?s[i].slice(0,117)+'\\u2026':s[i]))});
      P('Sentence rhythm',rows);
    `),
  },
  {
    id: 'clean-copy', name: 'Copy as clean text', blurb: 'Copies the selected text without formatting, with tidy spaces and curly quotes.',
    access: ['Reads the text you selected', 'Writes to your clipboard', 'Sends nothing anywhere'],
    code: wrap(`
      var t=String(window.getSelection?window.getSelection():'');
      if(!t.trim()){P('Copy as clean text',['Select some text first.']);return}
      t=t.replace(/\\u00a0/g,' ').replace(/[ \\t]+/g,' ').replace(/ ?\\n ?/g,'\\n').replace(/\\n{3,}/g,'\\n\\n').replace(/(^|[\\s(\\[])"/g,'$1\\u201c').replace(/"/g,'\\u201d').replace(/(^|[\\s(\\[])'/g,'$1\\u2018').replace(/'/g,'\\u2019').replace(/--/g,'\\u2014').trim();
      var done=function(ok){P('Copy as clean text',[ok?'Copied '+W(t).length.toLocaleString()+' words.':'Your browser blocked the copy. Try again after clicking the page.'])};
      if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(function(){done(true)},function(){done(false)})}else{done(false)}
    `),
  },
  {
    id: 'focus-mode', name: 'Focus mode', blurb: 'Turns any page into a calm, narrow reading column. Click it again to turn it off.',
    access: ['Changes how the current page looks until you reload', 'Sends nothing anywhere'],
    code: wrap(`
      var id='fibb-focus',o=document.getElementById(id);
      if(o){o.remove();return}
      var st=document.createElement('style');st.id=id;
      st.textContent='body{max-width:680px!important;margin:48px auto!important;padding:0 24px!important;font-size:19px!important;line-height:1.75!important;background:#fdfbf7!important;color:#1f2238!important}nav,aside,header,footer,iframe,[role=banner],[role=navigation],[role=complementary]{display:none!important}img,video{max-width:100%!important;height:auto!important}';
      document.head.appendChild(st);
    `),
  },
];

/** The javascript: address a bookmark needs. */
export function bookmarkletHref(code: string): string { return 'javascript:' + encodeURIComponent(code); }
