import { useRef, useState } from 'react';
import { Ico } from './icons';
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
          {Ico.mic}
        </button>
      )}
      <button className="cbtn send" onClick={submit} disabled={disabled || listening || !text.trim()} aria-label="Send" title="Send (Enter)">
        {Ico.send}
      </button>
    </div>
  );
}
