import { useCallback, useEffect, useRef, useState } from 'react';
import { Rail, type View } from './components/Rail';
import { ChatView, type ChatApi } from './components/ChatView';
import { CommandBar, type Command } from './components/CommandBar';
import { cue } from './lib/sound';
import { IdeasView, TasksView } from './components/Work';
import { groupTasks, useWork } from './lib/tasks';
import { TonightSheet } from './components/TonightSheet';
import { TonightDrawer } from './components/TonightDrawer';
import { SettingsView } from './components/SettingsView';
import { EmptyState } from './components/EmptyState';
import { Hero } from './components/Hero';
import { IconButton, Icons } from './components/IconButton';
import { applyTheme, cycleTheme, getTheme, type Theme } from './lib/theme';
import { getCompanion, getFacts, getWritingStats, type Companion, type Facts, type MascotStateName } from './lib/api';
import { micSupported } from './lib/voice';

const VOICE_KEY = 'fibb_voice';
const CELEBRATE_MS = 4000;
const POLL_MS = 30000;

function loadVoice(): { readAloud: boolean; handsFree: boolean } {
  try {
    const j = JSON.parse(localStorage.getItem(VOICE_KEY) || '{}');
    return { readAloud: !!j.readAloud, handsFree: !!j.handsFree };
  } catch { return { readAloud: false, handsFree: false }; }
}

function useMediaQuery(q: string): boolean {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q); const h = () => setM(mq.matches);
    h();
    if (mq.addEventListener) mq.addEventListener('change', h); else mq.addListener(h);
    return () => { if (mq.removeEventListener) mq.removeEventListener('change', h); else mq.removeListener(h); };
  }, [q]);
  return m;
}

