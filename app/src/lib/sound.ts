// app/src/lib/sound.ts — tiny synthesized chimes (no audio files). Off unless the author turns them on.
const KEY = 'fibb_sounds';
export type Cue = 'done' | 'celebrate' | 'open';

export function soundsOn(): boolean { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } }
export function setSounds(on: boolean): void { try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* ignore */ } }

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  try {
    const C = window.AudioContext || (window as any).webkitAudioContext;
    if (!C) return null;
    if (!ctx) ctx = new C();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    return ctx;
  } catch { return null; }
}

// Notes are [frequency Hz, start offset s]. Soft sine with a quick fade so nothing ever clicks.
const CUES: Record<Cue, Array<[number, number]>> = {
  done: [[659.25, 0], [880, 0.09]],
  celebrate: [[523.25, 0], [659.25, 0.08], [783.99, 0.16], [1046.5, 0.26]],
  open: [[587.33, 0]],
};

export function cue(name: Cue, force = false): void {
  if (!force && !soundsOn()) return;
  const a = audio(); if (!a) return;
  const t0 = a.currentTime + 0.01;
  for (const [f, at] of CUES[name]) {
    const o = a.createOscillator(); const g = a.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0, t0 + at);
    g.gain.linearRampToValueAtTime(0.07, t0 + at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.45);
    o.connect(g); g.connect(a.destination);
    o.start(t0 + at); o.stop(t0 + at + 0.5);
  }
}
