import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { registerNoticeRoutes } from './notices.js';
import { NoticeService, type UsageInput } from '../../services/notices.js';

type Handler = (req: any, res: any) => any;

function harness(services: any) {
  const routes = new Map<string, Handler>();
  const reg = (m: string) => (path: string, h: Handler) => { routes.set(`${m} ${path}`, h); };
  const app: any = { get: reg('GET'), post: reg('POST'), patch: reg('PATCH'), delete: reg('DELETE') };
  registerNoticeRoutes({ app, gateway: {}, services, baseDir: '' });
  const call = async (key: string, opts: { params?: any; body?: any } = {}) => {
    const res: any = { code: 200, body: undefined };
    res.status = (c: number) => { res.code = c; return res; };
    res.json = (b: any) => { res.body = b; return res; };
    await routes.get(key)!({ params: opts.params || {}, body: opts.body }, res);
    return res as { code: number; body: any };
  };
  return { call, routes };
}

const NOW = new Date(2026, 10, 12, 12, 0, 0);
const DAY = 86_400_000;
const old = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const reviewTask = { id: 't1', title: 'Outline', kind: 'task', source: 'app', when: 'tonight', status: 'review', createdAt: old(6), finishedAt: old(5) };

let dir: string;
let usage: UsageInput;
let jobs: any[];
let added: any[];
let failCron: boolean;
let notices: NoticeService;
let h: ReturnType<typeof harness>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fibb-notice-routes-'));
  jobs = []; added = []; failCron = false;
  usage = { messages: [], tasks: [reviewTask], schedules: [], writingDays: {}, facts: {} };
  notices = new NoticeService(dir, {
    loadUsage: async () => usage,
    tasks: { add: async (i) => { added.push(i); return i; } },
    cron: { createJob: async (i) => { if (failCron) throw new Error('C:\\secret\\path exploded'); jobs.push(i); return i; } },
  });
  await notices.initialize();
  h = harness({ notices });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('notice routes', () => {
  it('registers exactly the documented routes, settings before :id', () => {
    expect([...h.routes.keys()]).toEqual([
      'GET /api/notices', 'GET /api/notices/settings', 'POST /api/notices/settings',
      'POST /api/notices/suggest', 'POST /api/notices/:id/accept', 'POST /api/notices/:id/dismiss',
    ]);
  });

  it('503 on every route when the service is missing', async () => {
    const bare = harness({});
    for (const key of bare.routes.keys()) {
      const r = await bare.call(key, { params: { id: 'x' }, body: { enabled: true } });
      expect(r.code).toBe(503);
      expect(r.body.error).toBeTruthy();
    }
  });

  it('GET lists new notices with only id, text, action label+kind and createdAt', async () => {
    expect((await h.call('GET /api/notices')).body).toEqual({ notices: [] });
    usage = {
      messages: [1, 2, 3].map(d => ({ role: 'user', content: 'tidy the timeline please', timestamp: new Date(NOW.getTime() - d * DAY) })),
      tasks: [], schedules: [], writingDays: {}, facts: {},
    };
    const n = await notices.generate(NOW);
    const r = await h.call('GET /api/notices');
    expect(r.code).toBe(200);
    expect(r.body).toEqual({ notices: [{ id: n!.id, text: n!.text, action: { label: 'Set it up', kind: 'schedule' }, createdAt: NOW.toISOString() }] });
    expect(JSON.stringify(r.body)).not.toMatch(/"key"|"cron"|"detail"|"status"/);
  });

  it('accept: 404 unknown, 200 with message for a schedule, 409 when no longer new', async () => {
    expect((await h.call('POST /api/notices/:id/accept', { params: { id: 'nope' } })).code).toBe(404);
    usage = {
      messages: [1, 2, 3].map(d => ({ role: 'user', content: 'tidy the timeline please', timestamp: new Date(NOW.getTime() - d * DAY) })),
      tasks: [], schedules: [], writingDays: {}, facts: {},
    };
    const n = await notices.generate(NOW);
    const r = await h.call('POST /api/notices/:id/accept', { params: { id: n!.id } });
    expect(r.code).toBe(200);
    expect(r.body).toEqual({ ok: true, message: 'Scheduled "Tidy the timeline please".' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ handler: 'queue-task', name: 'Tidy the timeline please' });
    expect((await h.call('POST /api/notices/:id/accept', { params: { id: n!.id } })).code).toBe(409);
    expect((await h.call('POST /api/notices/:id/dismiss', { params: { id: n!.id } })).code).toBe(409);
    expect(jobs).toHaveLength(1);
    expect((await h.call('GET /api/notices')).body).toEqual({ notices: [] });
  });

  it('accept: a notice with no action is just { ok: true }; a say action returns the text', async () => {
    const n = await notices.generate(NOW);
    expect((await h.call('POST /api/notices/:id/accept', { params: { id: n!.id } })).body).toEqual({ ok: true });

    usage = { messages: [], tasks: [], schedules: [], writingDays: { [old(6).slice(0, 10)]: 400 }, facts: { books: [{ title: 'The Salt Road' }] } };
    const say = await notices.generate(new Date(NOW.getTime() + 2 * DAY));
    const r = await h.call('POST /api/notices/:id/accept', { params: { id: say!.id } });
    expect(r.body).toEqual({ ok: true, say: 'Help me get back into The Salt Road with a ten minute warm-up.' });
  });

  it('accept: a failed action is a 500 with a fixed message and the notice stays', async () => {
    usage = {
      messages: [1, 2, 3].map(d => ({ role: 'user', content: 'tidy the timeline please', timestamp: new Date(NOW.getTime() - d * DAY) })),
      tasks: [], schedules: [], writingDays: {}, facts: {},
    };
    const n = await notices.generate(NOW);
    failCron = true;
    const r = await h.call('POST /api/notices/:id/accept', { params: { id: n!.id } });
    expect(r.code).toBe(500);
    expect(JSON.stringify(r.body)).not.toMatch(/secret|exploded/);
    expect((await h.call('GET /api/notices')).body.notices).toHaveLength(1);
  });

  it('dismiss: 404 unknown, { ok: true }, then gone', async () => {
    expect((await h.call('POST /api/notices/:id/dismiss', { params: { id: 'nope' } })).code).toBe(404);
    const n = await notices.generate(NOW);
    const r = await h.call('POST /api/notices/:id/dismiss', { params: { id: n!.id } });
    expect(r.code).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect((await h.call('GET /api/notices')).body).toEqual({ notices: [] });
    expect((await h.call('POST /api/notices/:id/accept', { params: { id: n!.id } })).code).toBe(409);
  });

  it('suggest: an idea on demand, the waiting notice when there is one, null when nothing is left', async () => {
    usage = { messages: [], tasks: [], schedules: [], writingDays: {}, facts: {} };
    const r = await h.call('POST /api/notices/suggest');
    expect(r.code).toBe(200);
    expect(Object.keys(r.body)).toEqual(['notice']);
    expect(r.body.notice).toMatchObject({ id: expect.any(String), text: expect.stringMatching(/^An idea: /), action: { label: expect.any(String), kind: expect.any(String) } });
    expect(JSON.stringify(r.body)).not.toMatch(/"key"|"cron"|"detail"|"status"|Questions for you/);
    // One at a time: asking again returns the same notice.
    expect((await h.call('POST /api/notices/suggest')).body).toEqual(r.body);
    expect((await h.call('GET /api/notices')).body.notices).toEqual([r.body.notice]);
    // Right after a dismissal the daily look stays quiet, but asking still works.
    await h.call('POST /api/notices/:id/dismiss', { params: { id: r.body.notice.id } });
    expect(await notices.generate(new Date())).toBeNull();
    const second = await h.call('POST /api/notices/suggest');
    expect(second.body.notice.id).not.toBe(r.body.notice.id);

    const none = harness({ notices: { suggestNow: async () => null } });
    expect((await none.call('POST /api/notices/suggest')).body).toEqual({ notice: null });
    const broken = harness({ notices: { suggestNow: async () => { throw new Error('C:\secret'); } } });
    const bad = await broken.call('POST /api/notices/suggest');
    expect(bad.code).toBe(500);
    expect(JSON.stringify(bad.body)).not.toMatch(/secret/);
  });

  it('settings: read, switch off and on, 400 on a non-boolean or missing body', async () => {
    expect((await h.call('GET /api/notices/settings')).body).toEqual({ enabled: true });
    for (const body of [undefined, {}, { enabled: 'false' }, { enabled: 0 }, { enabled: null }]) {
      expect((await h.call('POST /api/notices/settings', { body })).code).toBe(400);
    }
    expect((await h.call('GET /api/notices/settings')).body).toEqual({ enabled: true });
    const off = await h.call('POST /api/notices/settings', { body: { enabled: false } });
    expect(off.code).toBe(200);
    expect(off.body).toEqual({ enabled: false });
    expect(await notices.generate(NOW)).toBeNull();
    expect((await h.call('POST /api/notices/settings', { body: { enabled: true } })).body).toEqual({ enabled: true });
    expect(await notices.generate(NOW)).not.toBeNull();
  });
});
