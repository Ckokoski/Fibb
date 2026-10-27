import type { JSX } from 'react';
export type View = 'chat' | 'books' | 'ideas' | 'review' | 'settings';

const icons: Record<View, JSX.Element> = {
  chat: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.2A8 8 0 1 1 21 12z"/></svg>,
  books: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>,
  ideas: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/></svg>,
  review: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13l3.5 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/></svg>,
  settings: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/></svg>,
};
const labels: Record<View, string> = { chat: 'Chat', books: 'Books', ideas: 'Ideas', review: 'Review', settings: 'Settings' };

export function Rail({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  return (
    <nav className="rail" aria-label="Main">
      <div className="logo" aria-hidden />
      {(Object.keys(icons) as View[]).map(v => (
        <button key={v} className={`nav${view === v ? ' on' : ''}`} onClick={() => onChange(v)} aria-label={labels[v]} aria-current={view === v ? 'page' : undefined}>
          {icons[v]}<span className="label">{labels[v]}</span>
        </button>
      ))}
      <div className="spacer" />
    </nav>
  );
}
