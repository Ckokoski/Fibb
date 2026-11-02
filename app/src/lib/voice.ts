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
    rec.onerror = (e: any) => { if (e.error !== 'aborted' && e.error !== 'no-speech') onError(e.error || 'speech error'); };
    rec.onend = () => onFinal(finalText.trim());
    rec.start();
    return { stop: () => { try { rec.stop(); } catch { /* ignore */ } } };
  }
  // Fallback: record and upload.
  let recorder: MediaRecorder | null = null; const chunks: Blob[] = [];
  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      try { onFinal(await transcribe(new Blob(chunks, { type: 'audio/webm' }))); } catch (err: any) { onError(err.message || 'transcription failed'); onFinal(''); }
    };
    recorder.start(); onInterim('Listening…');
  }).catch(err => onError(err.message || 'microphone unavailable'));
  return { stop: () => { try { recorder?.stop(); } catch { /* ignore */ } } };
}

export function micSupported(): boolean { return !!getSR() || !!navigator.mediaDevices?.getUserMedia; }

/** Plays one audio URL at a time; resolves when playback ends or is stopped. */
let current: HTMLAudioElement | null = null;
let currentResolve: (() => void) | null = null;
export function playUrl(url: string): Promise<void> {
  return new Promise(resolve => {
    stopPlayback();
    const a = new Audio(url); current = a;
    const done = () => { if (current === a) { current = null; currentResolve = null; } resolve(); };
    currentResolve = done;
    a.onended = done;
    a.onerror = done;
    a.play().catch(done);
  });
}
export function stopPlayback(): void {
  const r = currentResolve;
  if (current) { try { current.pause(); } catch { /* ignore */ } current = null; }
  currentResolve = null;
  r?.();
}
