import { useEffect, useState } from 'react';
import { groupTasks, runQueued, type Task } from '../lib/tasks';
import { Ring } from './Work';
import { getFacts, getWritingStats, type Companion, type Facts, type WritingStats } from '../lib/api';

export function TonightBody({ refreshKey, companion, tasks = [], onOpenTasks }: { refreshKey: number; companion: Companion | null; tasks?: Task[]; onOpenTasks?: () => void }) {
  const g = groupTasks(tasks);
  const who = companion?.name ?? 'Fibb';
  const [facts, setFacts] = useState<Facts | null>(null);
  const [stats, setStats] = useState<WritingStats>({});
  useEffect(() => { getFacts().then(setFacts).catch(() => {}); getWritingStats().then(setStats); }, [refreshKey]);

  const book = facts?.books?.[0];
  const streak = Number(stats.currentStreakDays ?? 0);
  const words = Number(stats.wordsTotal ?? 0);

  return (
    <>
      <div>
        {streak > 0
          ? <div className="streak"><span className="n">{streak}</span><span className="l">day streak · {words.toLocaleString()} words</span></div>
          : <div className="streak"><span className="l">{words > 0 ? `${words.toLocaleString()} words so far. Write today to start a streak.` : 'Write today to start a streak.'}</span></div>}
        {book?.goal && (<>
          <div className="bar"><i style={{ width: book.chapter ? `${Math.min(100, book.chapter * 4)}%` : '8%' }} /></div>
          <div className="kv"><span>{book.title}</span><span>{book.goal}</span></div>
        </>)}
      </div>
      <div>
        <h4>Tonight</h4>
        <div className="tasks">
          {g.review.length > 0 && <button className="task" onClick={onOpenTasks}><Ring value={100} /><div><div className="tt">{g.review.length} ready for your review</div><div className="ts">Open Tasks to read and keep or discard</div></div></button>}
          {g.running.map(t => <div key={t.id} className="task live"><Ring value={t.progress} spin /><div><div className="tt">{t.title}</div><div className="ts">Working on it · {Math.round(t.progress)}%</div></div></div>)}
          {g.queued.map(t => <div key={t.id} className="task"><Ring value={0} /><div><div className="tt">{t.title}</div><div className="ts">Queued</div></div></div>)}
          {g.queued.length + g.running.length + g.review.length === 0 && <div className="task"><div><div className="tt">Nothing queued yet</div><div className="ts">Say "tonight: draft the next chapter" and {who} will have it ready by morning.</div></div></div>}
        </div>
        {g.queued.length > 0 && <div className="act" style={{ marginTop: 10, display: 'flex', gap: 8 }}><button className="btn" onClick={() => { void runQueued(); }}>Start now</button><button className="btn quiet" onClick={onOpenTasks}>Open Tasks</button></div>}
      </div>
      <div>
        <h4>What {who} knows</h4>
        <div className="muted" style={{ marginTop: 8 }}>
          {facts?.name ? `You're ${facts.name}.` : `${who} will ask your name and what you’re working on.`}
          {book ? ` Working on ${book.title}${book.chapter ? `, ch. ${book.chapter}` : ''}.` : ''}
          {facts?.people?.length ? ` Knows ${facts.people.length} ${facts.people.length === 1 ? 'person' : 'people'} from your work.` : ''}
        </div>
      </div>
    </>
  );
}