export function App() {
  const [view, setView] = useState<View>('chat');
  const [theme, setTheme] = useState<Theme>(getTheme);
  const [turn, setTurn] = useState(0);
  const [facts, setFacts] = useState<Facts | null>(null);
  const [companion, setCompanionState] = useState<Companion | null>(null);
  const [voice, setVoice] = useState(loadVoice);
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [tonight, setTonight] = useState(false);
  const [welcome, setWelcome] = useState(true);
  const [cmd, setCmd] = useState(false);
  const chat = useRef<ChatApi | null>(null);
  const work = useWork(turn);
  const waiting = groupTasks(work.tasks).review.length + work.approvals.length;
  // A chime when overnight or background work lands for review.
  const lastReview = useRef<number | null>(null);
  useEffect(() => {
    const n = groupTasks(work.tasks).review.length;
    if (lastReview.current !== null && n > lastReview.current) cue('done');
    lastReview.current = n;
  }, [work.tasks]);
  const [streak, setStreak] = useState(0);
  const [celebrateUntil, setCelebrateUntil] = useState(0);
  const [, setTick] = useState(0);
  const lastStreak = useRef<number | null>(null);
  const celebrateTimer = useRef<number | null>(null);
  const narrow = useMediaQuery('(max-width: 900px)');
  // Crossing the breakpoint while open closes the panel so neither variant is left stale.
  const prevNarrow = useRef(narrow);
  useEffect(() => { if (prevNarrow.current !== narrow) { prevNarrow.current = narrow; setTonight(false); } }, [narrow]);
  const micAvailable = micSupported();

  useEffect(() => { applyTheme(theme); }, [theme]);
  useEffect(() => { getFacts().then(setFacts).catch(() => {}); }, [turn]);
  const loadCompanion = useCallback(() => { getCompanion().then(c => { if (c) setCompanionState(c); }).catch(() => {}); }, []);
  useEffect(() => { loadCompanion(); }, [loadCompanion]);
  useEffect(() => { try { localStorage.setItem(VOICE_KEY, JSON.stringify(voice)); } catch { /* ignore */ } }, [voice]);

  // Celebrate for 4 s. A re-render is scheduled at expiry so the state falls back to idle.
  const celebrate = useCallback(() => {
    setCelebrateUntil(Date.now() + CELEBRATE_MS); cue('celebrate');
    if (celebrateTimer.current) window.clearTimeout(celebrateTimer.current);
    celebrateTimer.current = window.setTimeout(() => setTick(t => t + 1), CELEBRATE_MS + 50);
  }, []);
  useEffect(() => () => { if (celebrateTimer.current) window.clearTimeout(celebrateTimer.current); }, []);

  // A streak increase between stats polls triggers a celebration.
  useEffect(() => {
    let alive = true;
    const poll = () => getWritingStats().then(s => {
      if (!alive) return;
      const n = Number(s.currentStreakDays ?? 0);
      if (lastStreak.current !== null && n > lastStreak.current) celebrate();
      lastStreak.current = n; setStreak(n);
    });
    poll();
    const id = window.setInterval(poll, POLL_MS);
    return () => { alive = false; window.clearInterval(id); };
  }, [turn, celebrate]);

  // Ctrl+K or Cmd+K opens the quick command bar from anywhere.
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setCmd(o => !o); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  const say = useCallback((t: string) => { setView('chat'); chat.current?.say(t); }, []);
  const commands: Command[] = [
    { id: 'tonight', label: 'Open Tonight', run: () => setTonight(true) },
    { id: 'read', label: 'Read the last reply aloud', run: () => chat.current?.readLast() },
    { id: 'aloud', label: voice.readAloud ? 'Turn read aloud off' : 'Turn read aloud on', run: () => setVoice(v => ({ ...v, readAloud: !v.readAloud })) },
    { id: 'theme', label: 'Switch theme', run: () => setTheme(t => cycleTheme(t)) },
    { id: 'go-chat', label: 'Go to Chat', run: () => setView('chat') },
    { id: 'go-books', label: 'Go to Books', run: () => setView('books') },
    { id: 'go-ideas', label: 'Go to Ideas', run: () => setView('ideas') },
    { id: 'go-tasks', label: 'Go to Tasks', run: () => setView('tasks') },
    { id: 'go-settings', label: 'Go to Settings', run: () => setView('settings') },
  ];

  const book = facts?.books?.[0];
  const line2 = book ? `${book.title}${book.chapter ? ` · ch. ${book.chapter}` : ''}` : undefined;
  const mascotState: MascotStateName | 'speaking' = listening ? 'listening' : busy ? 'thinking' : speaking ? 'speaking' : celebrateUntil > Date.now() ? 'celebrating' : 'idle';
  const themeIcon = theme === 'dark' ? Icons.moon : theme === 'light' ? Icons.sun : Icons.auto;

  return (
    <div className="shell">
      <div className="ambient" aria-hidden="true"><i /><i /></div>
      <Rail view={view} onChange={setView} companion={companion} badge={waiting} />
      <div className="page">
        <header className="topbar">
          <span className="title">Fibb</span>
          <span className="pill" title="Fibb is in beta; expect rough edges">Beta</span>
          <div className="right">
            {streak > 0 && <button className="streak-chip" onClick={() => setTonight(true)} title="Open Tonight">🔥 <b>{streak}</b> day streak</button>}
            <IconButton label="Quick command (Ctrl+K)" onClick={() => setCmd(true)}>{Icons.command}</IconButton>
            <IconButton label="Read aloud" pressed={voice.readAloud} on={voice.readAloud} onClick={() => setVoice(v => ({ ...v, readAloud: !v.readAloud }))}>{Icons.speaker}</IconButton>
            {micAvailable && <IconButton label="Hands-free" pressed={voice.handsFree} on={voice.handsFree} onClick={() => setVoice(v => ({ ...v, handsFree: !v.handsFree }))}>{Icons.wave}</IconButton>}
            <IconButton label="Tonight" pressed={tonight} on={tonight} onClick={() => setTonight(t => !t)}>{Icons.moon}</IconButton>
            <IconButton label={`Theme: ${theme === 'dark' ? 'Dark' : theme === 'light' ? 'Light' : 'Auto'}`} onClick={() => setTheme(t => cycleTheme(t))}>{themeIcon}</IconButton>
          </div>
        </header>
        <main className={`main${view === 'chat' && welcome ? ' is-welcome' : ''}`}>
          <Hero c={companion} state={mascotState} line2={line2} compact={view !== 'chat'} big={view === 'chat' && welcome} />
          <div className="view" hidden={view !== 'chat'}>
            <ChatView apiRef={chat} work={work} onOpenTasks={() => setView('tasks')} facts={facts} onWelcome={setWelcome} active={view === 'chat'} onTurn={() => setTurn(t => t + 1)} companionName="Fibb"
              readAloud={voice.readAloud} handsFree={voice.handsFree} voicePreset={companion?.voicePreset}
              onBusy={setBusy} onSpeaking={setSpeaking} onListening={setListening} onCelebrate={celebrate} onOpenTonight={() => setTonight(true)} />
          </div>
          {view === 'settings' && <SettingsView companion={companion} onCompanionChanged={loadCompanion} />}
          {view === 'books' && <EmptyState title="No books yet" text="Tell Fibb what you're writing and it will keep the bible, the chapters, and the goal here." action="Start in chat" onAction={() => setView('chat')} />}
          {view === 'ideas' && <IdeasView tasks={work.tasks} reload={work.reload} onChat={() => setView('chat')} />}
          {view === 'tasks' && <TasksView tasks={work.tasks} approvals={work.approvals} reload={work.reload} />}
        </main>
      </div>
      {cmd && <CommandBar open onClose={() => setCmd(false)} commands={commands} onSay={say} />}
      {narrow
        ? <TonightSheet open={tonight} onClose={() => setTonight(false)} refreshKey={turn} companion={companion} tasks={work.tasks} onOpenTasks={() => { setTonight(false); setView('tasks'); }} />
        : <TonightDrawer open={tonight} onClose={() => setTonight(false)} refreshKey={turn} companion={companion} tasks={work.tasks} onOpenTasks={() => { setTonight(false); setView('tasks'); }} />}
    </div>
  );
}
