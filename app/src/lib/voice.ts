// app/src/lib/voice.ts — mic capture (Web Speech first, MediaRecorder fallback) and spoken-reply playback.
import { transcribe } from './api';

const getSR = (): any => (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;

export interface Listener { stop: () => void }

/** Start listening. onInterim gets live partial text; onFinal gets the transcript when the user stops. */
export function startListening(onInterim: (t: string) => void, onFinal: (t: string) => void, onError: (m: string) => void): Listener {
  const SRCtor = getSR();
  if (SRCtor) {
    const rec = new SRCtor(); rec.continuous = true; rec.interimResults = true; rec.lang = navigator.language || 'en-US';
    let finalText = '';
    rec.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t + ' '; else interim += t;
      }
      onInterim((finalText + interim).trim());
    };
    let errored = false;
    rec.onerror = (e: any) => { errored = true; if (e.error !== 'aborted' && e.error !== 'no-speech') onError(e.error || 'speech error'); };
    rec.onend = () => onFinal(errored ? '' : finalText.trim());
    rec.start();
    return { stop: () => { try { rec.stop(); } catch { /* ignore */ } } };
  }
  // Fallback: record and upload.
  let recorder: MediaRecorder | null = null; const chunks: Blob[] = [];
  let stopped = false;
  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    if (stopped) { stream.getTracks().forEach(t => t.stop()); onFinal(''); return; }
    try {
      const useWebm = typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported('audio/webm');
      recorder = useWebm ? new MediaRecorder(stream, { mimeType: 'audio/webm' }) : new MediaRecorder(stream);
    } catch (err: any) {
      stream.getTracks().forEach(t => t.stop()); onError(err?.message || 'recording unavailable'); onFinal(''); return;
    }
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      try { onFinal(await transcribe(new Blob(chunks, { type: 'audio/webm' }))); } catch (err: any) { onError(err.message || 'transcription failed'); onFinal(''); }
    };
    recorder.start(); onInterim('Listening…');
  }).catch(err => onError(err.message || 'microphone unavailable'));
  return { stop: () => { stopped = true; try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch { /* ignore */ } } };
}

export function micSupported(): boolean { return !!getSR() || !!navigator.mediaDevices?.getUserMedia; }

// Speech level drives Nib's mouth through the --mouth CSS variable (0 closed, 1 wide open).
let actx: AudioContext | null = null;
let levelRaf = 0;
function setMouth(v: number): void { document.documentElement.style.setProperty('--mouth', v.toFixed(3)); }
function stopLevel(): void { if (levelRaf) window.clearInterval(levelRaf); levelRaf = 0; setMouth(0); }
function followLevel(a: HTMLAudioElement): void {
  stopLevel();
  let analyser: AnalyserNode | null = null; let buf: Uint8Array<ArrayBuffer> | null = null;
  try {
    const C = window.AudioContext || (window as any).webkitAudioContext;
    if (C) {
      if (!actx) actx = new C();
      // Only route through Web Audio when the context is really running; a suspended one would mute the reply.
      if (actx.state === 'running') {
        const src = actx.createMediaElementSource(a);
        analyser = actx.createAnalyser(); analyser.fftSize = 256;
        src.connect(analyser); analyser.connect(actx.destination);
        buf = new Uint8Array(new ArrayBuffer(analyser.fftSize));
      } else { void actx.resume().catch(() => {}); }
    }
  } catch { analyser = null; }
  let smooth = 0;
  const tick = () => {
    let v: number;
    if (analyser && buf) {
      analyser.getByteTimeDomainData(buf);
      let sum = 0; for (let k = 0; k < buf.length; k++) { const d = (buf[k] - 128) / 128; sum += d * d; }
      v = Math.min(1, Math.sqrt(sum / buf.length) * 5.5);
    } else {
      // No analyser available: a gentle synthetic chatter so the mouth still moves.
      const t = performance.now() / 1000; v = a.paused ? 0 : 0.35 + 0.3 * Math.sin(t * 13) * Math.sin(t * 3.1);
    }
    smooth += (v - smooth) * 0.55; setMouth(Math.max(0, smooth));
  };
  // A timer, not requestAnimationFrame, so the level keeps updating in throttled or embedded windows.
  levelRaf = window.setInterval(tick, 50);
}

/** Plays one audio URL at a time. Resolves true if it ended naturally, false if interrupted or failed. */
let current: HTMLAudioElement | null = null;
let currentResolve: ((natural: boolean) => void) | null = null;
export function playUrl(url: string): Promise<boolean> {
  return new Promise(resolve => {
    stopPlayback();
    const a = new Audio(url); current = a;
    const finish = (natural: boolean) => { stopLevel(); if (current === a) { current = null; currentResolve = null; } resolve(natural); };
    currentResolve = finish;
    a.onended = () => finish(true);
    a.onerror = () => finish(false);
    followLevel(a);
    a.play().catch(() => finish(false));
  });
}
export function stopPlayback(): void {
  const r = currentResolve;
  if (current) { try { current.pause(); } catch { /* ignore */ } current = null; }
  currentResolve = null;
  stopLevel();
  r?.(false);
}
