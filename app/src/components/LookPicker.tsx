import { useEffect, useState } from 'react';
import { getCompanions, setLook, type Companion } from '../lib/api';

/** Looks are cosmetic: Fibb is always Fibb. Labels name the look, not an identity. */
const lookLabel = (c: Companion) => {
  const id = c.look ?? c.id;
  const n = id.charAt(0).toUpperCase() + id.slice(1);
  return id === 'nib' ? 'Nib · default' : n;
};

export function LookPicker({ onPicked }: { onPicked: (c: Companion) => void }) {
  const [list, setList] = useState<Companion[]>([]);
  const [active, setActive] = useState('nib');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { getCompanions().then(r => { setList(r.companions); setActive(r.activeId); }).catch(() => {}); }, []);
  return (
    <div className="picker compact" role="radiogroup" aria-label="Choose Fibb's look">
      {list.map(c => (
        <button key={c.id} role="radio" aria-checked={active === c.id} className={`pick${active === c.id ? ' on' : ''}`} disabled={busy}
          onClick={async () => {
            setBusy(true); setErr('');
            try { const r = await setLook(c.look ?? c.id); if (r) { setActive(r.id); onPicked(r); } else setErr('Could not change the look.'); }
            catch (e: any) { setErr(e?.message || 'Could not change the look.'); }
            finally { setBusy(false); }
          }}>
          <img src={c.image} alt="" draggable={false} />
          <div className="pick-name">{lookLabel(c)}</div>
        </button>
      ))}
      {err && <div className="s" role="alert" style={{ gridColumn: '1 / -1', color: 'var(--red)' }}>{err}</div>}
    </div>
  );
}
