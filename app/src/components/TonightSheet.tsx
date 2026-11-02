import { useEffect } from 'react';
import type { Companion } from '../lib/api';
import { TonightBody, type MascotState } from './TonightPanel';

/** Mobile bottom sheet reusing the Tonight panel content. */
export function TonightSheet({ open, onClose, refreshKey, companion, state }: {
  open: boolean; onClose: () => void; refreshKey: number; companion: Companion | null; state: MascotState;
}) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="sheet-scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Tonight">
        <button className="sheet-close" onClick={onClose} aria-label="Close">Close</button>
        <TonightBody refreshKey={refreshKey} companion={companion} state={state} />
      </div>
    </>
  );
}
