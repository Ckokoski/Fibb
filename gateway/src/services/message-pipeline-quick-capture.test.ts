import { describe, it, expect } from 'vitest';
import { MessagePipeline, parseQuickCapture } from './message-pipeline.js';
import type { ServiceContainer } from './container.js';

describe('parseQuickCapture', () => {
  it('matches idea captures', () => {
    expect(parseQuickCapture('idea: a heist on a sleeper train')).toEqual({ kind: 'idea', text: 'a heist on a sleeper train' });
    expect(parseQuickCapture('  IDEA - twin narrators ')).toEqual({ kind: 'idea', text: 'twin narrators' });
    expect(parseQuickCapture('Idea:no space')).toEqual({ kind: 'idea', text: 'no space' });
  });
  it('matches tonight captures', () => {
    expect(parseQuickCapture('tonight: draft three blurbs')).toEqual({ kind: 'tonight', text: 'draft three blurbs' });
    expect(parseQuickCapture('Tonight: tighten chapter 4')).toEqual({ kind: 'tonight', text: 'tighten chapter 4' });
    expect(parseQuickCapture('Tonight, I wrote a lot')).toBeNull();
    expect(parseQuickCapture('tonight - research Victorian locks')).toEqual({ kind: 'tonight', text: 'research Victorian locks' });
  });
  it('keeps a multi-line body', () => {
    expect(parseQuickCapture('idea: first line\nsecond line')).toEqual({ kind: 'idea', text: 'first line\nsecond line' });
    expect(parseQuickCapture('tonight:\nsummarize my notes\nand list gaps')).toEqual({ kind: 'tonight', text: 'summarize my notes\nand list gaps' });
  });
  it('does not match ordinary sentences', () => {
    for (const s of [
      'Tonight I wrote a lot',
      'idea of the book is that memory lies',
      'My idea: something else',
      'I had an idea: a train heist',
      'ideas: one, two',
      'idea-driven plots bore me',
      'tonight-ish I will write',
      'idea:',
      'tonight:   ',
      'What should I do tonight: write or rest?',
      '',
    ]) {
      expect(parseQuickCapture(s), s).toBeNull();
    }
  });
});

function makeDeps(calls: any, withTasks = true) {
  const log = () => {};
  const deps: any = {
    injectionDetector: { detect: () => ({ detected: false, patterns: [], hasHardPattern: false }) },
    permissions: { checkRateLimit: () => true },
    audit: { log }, activityLog: { log },
    preferences: { detectFromMessage: async () => [], buildContext: () => '' },
    chatHistory: { load: async () => [], save: async (c: string, h: any) => { calls.save.push([c, h.map((m: any) => ({ ...m }))]); } },
    facts: { render: () => '', forget: async () => 0, extractFromTurn: async () => {} },
    companion: { getActive: () => ({ id: 'nib', look: 'nib', name: 'Fibb', voicePreset: 'narrator_warm', tagline: 't', image: '/mascots/nib.webp' }), getVoicePreset: () => 'narrator_warm' },
    soul: { getFullContext: () => 'SOUL', getFullContextFor: () => 'SOUL' },
    memory: {
      getRelevant: async () => '', getActiveProject: async () => null, getActiveProjectId: () => null,
      getActivePersonaId: () => null, process: async () => {},
    },
    skills: { matchSkills: () => [] },
    heartbeat: { getContext: () => '', recordActivity: log },
    aiRouter: {
      selectProvider: () => ({ id: 'gemini' }),
      getCheapestAvailableProviderId: () => 'ollama',
      complete: async (req: any) => { calls.complete.push(req); return { text: 'ok reply', tokensUsed: 1, estimatedCost: 0, provider: 'gemini' }; },
      completeStream: async (req: any, onChunk: (c: string) => void) => {
        calls.stream.push(req); onChunk('he'); onChunk('llo');
        return { text: 'hello', tokensUsed: 1, estimatedCost: 0, provider: 'gemini' };
      },
      getFallbackProvider: () => null,
    },
    config: { get: (_k: string, d: any) => d },
    costs: { record: log },
    authorOS: { getAvailableTools: () => [] },
    research: { getAllowedDomains: () => [] },
  };
  if (withTasks) deps.tasks = { add: async (input: any) => { calls.add.push(input); return { id: 't1', ...input }; } };
  return deps as ServiceContainer;
}
const newCalls = () => ({ save: [] as any[], add: [] as any[], complete: [] as any[], stream: [] as any[] });

