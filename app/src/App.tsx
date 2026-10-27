import { useEffect, useState } from 'react';
import { Rail, type View } from './components/Rail';
import { ChatView } from './components/ChatView';
import { TonightPanel } from './components/TonightPanel';
import { applyTheme, cycleTheme, getTheme, type Theme } from './lib/theme';
import { getFacts, type Facts } from './lib/api';

export function App() {
  const [view, setView] = useState<View>('chat');
  const [theme, setTheme] = useState<Theme>(getTheme);
  const [turn, setTurn] = useState(0);
  const [facts, setFacts] = useState<Facts | null>(null);

  useEffect(() => { applyTheme(theme); }, [theme]);
  useEffect(() => { getFacts().then(setFacts).catch(() => {}); }, [turn]);

  const book = facts?.books?.[0];

  return (
    <div className="shell">
      <Rail view={view} onChange={setView} />
      <main className="main">
        <header className="topbar">
          <span className="title">Fibb</span>
          {book && <span className="ctx">· working on <b>{book.title}</b>{book.chapter ? ` · ch. ${book.chapter}` : ''}</span>}
          <div className="right">
            <button className="pill" onClick={() => setTheme(t => cycleTheme(t))} title="Theme">
              {theme === 'dark' ? 'Dark' : theme === 'light' ? 'Light' : 'Auto'}
            </button>
            <a className="pill" href="/legacy/" title="Previous dashboard">Legacy</a>
          </div>
        </header>
        <div className="view" hidden={view !== 'chat'}><ChatView active={view === 'chat'} onTurn={() => setTurn(t => t + 1)} /></div>
        {view !== 'chat' && (
          <div className="thread"><div className="thread-inner">
            <div className="card"><div className="t">{view[0].toUpperCase() + view.slice(1)}</div>
              <div className="s">This view arrives in a later update. Everything you need today lives in Chat; the previous dashboard is under Legacy.</div></div>
          </div></div>
        )}
      </main>
      <TonightPanel refreshKey={turn} />
    </div>
  );
}
