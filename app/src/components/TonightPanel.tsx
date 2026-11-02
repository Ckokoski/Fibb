import { useEffect, useState } from 'react';
import { getFacts, getWritingStats, type Companion, type Facts, type WritingStats } from '../lib/api';

export function TonightBody({ refreshKey, companion }: { refreshKey: number; companion: Companion | null }) {
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
        <div className="streak"><span className="n">{streak}</span><span className="l">day streak · {words.toLocaleString()} words</span></div>
        {book?.goal && (<>
          <div className="bar"><i style={{ width: book.chapter ? `${Math.min(100, book.chapter * 4)}%` : '8%' }} /></div>
          <div className="kv"><span>{book.title}</span><span>{book.goal}</span></div>
        </>)}
      </div>
      <div>
        <h4>Tonight</h4>
        <div className="tasks">
          <div className="task"><div><div className="tt">Nothing queued yet</div><div className="ts">Tell {who} “tonight, draft the next chapter” to queue work. Overnight runs arrive in the next update.</div></div></div>
        </div>
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
