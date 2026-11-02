export interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string; streaming?: boolean }

export function Message({ m }: { m: ChatMessage }) {
  if (m.role === 'user') {
    return <div className="msg me"><div className="b">{m.content}</div></div>;
  }
  return (
    <div className={`msg fibb${m.streaming ? ' streaming' : ''}`}>
      <div className="m" aria-hidden />
      <div className="b">{m.content}</div>
    </div>
  );
}
