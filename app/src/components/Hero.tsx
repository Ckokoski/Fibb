import { useEffect, useRef, useState } from 'react';
import type { Companion, MascotStateName } from '../lib/api';

const FALLBACK = '/mascots/nib/nib-idle.svg';
const STATES: MascotStateName[] = ['idle', 'thinking', 'listening', 'celebrating'];
const DOZE_AFTER_MS = 3 * 60 * 1000;
const svgCache = new Map<string, Promise<string | null>>();

// Only the app's own bundled mascot vectors are inlined (so CSS can animate their eyes, tail and mouth).
// Anything else, including the photo looks, stays an <img>.
function isOwnVector(src: string): boolean { return /^\/mascots\/[a-z0-9/_-]+\.svg$/i.test(src); }

/** Adds an open-mouth shape right after a stroked smile so speech can open and close it. */
export function withTalkMouth(svg: string): string {
  return svg.replace(/(<path id="[a-z-]+-mouth" d="M (\d+) (\d+) [^"]*"[^>]*\/>)/, (_m, tag: string, x: string, y: string) =>
    `${tag}<ellipse class="nib-talk" cx="${Number(x) + 24}" cy="${Number(y) + 9}" rx="17" ry="13" fill="#362638"/>`);
}

function loadSvg(src: string): Promise<string | null> {
  let p = svgCache.get(src);
  if (!p) {
    p = fetch(src).then(r => (r.ok ? r.text() : null))
      .then(t => (t && t.includes('<svg') ? withTalkMouth(t.slice(t.indexOf('<svg'))) : null)).catch(() => null);
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
  const wrap = useRef<HTMLDivElement>(null);
  const [dozing, setDozing] = useState(false);

  // Eyes follow the pointer; a few idle minutes and Fibb dozes off until the author moves or types.
  useEffect(() => {
    let raf = 0; let timer = 0; let px = 0; let py = 0;
    const arm = () => { window.clearTimeout(timer); timer = window.setTimeout(() => setDozing(true), DOZE_AFTER_MS); };
    const wake = () => { setDozing(false); arm(); };
    const look = () => {
      raf = 0;
      const el = wrap.current; if (!el) return;
      const r = el.getBoundingClientRect();
      const dx = px - (r.left + r.width / 2); const dy = py - (r.top + r.height * 0.45);
      const d = Math.hypot(dx, dy) || 1; const reach = Math.min(1, d / 260);
      el.style.setProperty('--gx', ((dx / d) * 9 * reach).toFixed(2));
      el.style.setProperty('--gy', ((dy / d) * 6 * reach).toFixed(2));
    };
    const move = (e: PointerEvent) => { px = e.clientX; py = e.clientY; if (!raf) raf = requestAnimationFrame(look); wake(); };
    arm();
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('keydown', wake); window.addEventListener('pointerdown', wake);
    return () => {
      window.clearTimeout(timer); if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', move); window.removeEventListener('keydown', wake); window.removeEventListener('pointerdown', wake);
    };
  }, []);

  const asleep = dozing && state === 'idle';
  const status = asleep ? 'dozing…' : state === 'thinking' ? 'thinking…' : state === 'listening' ? 'listening…' : state === 'celebrating' ? 'celebrating' : state === 'speaking' ? 'speaking…' : 'awake';
  const shown: MascotStateName = state === 'speaking' ? 'idle' : state;
  return (
    <div className={`hero ${state}${compact ? ' compact' : ''}${big ? ' big' : ''}${asleep ? ' dozing' : ''}`}>
      <div className="hero-img-wrap" ref={wrap}>
        <div className="hero-float">
          {/* All four states stay mounted and crossfade by opacity so switching never flickers. */}
          {STATES.map(s => <Face key={s} src={c?.states?.[s] ?? c?.image ?? FALLBACK} on={s === shown} />)}
        </div>
        {asleep && <span className="zzz" aria-hidden="true">z</span>}
      </div>
      <div className="hero-status" role="status" aria-live="polite">Fibb <span className="sep">·</span> {status}</div>
      {line2 && !compact && <div className="hero-line2">{line2}</div>}
    </div>
  );
}
