import type { JSX } from 'react';
import type { Companion } from '../lib/api';
export type View = 'chat' | 'books' | 'tasks' | 'ideas' | 'settings';

const icons: Record<View, JSX.Element> = {
  chat: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.2A8 8 0 1 1 21 12z"/></svg>,
  books: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>,
  ideas: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/></svg>,
  tasks: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3 8-8"/><path d="M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h10"/></svg>,
  settings: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/></svg>,
};
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
