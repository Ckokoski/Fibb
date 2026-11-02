import { useEffect, useRef, useState } from 'react';
import { streamChat, speak } from '../lib/api';
import { startListening, stopPlayback, playUrl, micSupported, type Listener } from '../lib/voice';
import { Message, type ChatMessage } from './Message';
import { Composer } from './Composer';
import { FirstRunCard } from './FirstRunCard';
import { CompanionPicker } from './CompanionPicker';
import type { Companion } from '../lib/api';

const STORE = 'fibb_chat_webchat';
const greeting = (name: string) => `Hi, I'm ${name}. I'm your writing partner inside Fibb: I keep your book straight, draft when you want me to, and work on it while you sleep. What's your name, and what are you working on?`;

function load(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const restored = (parsed as ChatMessage[])
          .map(m => ({ ...m, streaming: false }))
          .filter(m => !(m.role === 'assistant' && !m.content));
        if (restored.length) return restored;
      }
    }
  } catch { /* ignore */ }
  return [{ id: 'greet', role: 'assistant', content: greeting('Fibb') }];
}

export function ChatView({ onTurn, active, companionName, readAloud, handsFree, voicePreset, onboarding, onPicked, onBusy, onListening, onOpenTonight }: {
  onTurn: () => void; active: boolean; companionName: string; readAloud: boolean; handsFree: boolean; voicePreset?: string;
  onboarding: boolean; onPicked: (c: Companion) => void; onBusy: (b: boolean) => void; onListening: (b: boolean) => void; onOpenTonight: () => void;
}) {
  const [msgs, setMsgs] = useState<ChatMessage[]>(load);
  const [busy, setBusy] = useState(false);
  const [needsProvider, setNeedsProvider] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const listenerRef = useRef<Listener | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { try { localStorage.setItem(STORE, JSON.stringify(msgs.slice(-200))); } catch { /* ignore */ } }, [msgs]);
  const lastLen = msgs[msgs.length - 1]?.content.length ?? 0;
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs.length, lastLen, busy]);
  useEffect(() => { if (active) endRef.current?.scrollIntoView(); }, [active]);
  useEffect(() => { onBusy(busy); }, [busy, onBusy]);
  useEffect(() => { onListening(listening); }, [listening, onListening]);
  useEffect(() => () => { listenerRef.current?.stop(); stopPlayback(); }, []);

  const toggleMic = () => {
    // Use the ref (not `listening` state) so a call from a stale send() closure still toggles correctly.
    if (listenerRef.current) { listenerRef.current.stop(); return; }
    stopPlayback(); setListening(true); setInterim('');
    listenerRef.current = startListening(
      setInterim,
      (final) => { setListening(false); setInterim(''); listenerRef.current = null; if (final.trim()) send(final.trim(), true); },
      (msg) => { setListening(false); setInterim(''); listenerRef.current = null; setMsgs(m => [...m, { id: crypto.randomUUID(), role: 'assistant', content: `Mic problem: ${msg}` }]); },
    );
  };

  const readOut = (t: string) => { speak(t, voicePreset).then(u => { if (u) void playUrl(u); }); };

  const send = async (text: string, spoken = false) => {
    const uid = crypto.randomUUID();
    const aid = crypto.randomUUID();
    setMsgs(m => [...m, { id: uid, role: 'user', content: text }, { id: aid, role: 'assistant', content: '', streaming: true }]);
    setBusy(true);
    let acc = '';
    try {
      for await (const ev of streamChat(text)) {
        if (ev.type === 'chunk') { acc += ev.content; setMsgs(m => m.map(x => x.id === aid ? { ...x, content: acc } : x)); }
        else if (ev.type === 'done') { acc = ev.content || acc; setMsgs(m => m.map(x => x.id === aid ? { ...x, content: acc, streaming: false } : x)); }
        else if (ev.type === 'error') {
          if (/no ai provider/i.test(ev.message)) setNeedsProvider(true);
          setMsgs(m => m.map(x => x.id === aid ? { ...x, content: ev.message, streaming: false } : x));
        }
      }
      if ((readAloud || spoken) && acc) {
        const url = await speak(acc, voicePreset);
        if (url) { await playUrl(url); if (handsFree && spoken) toggleMic(); }
      }
    } catch {
      setMsgs(m => m.map(x => x.id === aid ? { ...x, content: x.content || `${companionName} could not reach the server. Is it running?`, streaming: false } : x));
    } finally {
      setBusy(false);
      onTurn();
    }
  };

  const READ_BACK = 'Read that back to me';
  const chips = msgs.length <= 1
    ? ["I'm working on a novel", 'Help me find a premise', "What can you do?"]
    : ['Check the last chapter', "What's on tonight?", 'Brainstorm a scene', READ_BACK];
  const lastReply = [...msgs].reverse().find(m => m.role === 'assistant' && m.content && !m.streaming);
  const onChip = (c: string) => { if (c === READ_BACK) { if (lastReply) readOut(lastReply.content); } else send(c); };

  return (
    <>
      <div className="thread">
        <div className="thread-inner">
          {onboarding && (
            <div className="card" role="region" aria-label="Choose your companion">
              <div className="t">Who do you want to write with?</div>
              <div className="s">Pick a companion. You can change this any time in Settings.</div>
              <CompanionPicker onPicked={onPicked} />
            </div>
          )}
          <div className="day">Today</div>
          {msgs.map(m => <Message key={m.id} m={m.id === 'greet' ? { ...m, content: greeting(companionName) } : m} onRead={readOut} />)}
          {needsProvider && <FirstRunCard onDone={() => { setNeedsProvider(false); send('Thanks, you’re connected now. Say hi?'); }} />}
          <div ref={endRef} />
        </div>
      </div>
      <div className="chips">
        <button className="chip tonight" onClick={onOpenTonight}>Tonight</button>
        {chips.map(c => <button key={c} className="chip" onClick={() => onChip(c)} disabled={busy}>{c}</button>)}
      </div>
      <Composer onSend={t => send(t)} disabled={busy} listening={listening} interim={interim} onMic={toggleMic} micAvailable={micSupported()} />
    </>
  );
}
