import type { Companion } from '../lib/api';
export function MascotAvatar({ c, state = 'idle', size = 116 }: { c: Companion | null; state?: 'idle' | 'thinking' | 'listening'; size?: number }) {
  return (
    <div className={`mascot ${state}`} style={{ height: size }}>
      {c ? <img src={c.image} alt={`${c.name}, ${c.tagline}`} className="mascot-img" draggable={false} /> : <div className="blob" aria-hidden><span className="e l" /><span className="e r" /><span className="g" /></div>}
      <span className="cap-txt">{c ? `${c.name} · ${state === 'thinking' ? 'thinking' : state === 'listening' ? 'listening' : 'awake'}` : 'Fibb'}</span>
    </div>
  );
}
