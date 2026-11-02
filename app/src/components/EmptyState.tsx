export function EmptyState({ title, text, action, onAction }: { title: string; text: string; action?: string; onAction?: () => void }) {
  return (
    <div className="thread"><div className="thread-inner"><div className="card empty">
      <div className="t">{title}</div><div className="s">{text}</div>
      {action && onAction && <div className="act"><button className="btn pri" onClick={onAction}>{action}</button></div>}
    </div></div></div>
  );
}
