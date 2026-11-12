import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { registerPlaybookRoutes } from './playbook.js';
import { NoticeService, type UsageInput } from '../../services/notices.js';
import { PLAYS, PLAY_CATEGORIES } from '../../services/playbook.js';

type Handler = (req: any, res: any) => any;

function harness(services: any) {
  const routes = new Map<string, Handler>();
  const reg = (m: string) => (path: string, h: Handler) => { routes.set(`${m} ${path}`, h); };
  const app: any = { get: reg('GET'), post: reg('POST'), patch: reg('PATCH'), delete: reg('DELETE') };
  registerPlaybookRoutes({ app, gateway: {}, services, baseDir: '' });
  const call = async (key: string, opts: { params?: any; body?: any } = {}) => {
    const res: any = { code: 200, body: undefined };
    res.status = (c: number) => { res.code = c; return res; };
    res.json = (b: any) => { res.body = b; return res; };
    await routes.get(key)!({ params: opts.params || {}, body: opts.body }, res);
    return res as { code: number; body: any };
  };
  return { call, routes };
}

const RUN = 'POST /api/playbook/:id/run';

let dir: string;
let usage: UsageInput;
let caps: { hasGoogle: boolean; hasBrowser: boolean };
let jobs: any[];
let added: any[];
let ran: string[];
let failTasks: boolean;
let notices: NoticeService;
let h: ReturnType<typeof harness>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fibb-playbook-routes-'));
  jobs = []; added = []; ran = []; failTasks = false;
  caps = { hasGoogle: false, hasBrowser: false };
  usage = { messages: [], tasks: [], schedules: [], writingDays: {}, facts: { books: [{ title: 'The Salt Road', chapter: 3 }] } };
  notices = new NoticeService(dir, {
    loadUsage: async () => usage,
    loadFacts: () => usage.facts,
    capabilities: () => caps,
    tasks: { add: async (i) => { if (failTasks) throw new Error('C:\\secret\\path exploded'); added.push(i); return { id: `task-${added.length}`, ...i }; } },
    cron: { createJob: async (i) => { jobs.push(i); return i; }, list: () => jobs },
  });
  await notices.initialize();
  h = harness({ notices, nightShift: { runTask: async (id: string) => { ran.push(id); } } });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('playbook routes', () => {
  it('registers exactly the documented routes', () => {
    expect([...h.routes.keys()]).toEqual(['GET /api/playbook', RUN]);
  });

  it('503 on every route when the service is missing', async () => {
    const bare = harness({});
    for (const key of bare.routes.keys()) {
      const r = await bare.call(key, { params: { id: 'read-last-scene' }, body: {} });
      expect(r.code).toBe(503);
      expect(r.body.error).toBeTruthy();
    }
  });

  it('GET lists every play, grouped by category in a fixed order, with no work orders', async () => {
    const r = await h.call('GET /api/playbook');
    expect(r.code).toBe(200);
    expect(Object.keys(r.body)).toEqual(['plays']);
    expect(r.body.plays).toHaveLength(PLAYS.length);
    const cats = r.body.plays.map((p: any) => p.category);
    expect([...new Set(cats)]).toEqual(PLAY_CATEGORIES);
    expect(cats).toEqual([...cats].sort((a, b) => PLAY_CATEGORIES.indexOf(a) - PLAY_CATEGORIES.indexOf(b)));
    expect((await h.call('GET /api/playbook')).body).toEqual(r.body); // stable
    for (const p of r.body.plays) {
      expect(Object.keys(p).filter(k => k !== 'missing').sort()).toEqual(['available', 'blurb', 'category', 'id', 'kind', 'label', 'title']);
      expect(['task', 'schedule', 'say']).toContain(p.kind);
    }
    expect(JSON.stringify(r.body)).not.toMatch(/Questions for you|\{book\}|"detail"|"cron"|"action"|"needs"|Use your browser/);
    const find = (id: string) => r.body.plays.find((p: any) => p.id === id);
    expect(find('consistency-check')).toEqual({
      id: 'consistency-check', category: 'Story', title: 'Check the story for contradictions',
      blurb: 'I can comb The Salt Road for contradictions in names, ages, eye colors, dates and places.',
      label: 'Check it', kind: 'task', available: true,
    });
    expect(find('inbox-triage')).toMatchObject({ available: false, missing: 'google' });
    expect(find('comp-titles')).toMatchObject({ available: false, missing: 'browser' });
    caps = { hasGoogle: true, hasBrowser: true };
    expect((await h.call('GET /api/playbook')).body.plays.every((p: any) => p.available && !('missing' in p))).toBe(true);
  });

  it('run: 404 for an unknown play, 400 for a bad when', async () => {
    const r = await h.call(RUN, { params: { id: 'nope' }, body: {} });
    expect(r.code).toBe(404);
    expect(r.body).toEqual({ error: 'Play not found' });
    for (const when of ['later', '', 5, null]) {
      expect((await h.call(RUN, { params: { id: 'consistency-check' }, body: { when } })).code).toBe(400);
    }
    expect(added).toEqual([]);
  });

  it('run: 409 with what is missing when the play is unavailable', async () => {
    const mail = await h.call(RUN, { params: { id: 'inbox-triage' }, body: {} });
    expect(mail.code).toBe(409);
    expect(mail.body).toEqual({ error: 'Connect Google first, then try again.', missing: 'google' });
    const web = await h.call(RUN, { params: { id: 'comp-titles' } });
    expect(web.code).toBe(409);
    expect(web.body.missing).toBe('browser');
    usage = { ...usage, facts: {} };
    const book = await h.call(RUN, { params: { id: 'book-dashboard' }, body: {} });
    expect(book.code).toBe(409);
    expect(book.body).toEqual({ error: 'Tell Fibb about your book first, then try again.', missing: 'book' });
    expect(added).toEqual([]);
    expect(ran).toEqual([]);
  });

  it('run a task play: defaults to now and starts it; tonight only queues it', async () => {
    const now = await h.call(RUN, { params: { id: 'book-dashboard' } });
    expect(now.code).toBe(200);
    expect(now.body).toEqual({ ok: true, taskId: 'task-1', message: 'On it: "Book dashboard: The Salt Road". It will be in Tasks when it is ready.' });
    expect(added[0]).toMatchObject({ title: 'Book dashboard: The Salt Road', kind: 'task', when: 'now', source: 'app', detail: expect.stringContaining('Next three steps') });
    expect(ran).toEqual(['task-1']);

    const explicit = await h.call(RUN, { params: { id: 'pacing-check' }, body: { when: 'now' } });
    expect(explicit.body.taskId).toBe('task-2');
    expect(ran).toEqual(['task-1', 'task-2']);

    const tonight = await h.call(RUN, { params: { id: 'consistency-check' }, body: { when: 'tonight' } });
    expect(tonight.body).toEqual({ ok: true, taskId: 'task-3', message: 'Queued for tonight: "Consistency check: The Salt Road".' });
    expect(added[2].when).toBe('tonight');
    expect(ran).toEqual(['task-1', 'task-2']);

    // Without a night shift the task is still queued.
    const lone = harness({ notices });
    expect((await lone.call(RUN, { params: { id: 'title-brainstorm' }, body: {} })).body).toMatchObject({ ok: true, taskId: 'task-4' });
  });

  it('run a schedule play: creates the job, then 409 when it is already there', async () => {
    const r = await h.call(RUN, { params: { id: 'morning-recap' }, body: {} });
    expect(r.code).toBe(200);
    expect(r.body).toEqual({ ok: true, message: 'Scheduled "Morning recap".' });
    expect(jobs).toEqual([{ name: 'Morning recap', schedule: '30 7 * * *', handler: 'queue-task', payload: { title: 'Morning recap', detail: expect.any(String) } }]);
    const again = await h.call(RUN, { params: { id: 'morning-recap' }, body: {} });
    expect(again.code).toBe(409);
    expect(again.body).toEqual({ error: 'That is already on your schedule.' });
    expect(jobs).toHaveLength(1);
    expect(ran).toEqual([]);
  });

  it('run a say play: returns the words and starts nothing', async () => {
    const r = await h.call(RUN, { params: { id: 'read-last-scene' }, body: { when: 'now' } });
    expect(r.body).toEqual({ ok: true, say: 'Read me the last scene aloud.' });
    expect(added).toEqual([]);
    expect(jobs).toEqual([]);
    expect(ran).toEqual([]);
  });

  it('a run is remembered, so the daily look does not suggest that play for 14 days', async () => {
    await h.call(RUN, { params: { id: 'read-last-scene' }, body: {} });
    const saved = JSON.parse(readFileSync(join(dir, 'notices.json'), 'utf-8'));
    expect(Object.keys(saved.playRuns)).toEqual(['read-last-scene']);
    expect(Date.parse(saved.playRuns['read-last-scene'])).toBeGreaterThan(Date.now() - 60_000);
  });

  it('a failed run is a 500 with a fixed message', async () => {
    failTasks = true;
    const r = await h.call(RUN, { params: { id: 'book-dashboard' }, body: {} });
    expect(r.code).toBe(500);
    expect(JSON.stringify(r.body)).not.toMatch(/secret|exploded/);
    expect(ran).toEqual([]);
    const broken = harness({ notices: { playbook: async () => { throw new Error('C:\\secret'); }, runPlay: async () => { throw new Error('C:\\secret'); } } });
    for (const key of broken.routes.keys()) {
      const bad = await broken.call(key, { params: { id: 'x' }, body: {} });
      expect(bad.code).toBe(500);
      expect(JSON.stringify(bad.body)).not.toMatch(/secret/);
    }
  });
});
