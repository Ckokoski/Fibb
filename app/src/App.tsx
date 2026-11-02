import { useCallback, useEffect, useState } from 'react';
import { Rail, type View } from './components/Rail';
import { ChatView } from './components/ChatView';
import { TonightPanel } from './components/TonightPanel';
import { TonightSheet } from './components/TonightSheet';
import { SettingsView } from './components/SettingsView';
import { EmptyState } from './components/EmptyState';
import { VoiceControls } from './components/VoiceControls';
import { applyTheme, cycleTheme, getTheme, type Theme } from './lib/theme';
import { getCompanion, getFacts, type Companion, type Facts } from './lib/api';
import { micSupported } from './lib/voice';

const VOICE_KEY = 'fibb_voice';
const ONBOARDED_KEY = 'fibb_onboarded';

function loadVoice(): { readAloud: boolean; handsFree: boolean } {
  try {
    const j = JSON.parse(localStorage.getItem(VOICE_KEY) || '{}');
    return { readAloud: !!j.readAloud, handsFree: !!j.handsFree };
  } catch { return { readAloud: false, handsFree: false }; }
}
function isOnboarded(): boolean { try { return !!localStorage.getItem(ONBOARDED_KEY); } catch { return true; } }

export function App() {
  const [view, setView] = useState<View>('chat');
  const [theme, setTheme] = useState<Theme>(getTheme);
  const [turn, setTurn] = useState(0);
  const [facts, setFacts] = useState<Facts | null>(null);
  const [companion, setCompanionState] = useState<Companion | null>(null);
  const [voice, setVoice] = useState(loadVoice);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [onboarded, setOnboarded] = useState(isOnboarded);
  const micAvailable = micSupported();

  useEffect(() => { applyTheme(theme); }, [theme]);
  useEffect(() => { getFacts().then(setFacts).catch(() => {}); }, [turn]);
  const loadCompanion = useCallback(() => { getCompanion().then(c => { if (c) setCompanionState(c); }).catch(() => {}); }, []);
  useEffect(() => { loadCompanion(); }, [loadCompanion]);
  useEffect(() => { try { localStorage.setItem(VOICE_KEY, JSON.stringify(voice)); } catch { /* ignore */ } }, [voice]);

  const book = facts?.books?.[0];
  const onboarding = !onboarded && facts !== null && !facts.name;
  const mascotState = listening ? 'listening' : busy ? 'thinking' : 'idle';
  const picked = (c: Companion) => {
    setCompanionState(c);
    try { localStorage.setItem(ONBOARDED_KEY, '1'); } catch { /* ignore */ }
    setOnboarded(true);
  };

  return (
    <div className="shell">
      <Rail view={view} onChange={setView} />
      <main className="main">
        <header className="topbar">
          <span className="title">Fibb</span>
          <span className="pill" title="Fibb is in beta; expect rough edges">Beta</span>
          {companion && <span className="ctx">· {companion.name}</span>}
          {book && <span className="ctx">· working on <b>{book.title}</b>{book.chapter ? ` · ch. ${book.chapter}` : ''}</span>}
          <div className="right">
            <VoiceControls readAloud={voice.readAloud} handsFree={voice.handsFree} micAvailable={micAvailable}
              onReadAloud={() => setVoice(v => ({ ...v, readAloud: !v.readAloud }))}
              onHandsFree={() => setVoice(v => ({ ...v, handsFree: !v.handsFree }))} />
            <button className="pill" onClick={() => setTheme(t => cycleTheme(t))} title="Theme">
              {theme === 'dark' ? 'Dark' : theme === 'light' ? 'Light' : 'Auto'}
            </button>
            <a className="pill" href="/legacy/" title="Previous dashboard">Legacy</a>
          </div>
        </header>
        <div className="view" hidden={view !== 'chat'}>
          <ChatView active={view === 'chat'} onTurn={() => setTurn(t => t + 1)} companionName={companion?.name ?? 'Fibb'}
            readAloud={voice.readAloud} handsFree={voice.handsFree} voicePreset={companion?.voicePreset}
            onboarding={onboarding} onPicked={picked} onBusy={setBusy} onListening={setListening} onOpenTonight={() => setSheet(true)} />
        </div>
        {view === 'settings' && <SettingsView companion={companion} onCompanionChanged={loadCompanion} />}
        {view === 'books' && <EmptyState title="No books yet" text="Tell your companion what you're writing and it will keep the bible, the chapters, and the goal here." action="Start in chat" onAction={() => setView('chat')} />}
        {view === 'ideas' && <EmptyState title="Nothing captured yet" text="Say 'idea: …' in chat and it lands here." />}
        {view === 'review' && <EmptyState title="Nothing to review" text="Overnight work will wait here for your yes." />}
      </main>
      <TonightPanel refreshKey={turn} companion={companion} state={mascotState} />
      <TonightSheet open={sheet} onClose={() => setSheet(false)} refreshKey={turn} companion={companion} state={mascotState} />
    </div>
  );
}
