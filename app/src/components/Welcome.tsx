import type { JSX } from 'react';
import type { Facts, WritingStats } from '../lib/api';
import { Ico } from './icons';
import { useEffect, useState } from 'react';
import { acceptNotice, dismissNotice, getNotices, type Notice, type Task } from '../lib/tasks';

const { pen, spark, moon, book, help } = Ico;

interface WelcomeCard { icon: JSX.Element; title: string; hint: string; send?: string; tonight?: boolean }

export function greetingFor(hour: number): string {
  return hour < 5 ? 'Still up' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

export function Welcome({ facts, stats, review = [], onOpenTasks, hasHistory, disabled, onSend, onTonight, onEarlier }: {
  facts: Facts | null; stats: WritingStats; review?: Task[]; onOpenTasks?: () => void; hasHistory: boolean; disabled: boolean;
  onSend: (t: string) => void; onTonight: () => void; onEarlier: () => void;
}) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [noticeNote, setNoticeNote] = useState('');
  useEffect(() => { void getNotices().then(n => setNotice(n[0] ?? null)); }, []);
  const b = facts?.books?.[0];
  const name = facts?.name ? `, ${facts.name}` : '';
  const streak = Number(stats.currentStreakDays ?? 0);
  const today = Number(stats.wordsToday ?? 0);
  const line = b ? `${b.chapter ? `Chapter ${b.chapter} of ${b.title}` : b.title} is waiting.` : 'What are we writing?';
  const sub = b
    ? (today > 0 ? `${today.toLocaleString()} words today${streak > 1 ? ` and a ${streak}-day streak` : ''}. Keep going?`
      : streak > 1 ? `You're on a ${streak}-day streak. Let's keep it alive.`
      : 'Pick up where you left off, or hand me something to do.')
    : "Tell me about your book and I'll keep every thread straight.";
  const cards: WelcomeCard[] = b
    ? [
      { icon: pen, title: `Pick up ${b.title}`, hint: b.chapter ? `You're on chapter ${b.chapter}` : 'Right where you left off', send: `Let's pick up ${b.title} where I left off.` },
      { icon: spark, title: 'Brainstorm a scene', hint: 'Three directions, you choose', send: 'Brainstorm the next scene with me.' },
      { icon: moon, title: "What's on tonight?", hint: 'Your streak, goal and queue', tonight: true },
    ]
    : [
      { icon: book, title: "I'm working on a novel", hint: 'Tell Fibb about it', send: "I'm working on a novel" },
      { icon: spark, title: 'Help me find a premise', hint: 'Start from a spark', send: 'Help me find a premise' },
      { icon: help, title: 'What can you do?', hint: 'A quick tour', send: 'What can you do?' },
    ];
  // Morning brief: finished work waiting for a yes takes over the greeting.
  if (review.length > 0) {
    const first = (t: Task) => (t.result || '').split('\n').map(l => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) || 'Ready to read';
    return (
      <div className="welcome">
        <h1>{greetingFor(new Date().getHours())}{name}.<br /><span>{review.length === 1 ? 'I finished something for you.' : `I finished ${review.length} things for you.`}</span></h1>
        <p className="sub">Read each one, then keep it or throw it away.</p>
        <div className="wcards">
          {review.slice(0, 3).map(t => (
            <button key={t.id} className="wcard" onClick={onOpenTasks}>
              <div className="ic">{moon}</div>
              <div><b>{t.title}</b><small>{first(t).slice(0, 90)}</small></div>
            </button>
          ))}
        </div>
        <button className="earlier" onClick={onEarlier}>{hasHistory ? 'Back to our conversation' : 'Start chatting'}</button>
      </div>
    );
  }
  return (
    <div className="welcome">
      <h1>{greetingFor(new Date().getHours())}{name}.<br /><span>{line}</span></h1>
      <p className="sub">{sub}</p>
      <div className="wcards">
        {cards.map(c => (
          <button key={c.title} className="wcard" disabled={disabled} onClick={() => (c.tonight ? onTonight() : c.send && onSend(c.send))}>
            <div className="ic">{c.icon}</div>
            <div><b>{c.title}</b><small>{c.hint}</small></div>
          </button>
        ))}
      </div>
      {notice && (
        <div className="notice" role="group" aria-label="Fibb noticed something">
          <div className="notice-k">I noticed</div>
          <div className="notice-t">{noticeNote || notice.text}</div>
          {!noticeNote && (
            <div className="act">
              {notice.action && <button className="btn pri" onClick={async () => {
                const r = await acceptNotice(notice.id);
                if (r.say) { setNotice(null); onSend(r.say); return; }
                setNoticeNote(r.ok ? (r.message || 'Done. You can change it under Tasks.') : 'That did not work. Try again later.');
              }}>{notice.action.label}</button>}
              <button className="btn quiet" onClick={async () => { await dismissNotice(notice.id); setNotice(null); }}>Not now</button>
            </div>
          )}
        </div>
      )}
      {hasHistory && <button className="earlier" onClick={onEarlier}>Show our earlier conversation</button>}
    </div>
  );
}
