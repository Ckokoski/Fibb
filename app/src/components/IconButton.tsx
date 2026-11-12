import type { ReactNode } from 'react';
import { Ico } from './icons';

export function IconButton({ label, on, pressed, onClick, children, className = '' }: {
  label: string; on?: boolean; pressed?: boolean; onClick: () => void; children: ReactNode; className?: string;
}) {
  return (
    <button type="button" className={`ibtn${on ? ' on' : ''} ${className}`.trim()} onClick={onClick} title={label} aria-label={label} aria-pressed={pressed}>
      {children}
    </button>
  );
}

export const Icons = { command: Ico.search, speaker: Ico.speaker, wave: Ico.wave, moon: Ico.moon, sun: Ico.sun, auto: Ico.auto };
