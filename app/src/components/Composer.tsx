import { useRef, useState } from 'react';
export function Composer({ onSend, disabled, listening, onMic, interim, micAvailable, micDisabled = false }: {
  onSend: (text: string) => void; disabled: boolean; listening: boolean; onMic: () => void; interim: string; micAvailable: boolean; micDisabled?: boolean;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const submit = () => { const t = text.trim(); if (!t || disabled) return; onSend(t); setText(''); if (ref.current) ref.current.style.height = 'auto'; };
  const shown = listening && interim ? interim : text;
  return (
    <div className={`composer${listening ? ' listening' : ''}`}>
      <textarea ref={ref} rows={1} placeholder={listening ? 'Listening… tap the mic to finish' : 'Talk to Fibb…'} value={shown} disabled={disabled || listening}
        onChange={e => { setText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'; }}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }} aria-label="Message" />
      {micAvailable && (
        <button className={`cbtn mic${listening ? ' on' : ''}`} onClick={onMic} disabled={micDisabled && !listening} aria-pressed={listening} aria-label={listening ? 'Stop listening' : 'Speak'} title={listening ? 'Stop' : 'Speak'}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v4"/></svg>
        </button>
      )}
      <button className="cbtn send" onClick={submit} disabled={disabled || listening || !text.trim()} aria-label="Send" title="Send (Enter)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>
      </button>
    </div>
  );
}
