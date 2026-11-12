import { useEffect, useRef, useState, type JSX } from 'react';
import { Ico } from './icons';
import { streamChat, speak, getWritingStats, type Facts, type WritingStats } from '../lib/api';
import { startListening, stopPlayback, playUrl, micSupported, type Listener } from '../lib/voice';
import { Message, type ChatMessage } from './Message';
import { Composer } from './Composer';
import { FirstRunCard } from './FirstRunCard';
import { Welcome } from './Welcome';
import { cue } from '../lib/sound';
import { WorkStrip } from './Work';
import { groupTasks, type Approval, type Task } from '../lib/tasks';

export interface ChatApi { say: (text: string) => void; readLast: () => void }

const CHIP_ICON: Record<string, JSX.Element> = {
  "I'm working on a novel": Ico.book, 'Help me find a premise': Ico.spark, 'What can you do?': Ico.help,
  'Check the last chapter': Ico.chapter, "What's on tonight?": Ico.moon, 'Brainstorm a scene': Ico.spark, 'Read that back to me': Ico.speaker,
};
const STORE = 'fibb_chat_webchat';
const GREETING = "Hi, I'm Fibb. I keep your book straight, draft when you ask, and work on it while you sleep. What's your name, and what are you working on?";
// Cheap heuristic: a reply that sounds like praise or a streak milestone makes the hero celebrate for a moment.
const CELEBRATE_RE = /(congrat|well done|nice work|🎉|\bstreak\b)/i;

function load(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const restored = (parsed as ChatMessage[])
          .map(m => ({ ...m, streaming: false, ...(m.id === 'greet' ? { content: GREETING } : {}) }))
          .filter(m => !(m.role === 'assistant' && !m.content));
        if (restored.length) return restored;
      }
    }
  } catch { /* ignore */ }
  return [{ id: 'greet', role: 'assistant', content: GREETING }];
}

