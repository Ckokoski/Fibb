import { useEffect, useState } from 'react';
import { getCompanions, setCompanion, type Companion } from '../lib/api';
export function CompanionPicker({ onPicked, compact = false }: { onPicked: (c: Companion) => void; compact?: boolean }) {
  const [list, setList] = useState<Companion[]>([]); const [active, setActive] = useState('nib'); const [busy, setBusy] = useState(false);
  useEffect(() => { getCompanions().then(r => { setList(r.companions); setActive(r.activeId); }).catch(() => {}); }, []);
  return (
    <div className={`picker${compact ? ' compact' : ''}`} role="radiogroup" aria-label="Choose your companion">
      {list.map(c => (
        <button key={c.id} role="radio" aria-checked={active === c.id} className={`pick${active === c.id ? ' on' : ''}`} disabled={busy}
          onClick={async () => { setBusy(true); const r = await setCompanion({ id: c.id }); setBusy(false); if (r) { setActive(r.id); onPicked(r); } }}>
          <img src={c.image} alt="" draggable={false} />
          <div className="pick-name">{c.name}</div>
          {!compact && <div className="pick-tag">{c.tagline}</div>}
        </button>
      ))}
    </div>
  );
}
