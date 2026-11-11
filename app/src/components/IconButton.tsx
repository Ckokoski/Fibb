import type { ReactNode } from 'react';

export function IconButton({ label, on, pressed, onClick, children, className = '' }: {
  label: string; on?: boolean; pressed?: boolean; onClick: () => void; children: ReactNode; className?: string;
}) {
  return (
    <button type="button" className={`ibtn${on ? ' on' : ''} ${className}`.trim()} onClick={onClick} title={label} aria-label={label} aria-pressed={pressed}>
      {children}
    </button>
  );
}

const svg = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d}</svg>
);
export const Icons = {
  command: svg(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>),
  speaker: svg(<><path d="M11 5 6 9H2v6h4l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" /></>),
  wave: svg(<path d="M3 12h2M7 8v8M11 4v16M15 8v8M19 10v4" />),
  moon: svg(<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />),
  sun: svg(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>),
  auto: svg(<><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" /></>),
};
