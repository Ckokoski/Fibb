import type { JSX } from 'react';
import type { Facts, WritingStats } from '../lib/api';
import type { Task } from '../lib/tasks';

const ic = (d: JSX.Element) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d}</svg>;
const pen = ic(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>);
const spark = ic(<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />);
const moon = ic(<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />);
const book = ic(<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5z" />);
const help = ic(<><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7M12 17h.01" /></>);

interface WelcomeCard { icon: JSX.Element; title: string; hint: string; send?: string; tonight?: boolean }

export function greetingFor(hour: number): string {
  return hour < 5 ? 'Still up' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

export function Welcome({ facts, stats, review = [], onOpenTasks, hasHistory, disabled, onSend, onTonight, onEarlier }: {
  facts: Facts | null; stats: WritingStats; review?: Task[]; onOpenTasks?: () => void; hasHistory: boolean; disabled: boolean;
  onSend: (t: string) => void; onTonight: () => void; onEarlier: () => void;
}) {
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
      {hasHistory && <button className="earlier" onClick={onEarlier}>Show our earlier conversation</button>}
    </div>
  );
}
