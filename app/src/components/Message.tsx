import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Ico } from './icons';

export interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string; streaming?: boolean }
marked.setOptions({ breaks: true, gfm: true });
DOMPurify.addHook('afterSanitizeAttributes', n => {
  if (n.tagName === 'A') { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener noreferrer'); }
});

const SANITIZE = { USE_PROFILES: { html: true }, FORBID_TAGS: ['img', 'svg', 'math', 'form', 'input', 'button', 'textarea', 'select', 'option'], FORBID_ATTR: ['style'] };
/** Sanitized Markdown for model-written text shown outside the thread (task results). */
export function Md({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text || '') as string, SANITIZE), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Message({ m, onRead }: { m: ChatMessage; onRead?: (text: string) => void }) {
  // Hook runs before the role branch so hook order is stable.
  const html = useMemo(
    () => (m.role === 'user' ? '' : DOMPurify.sanitize(marked.parse(m.content || '') as string, { USE_PROFILES: { html: true }, FORBID_TAGS: ['img', 'svg', 'math', 'form', 'input', 'button', 'textarea', 'select', 'option'], FORBID_ATTR: ['style'] })),
    [m.role, m.content],
  );
  if (m.role === 'user') return <div className="msg me"><div className="b">{m.content}</div></div>;
  return (
    <div className={`msg fibb${m.streaming ? ' streaming' : ''}`}>
      <div className="b">
        {/* HTML is sanitized by DOMPurify above: the only permitted dangerouslySetInnerHTML. */}
        <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
        {!m.streaming && m.content && onRead && (
          <button className="read" onClick={() => onRead(m.content)} aria-label="Read aloud" title="Read aloud">
            {Ico.speaker}
          </button>
        )}
      </div>
    </div>
  );
}
