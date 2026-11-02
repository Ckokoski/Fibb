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

/** Plays one audio URL at a time. Resolves true if it ended naturally, false if interrupted or failed. */
let current: HTMLAudioElement | null = null;
let currentResolve: ((natural: boolean) => void) | null = null;
export function playUrl(url: string): Promise<boolean> {
  return new Promise(resolve => {
    stopPlayback();
    const a = new Audio(url); current = a;
    const finish = (natural: boolean) => { if (current === a) { current = null; currentResolve = null; } resolve(natural); };
    currentResolve = finish;
    a.onended = () => finish(true);
    a.onerror = () => finish(false);
    a.play().catch(() => finish(false));
  });
}
export function stopPlayback(): void {
  const r = currentResolve;
  if (current) { try { current.pause(); } catch { /* ignore */ } current = null; }
  currentResolve = null;
  r?.(false);
}
