import { useEffect, useRef, useState } from 'react';
import { streamChat } from '../lib/api';
import { Message, type ChatMessage } from './Message';
import { Composer } from './Composer';
import { FirstRunCard } from './FirstRunCard';

const STORE = 'fibb_chat_webchat';
const GREETING = "Hi, I'm Fibb. I'm your writing partner: I keep your book straight, draft when you want me to, and work on it while you sleep. What's your name, and what are you working on?";

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
  return [{ id: 'greet', role: 'assistant', content: GREETING }];
}

export function ChatView({ onTurn, active }: { onTurn: () => void; active: boolean }) {
  const [msgs, setMsgs] = useState<ChatMessage[]>(load);
  const [busy, setBusy] = useState(false);
  const [needsProvider, setNeedsProvider] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { try { localStorage.setItem(STORE, JSON.stringify(msgs.slice(-200))); } catch { /* ignore */ } }, [msgs]);
  const lastLen = msgs[msgs.length - 1]?.content.length ?? 0;
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs.length, lastLen, busy]);
  useEffect(() => { if (active) endRef.current?.scrollIntoView(); }, [active]);

  const send = async (text: string) => {
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
    } catch {
      setMsgs(m => m.map(x => x.id === aid ? { ...x, content: x.content || 'Fibb could not reach the server. Is it running?', streaming: false } : x));
    } finally {
      setBusy(false);
      onTurn();
    }
  };

  const chips = msgs.length <= 1
    ? ["I'm working on a novel", 'Help me find a premise', "What can you do?"]
    : ['Check the last chapter', "What's on tonight?", 'Brainstorm a scene'];

  return (
    <>
      <div className="thread">
        <div className="thread-inner">
          <div className="day">Today</div>
          {msgs.map(m => <Message key={m.id} m={m} />)}
          {needsProvider && <FirstRunCard onDone={() => { setNeedsProvider(false); send('Thanks, you’re connected now. Say hi?'); }} />}
          <div ref={endRef} />
        </div>
      </div>
      <div className="chips">
        {chips.map(c => <button key={c} className="chip" onClick={() => send(c)} disabled={busy}>{c}</button>)}
      </div>
      <Composer onSend={send} disabled={busy} />
    </>
  );
}
