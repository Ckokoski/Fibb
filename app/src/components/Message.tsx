import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

export interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string; streaming?: boolean }
marked.setOptions({ breaks: true, gfm: true });
DOMPurify.addHook('afterSanitizeAttributes', n => {
  if (n.tagName === 'A') { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener noreferrer'); }
});

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
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>
          </button>
        )}
      </div>
    </div>
  );
}
