import type { Companion, MascotStateName } from '../lib/api';

const FALLBACK = '/mascots/nib/nib-idle.svg';
const STATES: MascotStateName[] = ['idle', 'thinking', 'listening', 'celebrating'];

export function Hero({ c, state, line2, compact = false }: { c: Companion | null; state: MascotStateName | 'speaking'; line2?: string; compact?: boolean }) {
  const status = state === 'thinking' ? 'thinking…' : state === 'listening' ? 'listening…' : state === 'celebrating' ? 'celebrating' : state === 'speaking' ? 'speaking…' : 'awake';
  const shown: MascotStateName = state === 'speaking' ? 'idle' : state;
  return (
    <div className={`hero ${state}${compact ? ' compact' : ''}`}>
      <div className="hero-img-wrap">
        {/* All four states stay mounted and crossfade by opacity so switching never flickers. */}
        {STATES.map(s => (
          <img key={s} src={c?.states?.[s] ?? c?.image ?? FALLBACK} alt=""
            className={`hero-img${s === shown ? ' on' : ''}`} draggable={false} aria-hidden="true" />
        ))}
      </div>
      <div className="hero-status" role="status" aria-live="polite">Fibb <span className="sep">·</span> {status}</div>
      {line2 && !compact && <div className="hero-line2">{line2}</div>}
    </div>
  );
}
