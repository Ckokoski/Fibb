import { useEffect, useMemo, useRef, useState } from 'react';

export interface Command { id: string; label: string; hint?: string; run: () => void }

/** Turns what the author typed into the message Fibb receives. Exported for tests. */
export function toMessage(raw: string): string {
  const t = raw.trim();
  const m = /^(idea|tonight)\s*[:,]\s*(.+)$/i.exec(t);
  if (!m) return t;
  return m[1].toLowerCase() === 'idea' ? `idea: ${m[2]}` : `tonight, ${m[2]}`;
}

export function CommandBar({ open, onClose, commands, onSay }: { open: boolean; onClose: () => void; commands: Command[]; onSay: (text: string) => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    trigger.current = document.activeElement as HTMLElement | null;
    setQ(''); setSel(0);
    input.current?.focus();
    const id = window.setTimeout(() => input.current?.focus(), 60);
    return () => { window.clearTimeout(id); trigger.current?.focus?.(); };
  }, [open]);

  const text = q.trim();
  const items = useMemo<Command[]>(() => {
    const say: Command[] = text ? [{ id: 'say', label: `Tell Fibb: ${toMessage(text)}`, hint: 'Enter', run: () => onSay(toMessage(text)) }] : [];
    const needle = text.toLowerCase();
    return [...say, ...commands.filter(c => !needle || c.label.toLowerCase().includes(needle))];
  }, [text, commands, onSay]);
  useEffect(() => { setSel(s => Math.min(s, Math.max(0, items.length - 1))); }, [items.length]);

  if (!open) return null;
  const run = (c?: Command) => { if (!c) return; onClose(); c.run(); };
  return (
    <div className="cmd-scrim" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cmd" role="dialog" aria-modal="true" aria-label="Quick command">
        <input ref={input} autoFocus className="cmd-input" value={q} placeholder="Type idea: …, tonight: …, or anything for Fibb"
          role="combobox" aria-expanded="true" aria-controls="cmd-list" aria-activedescendant={items[sel] ? `cmd-${items[sel].id}` : undefined}
          onChange={e => { setQ(e.target.value); setSel(0); }}
          onKeyDown={e => {
            if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(items.length - 1, s + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(0, s - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); run(items[sel]); }
            else if (e.key === 'Tab') { e.preventDefault(); }
          }} />
        <ul className="cmd-list" id="cmd-list" role="listbox">
          {items.map((c, i) => (
            <li key={c.id} id={`cmd-${c.id}`} role="option" aria-selected={i === sel} className={i === sel ? 'on' : ''}
              onMouseEnter={() => setSel(i)} onMouseDown={e => { e.preventDefault(); run(c); }}>
              <span>{c.label}</span>{c.hint && <kbd>{c.hint}</kbd>}
            </li>
          ))}
          {items.length === 0 && <li className="none">Nothing matches. Keep typing and press Enter to tell Fibb.</li>}
        </ul>
      </div>
    </div>
  );
}
