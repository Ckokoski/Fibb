import { useEffect, useRef } from 'react';
import type { Companion } from '../lib/api';
import { TonightBody } from './TonightPanel';

/** Desktop right-side drawer; mobile uses TonightSheet. Focus moves in on open and back to the trigger on close. */
export function TonightDrawer({ open, onClose, refreshKey, companion }: { open: boolean; onClose: () => void; refreshKey: number; companion: Companion | null }) {
  const head = useRef<HTMLHeadingElement>(null);
  const panel = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement as HTMLElement | null;
    head.current?.focus();
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { closeRef.current(); return; }
      if (e.key !== 'Tab' || !panel.current) return;
      const f = Array.from(panel.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'));
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0], last = f[f.length - 1], cur = document.activeElement;
      if (e.shiftKey && (cur === first || cur === head.current || !panel.current.contains(cur))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (cur === last || !panel.current.contains(cur))) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', h);
    return () => { window.removeEventListener('keydown', h); trigger?.focus?.(); };
  }, [open]);
  return (
    <>
      <div className={`drawer-scrim${open ? ' open' : ''}`} onClick={onClose} aria-hidden="true" />
      <aside ref={panel} className={`drawer${open ? ' open' : ''}`} role="dialog" aria-modal="true" aria-label="Tonight" aria-hidden={!open}>
        <div className="drawer-head">
          <h3 ref={head} tabIndex={-1}>Tonight</h3>
          <button className="btn quiet" onClick={onClose} aria-label="Close">Close</button>
        </div>
        <TonightBody refreshKey={refreshKey} companion={companion} />
      </aside>
    </>
  );
}