export function ChatView({ apiRef, work, onOpenTasks, facts, onWelcome, onTurn, active, companionName, readAloud, handsFree, voicePreset, onBusy, onSpeaking, onListening, onCelebrate, onOpenTonight }: {
  apiRef?: { current: ChatApi | null };
  work: { tasks: Task[]; approvals: Approval[]; reload: () => void }; onOpenTasks: () => void;
  facts: Facts | null; onWelcome: (w: boolean) => void;
  onTurn: () => void; active: boolean; companionName: string; readAloud: boolean; handsFree: boolean; voicePreset?: string;
  onBusy: (b: boolean) => void; onSpeaking: (b: boolean) => void; onListening: (b: boolean) => void; onCelebrate: () => void; onOpenTonight: () => void;
}) {
  const [msgs, setMsgs] = useState<ChatMessage[]>(load);
  const [busy, setBusy] = useState(false);
  // Each time the app opens, Fibb greets first; the thread appears once the author says something.
  const [welcome, setWelcome] = useState(true);
  const [toolNote, setToolNote] = useState('');
  const [stats, setStats] = useState<WritingStats>({});
  useEffect(() => { void getWritingStats().then(setStats); }, []);
  useEffect(() => { onWelcome(welcome); }, [welcome, onWelcome]);
  const [needsProvider, setNeedsProvider] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const listenerRef = useRef<Listener | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const speakTokenRef = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef({ readAloud, handsFree, voicePreset });
  const sendRef = useRef<(t: string, spoken?: boolean) => Promise<void>>(async () => {});
  const toggleMicRef = useRef<() => void>(() => {});
  useEffect(() => { settingsRef.current = { readAloud, handsFree, voicePreset }; });

  useEffect(() => { try { localStorage.setItem(STORE, JSON.stringify(msgs.slice(-200))); } catch { /* ignore */ } }, [msgs]);
  const lastLen = msgs[msgs.length - 1]?.content.length ?? 0;
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs.length, lastLen, busy]);
  useEffect(() => { if (active && !welcome) endRef.current?.scrollIntoView(); }, [active, welcome]);
  useEffect(() => { onListening(listening); }, [listening, onListening]);
  useEffect(() => { onBusy(busy); }, [busy, onBusy]);
  useEffect(() => { onSpeaking(speaking); }, [speaking, onSpeaking]);
  useEffect(() => () => { listenerRef.current?.stop(); stopPlayback(); }, []);

  const toggleMic = () => {
    // Use the ref (not `listening` state) so a call from a stale closure still toggles correctly.
    if (listenerRef.current) { listenerRef.current.stop(); listenerRef.current = null; setListening(false); return; }
    stopPlayback(); setListening(true); setInterim('');
    listenerRef.current = startListening(
      setInterim,
      (final) => { setListening(false); setInterim(''); listenerRef.current = null; if (final.trim()) void sendRef.current(final.trim(), true); },
      (msg) => { setWelcome(false); setListening(false); setInterim(''); listenerRef.current = null; setMsgs(m => [...m, { id: crypto.randomUUID(), role: 'assistant', content: `Mic problem: ${msg}` }]); },
    );
  };
  toggleMicRef.current = toggleMic;

  const readOut = async (t: string) => {
    const tok = ++speakTokenRef.current;
    setSpeaking(true);
    try {
      const u = await speak(t, settingsRef.current.voicePreset);
      if (u && !listenerRef.current) await playUrl(u);
    } catch { /* ignore audio errors */ }
    finally { if (speakTokenRef.current === tok) setSpeaking(false); }
  };

  const send = async (text: string, spoken = false) => {
    const uid = crypto.randomUUID();
    const aid = crypto.randomUUID();
    setWelcome(false);
    setMsgs(m => [...m, { id: uid, role: 'user', content: text }, { id: aid, role: 'assistant', content: '', streaming: true }]);
    setBusy(true);
    let acc = '';
    try {
      for await (const ev of streamChat(text)) {
        if (ev.type === 'chunk') { acc += ev.content; setMsgs(m => m.map(x => x.id === aid ? { ...x, content: acc } : x)); }
        else if (ev.type === 'tool') { setToolNote(ev.status === 'done' ? '' : ev.summary); if (ev.status === 'needs-approval') work.reload(); }
        else if (ev.type === 'done') { acc = ev.content || acc; setMsgs(m => m.map(x => x.id === aid ? { ...x, content: acc, streaming: false } : x)); }
        else if (ev.type === 'error') {
          if (/no ai provider/i.test(ev.message)) setNeedsProvider(true);
          setMsgs(m => m.map(x => x.id === aid ? { ...x, content: ev.message, streaming: false } : x));
        }
      }
    } catch {
      setMsgs(m => m.map(x => x.id === aid ? { ...x, content: x.content || `${companionName} could not reach the server. Is it running?`, streaming: false } : x));
    } finally {
      setToolNote('');
      setBusy(false);
      onTurn();
      if (CELEBRATE_RE.test(acc)) onCelebrate(); else if (acc) cue('done');
    }
    // Spoken reply runs after the composer is free; audio never blocks it.
    const st = settingsRef.current;
    if ((st.readAloud || spoken) && acc) {
      const tok = ++speakTokenRef.current;
      setSpeaking(true);
      try {
        const url = await speak(acc, st.voicePreset);
        if (url && !listenerRef.current) {
          const natural = await playUrl(url);
          if (natural && settingsRef.current.handsFree && spoken && !listenerRef.current) toggleMicRef.current();
        }
      } catch { /* ignore audio errors */ }
      finally { if (speakTokenRef.current === tok) setSpeaking(false); }
    }
  };
  sendRef.current = send;

  const READ_BACK = 'Read that back to me';
  const chips = msgs.length <= 1
    ? ["I'm working on a novel", 'Help me find a premise', "What can you do?"]
    : ['Check the last chapter', "What's on tonight?", 'Brainstorm a scene', READ_BACK];
  const lastReply = [...msgs].reverse().find(m => m.role === 'assistant' && m.content && !m.streaming);
  if (apiRef) apiRef.current = { say: t => { if (!busy) void send(t); }, readLast: () => { if (lastReply) void readOut(lastReply.content); } };
  const onChip = (c: string) => { if (c === READ_BACK) { if (lastReply) void readOut(lastReply.content); } else send(c); };

  return (
    <>
      {welcome && !needsProvider ? (
        <Welcome facts={facts} stats={stats} review={groupTasks(work.tasks).review} onOpenTasks={onOpenTasks} hasHistory={msgs.length > 1} disabled={busy}
          onSend={t => { void send(t); }} onTonight={onOpenTonight} onEarlier={() => setWelcome(false)} />
      ) : (<>
        <div className="thread">
          <div className="thread-inner">
            {msgs.map(m => <Message key={m.id} m={m} onRead={t => { void readOut(t); }} />)}
            {needsProvider && <FirstRunCard onDone={() => { setNeedsProvider(false); send('Thanks, you’re connected now. Say hi?'); }} />}
            {toolNote && <div className="toolnote" role="status">{toolNote}</div>}
            <div ref={endRef} />
          </div>
        </div>
        <div className="chips">
          <button className="chip tonight" onClick={onOpenTonight}>{Ico.moon}<span>Tonight</span></button>
          {chips.map(c => <button key={c} className="chip" onClick={() => onChip(c)} disabled={busy}>{CHIP_ICON[c] ?? Ico.spark}<span>{c}</span></button>)}
        </div>
      </>)}
      <WorkStrip tasks={work.tasks} approvals={work.approvals} reload={work.reload} />
      <Composer onSend={t => send(t)} disabled={busy} listening={listening} interim={interim} onMic={toggleMic} micAvailable={micSupported()} micDisabled={busy} />
    </>
  );
}
