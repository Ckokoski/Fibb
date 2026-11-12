import type { JSX } from 'react';
import type { Companion } from '../lib/api';
import { Ico } from './icons';
export type View = 'chat' | 'books' | 'tasks' | 'ideas' | 'settings';

const icons: Record<View, JSX.Element> = { chat: Ico.chat, books: Ico.book, tasks: Ico.tasks, ideas: Ico.idea, settings: Ico.settings };
const labels: Record<View, string> = { chat: 'Chat', books: 'Books', ideas: 'Ideas', tasks: 'Tasks', settings: 'Settings' };

const ORDER: View[] = ['chat', 'books', 'tasks', 'ideas', 'settings'];

export function Rail({ view, onChange, companion, badge = 0 }: { view: View; onChange: (v: View) => void; companion?: Companion | null; badge?: number }) {
  return (
    <nav className="rail" aria-label="Main">
      <img className="logo" src={companion?.states?.idle ?? companion?.image ?? "/mascots/nib/nib-idle.svg"} alt="" aria-hidden draggable={false} />
      {ORDER.map(v => (
        <button key={v} className={`nav${view === v ? ' on' : ''}`} onClick={() => onChange(v)} aria-label={labels[v]} aria-current={view === v ? 'page' : undefined}>
          {icons[v]}<span className="label">{labels[v]}</span>{v === 'tasks' && badge > 0 && <span className="nav-badge" aria-label={`${badge} waiting for you`}>{badge}</span>}
        </button>
      ))}
      <div className="spacer" />
    </nav>
  );
}