describe('quick capture in the pipeline', () => {
  it('"idea:" stores an idea, replies, streams one chunk, saves history, no AI call', async () => {
    const calls = newCalls();
    const out: string[] = [];
    const chunks: string[] = [];
    await new MessagePipeline(makeDeps(calls)).handleMessage(
      'idea: a heist on a sleeper train', 'webchat', t => out.push(t), undefined, undefined, undefined, c => chunks.push(c));
    expect(calls.add).toEqual([{ title: 'a heist on a sleeper train', detail: 'a heist on a sleeper train', kind: 'idea', source: 'chat' }]);
    expect(calls.complete.length + calls.stream.length).toBe(0);
    expect(out).toEqual(['Saved to Ideas: "a heist on a sleeper train".']);
    expect(chunks).toEqual(out);
    expect(calls.save).toHaveLength(1);
    expect(calls.save[0][0]).toBe('webchat');
    expect(calls.save[0][1].map((m: any) => [m.role, m.content])).toEqual([
      ['user', 'idea: a heist on a sleeper train'],
      ['assistant', 'Saved to Ideas: "a heist on a sleeper train".'],
    ]);
  });

  it('"tonight:" queues a task with an 80-char one-line title and the full detail', async () => {
    const calls = newCalls();
    const out: string[] = [];
    const body = 'draft three back-cover blurbs for the novel,\neach under 150 words, ' + 'and vary the hook '.repeat(5);
    await new MessagePipeline(makeDeps(calls)).handleMessage(`Tonight: ${body}`, 'telegram:1', t => out.push(t));
    expect(calls.add).toHaveLength(1);
    const added = calls.add[0];
    expect(added).toMatchObject({ kind: 'task', when: 'tonight', source: 'chat', detail: body.trim() });
    expect(added.title.length).toBeLessThanOrEqual(80);
    expect(added.title).not.toContain('\n');
    expect(added.title.startsWith('draft three back-cover blurbs for the novel, each under')).toBe(true);
    expect(out[0]).toBe(`Queued for tonight: "${added.title}". I'll have it ready for your review in the morning.`);
    expect(calls.complete.length + calls.stream.length).toBe(0);
  });

  it('ordinary sentences go to the AI', async () => {
    const calls = newCalls();
    await new MessagePipeline(makeDeps(calls)).handleMessage('Tonight I wrote a lot', 'webchat', () => {});
    expect(calls.add).toEqual([]);
    expect(calls.complete).toHaveLength(1);
  });

  it('falls through to the AI when the task store is missing', async () => {
    const calls = newCalls();
    await new MessagePipeline(makeDeps(calls, false)).handleMessage('idea: a train heist', 'webchat', () => {});
    expect(calls.complete).toHaveLength(1);
  });

  it('falls through to the AI when saving fails', async () => {
    const calls = newCalls();
    const deps: any = makeDeps(calls);
    deps.tasks.add = async () => { throw new Error('disk full'); };
    await new MessagePipeline(deps).handleMessage('idea: a train heist', 'webchat', () => {});
    expect(calls.complete).toHaveLength(1);
  });

  it('is skipped on project and night-shift channels', async () => {
    const calls = newCalls();
    const p = new MessagePipeline(makeDeps(calls));
    await p.handleMessage('idea: a train heist', 'goal-engine', () => {});
    await p.handleMessage('tonight: do the thing', 'night-shift', () => {});
    expect(calls.add).toEqual([]);
    expect(calls.complete).toHaveLength(2);
  });

  it('night-shift channel sends only the work order, streams, and saves no history', async () => {
    const calls = newCalls();
    const chunks: string[] = [];
    const out: string[] = [];
    const p = new MessagePipeline(makeDeps(calls));
    await p.handleMessage('Work order one', 'night-shift', t => out.push(t), undefined, undefined, undefined, c => chunks.push(c));
    await p.handleMessage('Work order two', 'night-shift', t => out.push(t), undefined, undefined, undefined, c => chunks.push(c));
    expect(calls.stream).toHaveLength(2);
    expect(calls.stream[1].messages).toEqual([{ role: 'user', content: 'Work order two' }]);
    expect(chunks).toEqual(['he', 'llo', 'he', 'llo']);
    expect(out).toEqual(['hello', 'hello']);
    expect(calls.save).toEqual([]);
  });
});
