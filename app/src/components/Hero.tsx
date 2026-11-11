import { useEffect, useState } from 'react';
import type { Companion, MascotStateName } from '../lib/api';

const FALLBACK = '/mascots/nib/nib-idle.svg';
const STATES: MascotStateName[] = ['idle', 'thinking', 'listening', 'celebrating'];
const svgCache = new Map<string, Promise<string | null>>();

// Only the app's own bundled mascot vectors are inlined (so CSS can animate their eyes and tail).
// Anything else, including the photo looks, stays an <img>.
function isOwnVector(src: string): boolean { return /^\/mascots\/[a-z0-9/_-]+\.svg$/i.test(src); }
function loadSvg(src: string): Promise<string | null> {
  let p = svgCache.get(src);
  if (!p) {
    p = fetch(src).then(r => (r.ok ? r.text() : null)).then(t => (t && t.includes('<svg') ? t.slice(t.indexOf('<svg')) : null)).catch(() => null);
    svgCache.set(src, p);
  }
  return p;
}

function Face({ src, on }: { src: string; on: boolean }) {
  const [markup, setMarkup] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setMarkup(null);
    if (isOwnVector(src)) void loadSvg(src).then(t => { if (alive) setMarkup(t); });
    return () => { alive = false; };
  }, [src]);
  const cls = `hero-img${on ? ' on' : ''}`;
  // The markup is a static file shipped with the app (path-checked above), never user or model content.
  if (markup) return <div className={cls} aria-hidden="true" dangerouslySetInnerHTML={{ __html: markup }} />;
  return <img src={src} alt="" className={cls} draggable={false} aria-hidden="true" />;
}

export function Hero({ c, state, line2, compact = false, big = false }: { c: Companion | null; state: MascotStateName | 'speaking'; line2?: string; compact?: boolean; big?: boolean }) {
  const status = state === 'thinking' ? 'thinking…' : state === 'listening' ? 'listening…' : state === 'celebrating' ? 'celebrating' : state === 'speaking' ? 'speaking…' : 'awake';
  const shown: MascotStateName = state === 'speaking' ? 'idle' : state;
  return (
    <div className={`hero ${state}${compact ? ' compact' : ''}${big ? ' big' : ''}`}>
      <div className="hero-img-wrap">
        <div className="hero-float">
          {/* All four states stay mounted and crossfade by opacity so switching never flickers. */}
          {STATES.map(s => <Face key={s} src={c?.states?.[s] ?? c?.image ?? FALLBACK} on={s === shown} />)}
        </div>
      </div>
      <div className="hero-status" role="status" aria-live="polite">Fibb <span className="sep">·</span> {status}</div>
      {line2 && !compact && <div className="hero-line2">{line2}</div>}
    </div>
  );
}
