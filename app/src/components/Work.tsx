import { useEffect, useState } from 'react';
import { Md } from './Message';
import {
  addSchedule, addTask, approve, deleteSchedule, deleteTask, describeCron, getSchedules, groupTasks, patchTask, reject, runQueued,
  SCHEDULE_PRESETS, type Approval, type Schedule, type Task,
} from '../lib/tasks';
import { cue } from '../lib/sound';

export function Ring({ value, spin = false }: { value: number; spin?: boolean }) {
  const pct = Math.max(4, Math.min(100, Math.round(value)));
  return <span className={`ring${spin ? ' spin' : ''}`} style={{ ['--p' as string]: `${pct}%` }} role="img" aria-label={`${pct}% done`}><i /></span>;
}

function summary(t: Task): string {
  const first = (t.result || '').split('\n').map(l => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) || '';
  return first.length > 140 ? `${first.slice(0, 137)}…` : first;
}

/** A card asking the author to allow or refuse one action Fibb wants to take. */
export function ApprovalCard({ a, onDone }: { a: Approval; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  return (
    <div className="card approval" role="group" aria-label="Fibb needs your OK">
      <div className="t">Fibb needs your OK</div>
      <div className="s">{a.description}</div>
      {note && <div className="s" role="status">{note}</div>}
      {!note && (
        <div className="act">
          <button className="btn pri" disabled={busy} onClick={async () => {
            setBusy(true); const r = await approve(a.id); setBusy(false);
            setNote(r.ok ? (r.outcome || 'Done.') : (r.error || 'That did not work.'));
            window.setTimeout(onDone, 2500);
          }}>Allow once</button>
          <button className="btn" disabled={busy} onClick={async () => { setBusy(true); await reject(a.id); setBusy(false); onDone(); }}>No</button>
        </div>
      )}
    </div>
  );
}

/** Live cards above the composer: what Fibb is working on and what is waiting for a yes. */
export function WorkStrip({ tasks, approvals, reload }: { tasks: Task[]; approvals: Approval[]; reload: () => void }) {
  const g = groupTasks(tasks);
  if (!g.running.length && !approvals.length) return null;
  return (
    <div className="workstrip">
      {approvals.map(a => <ApprovalCard key={a.id} a={a} onDone={reload} />)}
      {g.running.map(t => (
        <div key={t.id} className="task live">
          <Ring value={t.progress} spin />
          <div><div className="tt">{t.title}</div><div className="ts">Working on it · {Math.round(t.progress)}%</div></div>
        </div>
      ))}
    </div>
  );
}

function ReviewItem({ t, reload }: { t: Task; reload: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card review-item">
      <div className="t">{t.title}</div>
      {!open && <div className="s">{summary(t)}</div>}
      {open && <div className="result"><Md text={t.result || ''} /></div>}
      <div className="act">
        <button className="btn" onClick={() => setOpen(o => !o)} aria-expanded={open}>{open ? 'Hide' : 'Read it'}</button>
        <button className="btn pri" onClick={async () => { await patchTask(t.id, { status: 'done' }); cue('done'); reload(); }}>Keep</button>
        <button className="btn quiet" onClick={async () => { await patchTask(t.id, { status: 'discarded' }); reload(); }}>Discard</button>
      </div>
    </div>
  );
}

export function TasksView({ tasks, approvals, reload }: { tasks: Task[]; approvals: Approval[]; reload: () => void }) {
  const g = groupTasks(tasks);
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [repeat, setRepeat] = useState('');
  const [err, setErr] = useState('');
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const loadSchedules = () => { void getSchedules().then(setSchedules); };
  useEffect(loadSchedules, []);

  const submit = async (when: 'tonight' | 'now') => {
    const t = title.trim(); if (!t) return;
    setErr('');
    try {
      if (repeat) { await addSchedule(t, detail.trim(), repeat); loadSchedules(); }
      else await addTask({ title: t, detail: detail.trim(), when });
      setTitle(''); setDetail(''); setRepeat(''); reload();
    } catch (e: any) { setErr(e?.message || 'Could not save that.'); }
  };

  return (
    <div className="thread"><div className="thread-inner settings">
      {approvals.map(a => <ApprovalCard key={a.id} a={a} onDone={reload} />)}

      <section className="card">
        <div className="t">Give Fibb something to do</div>
        <div className="s">Fibb does the work and leaves it here for your yes. Nothing is published or sent without you.</div>
        <input className="input" style={{ marginTop: 12 }} placeholder="Summarize my notes for chapter 10" value={title} maxLength={200} onChange={e => setTitle(e.target.value)} aria-label="What should Fibb do?" />
        <textarea className="input" style={{ marginTop: 8, resize: 'vertical' }} rows={2} placeholder="Any details (optional)" value={detail} onChange={e => setDetail(e.target.value)} aria-label="Details" />
        <label className="modelrow"><span>Repeat</span>
          <select className="input" value={repeat} onChange={e => setRepeat(e.target.value)} aria-label="Repeat">
            <option value="">Just once</option>
            {SCHEDULE_PRESETS.map(p => <option key={p.cron} value={p.cron}>{p.label}</option>)}
          </select>
        </label>
        <div className="act">
          {repeat
            ? <button className="btn pri" disabled={!title.trim()} onClick={() => submit('now')}>Save schedule</button>
            : <>
              <button className="btn pri" disabled={!title.trim()} onClick={() => submit('tonight')}>Queue for tonight</button>
              <button className="btn" disabled={!title.trim()} onClick={() => submit('now')}>Do it now</button>
            </>}
        </div>
        {err && <div className="s" role="alert" style={{ color: 'var(--red)' }}>{err}</div>}
      </section>

      {g.review.length > 0 && <h4 className="side-h">Ready for your review</h4>}
      {g.review.map(t => <ReviewItem key={t.id} t={t} reload={reload} />)}

      {(g.running.length > 0 || g.queued.length > 0 || g.failed.length > 0) && (
        <section className="card">
          <div className="keyhead"><div className="t">In the queue</div>
            {g.queued.length > 0 && <button className="btn hint" onClick={async () => { await runQueued(); reload(); }}>Start now</button>}
          </div>
          <div className="tasks">
            {g.running.map(t => <div key={t.id} className="task live"><Ring value={t.progress} spin /><div><div className="tt">{t.title}</div><div className="ts">Working on it · {Math.round(t.progress)}%</div></div></div>)}
            {g.queued.map(t => <div key={t.id} className="task"><Ring value={0} /><div className="grow"><div className="tt">{t.title}</div><div className="ts">{t.when === 'now' ? 'Starting' : 'Tonight'}</div></div><button className="btn quiet" onClick={async () => { await deleteTask(t.id); reload(); }} aria-label={`Remove ${t.title}`}>Remove</button></div>)}
            {g.failed.map(t => <div key={t.id} className="task"><span className="dot" style={{ background: 'var(--red)' }} /><div className="grow"><div className="tt">{t.title}</div><div className="ts">Did not finish{t.error ? `: ${t.error}` : ''}</div></div><button className="btn" onClick={async () => { await patchTask(t.id, { status: 'queued' }); reload(); }}>Try again</button><button className="btn quiet" onClick={async () => { await deleteTask(t.id); reload(); }}>Remove</button></div>)}
          </div>
        </section>
      )}

      {schedules.length > 0 && (
        <section className="card">
          <div className="t">On a schedule</div>
          <div className="tasks">
            {schedules.map(s => (
              <div key={s.id} className="task"><div className="grow"><div className="tt">{s.handler === 'night-shift' ? 'Night shift: work through the queue' : s.name}</div><div className="ts">{describeCron(s.schedule)}</div></div>
                {s.handler === 'queue-task' && <button className="btn quiet" onClick={async () => { await deleteSchedule(s.id); loadSchedules(); }} aria-label={`Remove schedule ${s.name}`}>Remove</button>}
              </div>
            ))}
          </div>
        </section>
      )}

      {g.done.length > 0 && (
        <section className="card">
          <div className="t">Kept</div>
          <div className="tasks">{g.done.slice(0, 12).map(t => <DoneRow key={t.id} t={t} reload={reload} />)}</div>
        </section>
      )}
    </div></div>
  );
}

function DoneRow({ t, reload }: { t: Task; reload: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="task col">
      <div className="row"><div className="grow"><div className="tt">{t.title}</div><div className="ts">{summary(t)}</div></div>
        <button className="btn quiet" onClick={() => setOpen(o => !o)} aria-expanded={open}>{open ? 'Hide' : 'Open'}</button>
        <button className="btn quiet" onClick={async () => { await deleteTask(t.id); reload(); }} aria-label={`Delete ${t.title}`}>Delete</button></div>
      {open && <div className="result"><Md text={t.result || ''} /></div>}
    </div>
  );
}

export function IdeasView({ tasks, reload, onChat }: { tasks: Task[]; reload: () => void; onChat: () => void }) {
  const { ideas } = groupTasks(tasks);
  const [text, setText] = useState('');
  const save = async () => { const t = text.trim(); if (!t) return; await addTask({ title: t.slice(0, 200), detail: t, kind: 'idea' }).catch(() => {}); setText(''); reload(); };
  return (
    <div className="thread"><div className="thread-inner settings">
      <section className="card">
        <div className="t">Catch an idea</div>
        <div className="s">Type it here, or say "idea: …" to Fibb anywhere, including Telegram.</div>
        <div className="act">
          <input className="input" placeholder="A lighthouse keeper who forges tide tables" value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void save(); }} aria-label="New idea" />
          <button className="btn pri" disabled={!text.trim()} onClick={save}>Save</button>
        </div>
      </section>
      {ideas.length === 0 && <div className="card empty"><div className="t">Nothing captured yet</div><div className="s">Ideas you save land here, ready to grow.</div><div className="act"><button className="btn" onClick={onChat}>Brainstorm in chat</button></div></div>}
      {ideas.map(t => (
        <div key={t.id} className="card idea">
          <div className="idea-text">{t.detail || t.title}</div>
          <div className="act">
            <button className="btn" onClick={async () => { await patchTask(t.id, { kind: 'task', status: 'queued', title: `Develop this idea: ${t.title}`.slice(0, 200), detail: `Develop this idea into three possible directions, each with a premise, a hook and a first scene:\n\n${t.detail || t.title}` }); reload(); }}>Develop it tonight</button>
            <button className="btn quiet" onClick={async () => { await deleteTask(t.id); reload(); }}>Delete</button>
          </div>
        </div>
      ))}
    </div></div>
  );
}
