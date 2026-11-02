import { useEffect, useState } from 'react';
import { getCompanions, setCompanion, type Companion } from '../lib/api';
export function CompanionPicker({ onPicked, compact = false }: { onPicked: (c: Companion) => void; compact?: boolean }) {
  const [list, setList] = useState<Companion[]>([]); const [active, setActive] = useState('nib'); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  useEffect(() => { getCompanions().then(r => { setList(r.companions); setActive(r.activeId); }).catch(() => {}); }, []);
  return (
    <div className={`picker${compact ? ' compact' : ''}`} role="radiogroup" aria-label="Choose your companion">
      {list.map(c => (
        <button key={c.id} role="radio" aria-checked={active === c.id} className={`pick${active === c.id ? ' on' : ''}`} disabled={busy}
          onClick={async () => {
            setBusy(true); setErr('');
            try { const r = await setCompanion({ id: c.id }); if (r) { setActive(r.id); onPicked(r); } else setErr('Could not switch companion.'); }
            catch (e: any) { setErr(e?.message || 'Could not switch companion.'); }
            finally { setBusy(false); }
          }}>
          <img src={c.image} alt="" draggable={false} />
          <div className="pick-name">{c.name}</div>
          {!compact && <div className="pick-tag">{c.tagline}</div>}
        </button>
      ))}
      {err && <div className="s" style={{ gridColumn: '1 / -1', color: 'var(--red)' }}>{err}</div>}
    </div>
  );
}
