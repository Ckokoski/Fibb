import { describe, it, expect } from 'vitest';
import { MessagePipeline, MAX_TOOL_CALLS_PER_TURN } from './message-pipeline.js';
import { ToolRegistry, type Tool } from './tools/registry.js';
import type { ServiceContainer } from './container.js';

/**
 * A scripted router: each model call takes the next reply from `script`.
 * Streaming replies are emitted in small chunks to exercise the stream gate.
 */
function makeDeps(script: string[], opts: { tools?: Tool[]; runner?: boolean; failFirst?: boolean } = {}) {
  const log = () => {};
  const calls = { reqs: [] as any[], save: [] as any[], executed: [] as any[], stream: 0, complete: 0 };
  const registry = new ToolRegistry();
  for (const t of opts.tools || []) registry.register(t);
  const next = () => script.length > 1 ? script.shift()! : script[0];
  let failed = false;
  const deps: any = {
    injectionDetector: { detect: () => ({ detected: false, patterns: [], hasHardPattern: false }) },
    permissions: { checkRateLimit: () => true },
    audit: { log }, activityLog: { log },
    preferences: { detectFromMessage: async () => [], buildContext: () => '' },
    chatHistory: { load: async () => [], save: async (c: string, h: any) => { calls.save.push([c, JSON.parse(JSON.stringify(h))]); } },
    facts: { render: () => '', forget: async () => 0, extractFromTurn: async () => {} },
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
      complete: async (req: any) => {
        calls.complete++;
        calls.reqs.push({ ...req, messages: [...req.messages] });
        return { text: next(), tokensUsed: 10, estimatedCost: 0.01, provider: req.provider };
      },
      completeStream: async (req: any, onChunk: (c: string) => void) => {
        calls.stream++;
        calls.reqs.push({ ...req, messages: [...req.messages] });
        if (opts.failFirst && !failed) { failed = true; throw new Error('primary down'); }
        const text = next();
        for (let i = 0; i < text.length; i += 3) onChunk(text.slice(i, i + 3));
        return { text, tokensUsed: 10, estimatedCost: 0.01, provider: req.provider };
      },
      getFallbackProvider: () => (opts.failFirst ? { id: 'ollama' } : null),
    },
    config: { get: (_k: string, d: any) => d },
    costs: { record: (...a: any[]) => { (calls as any).cost = a; } },
    research: { getAllowedDomains: () => [] },
  };
  if (opts.runner !== false) {
    deps.toolRunner = {
      registry,
      execute: async (call: any, ctx: any) => {
        calls.executed.push({ call, ctx });
        const t = registry.get(call.name);
        if (!t) return { kind: 'error', text: `There is no tool named "${call.name}".` };
        if (t.risk === 'write') return { kind: 'needs-approval', id: 'conf-1', description: 'Create a Google Doc titled "Notes"' };
        return { kind: 'result', text: `WRAPPED:${await t.run(call.args)}` };
      },
    };
  }
  return { deps: deps as ServiceContainer, calls };
}

const readTool: Tool = {
  name: 'drive_search', description: 'Search Drive.', args: '{"query": "words"}', risk: 'read',
  summary: 'Searching your Drive…', available: () => true, run: async (a) => `found ${a.query}`,
};
const writeTool: Tool = {
  name: 'doc_create', description: 'Create a doc.', args: '{"title": "..."}', risk: 'write',
  summary: 'Creating a Google Doc…', available: () => true, run: async () => 'never',
};
const CALL = '<tool>{"name":"drive_search","args":{"query":"outline"}}</tool>';
const MSG = 'Can you find my outline for the second book';
const tick = () => new Promise(r => setTimeout(r, 10));

async function run(d: ReturnType<typeof makeDeps>, channel = 'webchat', stream = true) {
  const chunks: string[] = [];
  const events: any[] = [];
  let final = '';
  await new MessagePipeline(d.deps).handleMessage(
    MSG, channel, t => { final = t; }, undefined, undefined, undefined,
    stream ? c => chunks.push(c) : undefined, e => events.push(e),
  );
  await tick();
  return { chunks, events, final };
}

describe('pipeline tool loop', () => {
  it('tool call -> result -> final answer; tool text never reaches onChunk', async () => {
    const d = makeDeps([CALL, 'Your outline is in Drive.'], { tools: [readTool] });
    const r = await run(d);
    expect(r.final).toBe('Your outline is in Drive.');
    expect(r.chunks.join('')).toBe('Your outline is in Drive.');
    expect(r.chunks.join('')).not.toContain('<tool>');
    expect(d.calls.executed).toEqual([{ call: { name: 'drive_search', args: { query: 'outline' } }, ctx: { channel: 'webchat' } }]);

    // System prompt carries the tool section and the "How you work" line.
    expect(d.calls.reqs[0].system).toContain('# Tools');
    expect(d.calls.reqs[0].system).toContain('- drive_search {"query": "words"}: Search Drive.');
    expect(d.calls.reqs[0].system).toContain('- You have tools (see Tools below).');

    // Second call sees the tool call and the wrapped result.
    const m = d.calls.reqs[1].messages;
    expect(m[m.length - 2]).toEqual({ role: 'assistant', content: CALL });
    expect(m[m.length - 1]).toEqual({ role: 'user', content: 'WRAPPED:found outline' });

    expect(r.events).toEqual([
      { name: 'drive_search', status: 'start', summary: 'Searching your Drive…' },
      { name: 'drive_search', status: 'done', summary: 'Searching your Drive…' },
    ]);

    // Only the user message and the final reply are persisted.
    const saved = d.calls.save[d.calls.save.length - 1][1];
    expect(saved.map((h: any) => [h.role, h.content])).toEqual([['user', MSG], ['assistant', 'Your outline is in Drive.']]);
    expect(JSON.stringify(d.calls.save)).not.toContain('<tool>');
    // Tokens and cost are summed across both model calls.
    expect((d.calls as any).cost).toEqual(['gemini', 20, 0.02]);
  });

  it('works without streaming (complete path)', async () => {
    const d = makeDeps([CALL, 'Done.'], { tools: [readTool] });
    const r = await run(d, 'telegram:42', false);
    expect(r.final).toBe('Done.');
    expect(d.calls.complete).toBe(2);
    expect(d.calls.stream).toBe(0);
  });

  it('caps a turn at 6 tool calls, then forces a final answer without tools', async () => {
    const d = makeDeps([CALL], { tools: [readTool] }); // the model never stops calling
    const r = await run(d);
    expect(d.calls.executed).toHaveLength(MAX_TOOL_CALLS_PER_TURN);
    expect(d.calls.reqs).toHaveLength(MAX_TOOL_CALLS_PER_TURN + 1);
    const last = d.calls.reqs[MAX_TOOL_CALLS_PER_TURN];
    expect(last.system).not.toContain('# Tools');
    expect(last.messages[last.messages.length - 1].content).toMatch(/used all your tool calls/);
    expect(r.final).toMatch(/ran out of steps/);
    expect(r.chunks.join('')).toBe(r.final);
    expect(r.final).not.toContain('<tool>');
  });

  it('answers normally after exactly six calls', async () => {
    const d = makeDeps([CALL, CALL, CALL, CALL, CALL, CALL, 'Here is what I found.'], { tools: [readTool] });
    const r = await run(d);
    expect(d.calls.executed).toHaveLength(6);
    expect(r.final).toBe('Here is what I found.');
  });

  it('needs-approval: the model is told to explain and stop; nothing runs', async () => {
    const d = makeDeps(
      ['<tool>{"name":"doc_create","args":{"title":"Notes"}}</tool>', 'I have asked to create a doc called Notes. Say yes in Approvals.'],
      { tools: [readTool, writeTool] },
    );
    const r = await run(d);
    expect(r.final).toBe('I have asked to create a doc called Notes. Say yes in Approvals.');
    expect(r.events).toEqual([
      { name: 'doc_create', status: 'start', summary: 'Creating a Google Doc…' },
      { name: 'doc_create', status: 'needs-approval', summary: 'Waiting for your OK' },
    ]);
    const fed = d.calls.reqs[1].messages[d.calls.reqs[1].messages.length - 1].content;
    expect(fed).toMatch(/author must approve this first/i);
    expect(fed).toMatch(/one or two sentences/);
    expect(fed).toContain('Create a Google Doc titled "Notes"');
    expect(d.calls.reqs).toHaveLength(2);
  });

  it('needs-approval: a model that keeps calling tools is stopped with an honest message', async () => {
    const d = makeDeps(['<tool>{"name":"doc_create","args":{"title":"Notes"}}</tool>'], { tools: [writeTool] });
    const r = await run(d);
    expect(d.calls.executed).toHaveLength(1);
    expect(r.final).toBe('I need your OK before I can do this: Create a Google Doc titled "Notes". It is waiting for you in Approvals.');
    expect(r.chunks.join('')).toBe(r.final);
  });

  it('a malformed tool call is fed back as an error and never shown', async () => {
    const d = makeDeps(['<tool>{"name": oops</tool>', 'Sorry, here is a plain answer.'], { tools: [readTool] });
    const r = await run(d);
    expect(d.calls.executed).toHaveLength(0);
    expect(r.chunks.join('')).toBe('Sorry, here is a plain answer.');
    expect(d.calls.reqs[1].messages.at(-1).content).toMatch(/could not be read/);
    expect(r.events).toEqual([]);
  });

  it('holds back only an ambiguous start: text beginning with "<" still streams in full', async () => {
    const d = makeDeps(['  <to be or not to be>'], { tools: [readTool] });
    const r = await run(d);
    expect(r.chunks.join('')).toBe('  <to be or not to be>');
    const d2 = makeDeps(['<t'], { tools: [readTool] });
    expect((await run(d2)).chunks.join('')).toBe('<t');
  });

  it('an unknown tool error is fed back to the model', async () => {
    const d = makeDeps(['<tool>{"name":"nope","args":{}}</tool>', 'I cannot do that.'], { tools: [readTool] });
    const r = await run(d);
    expect(d.calls.reqs[1].messages.at(-1).content).toBe('Tool error: There is no tool named "nope".');
    expect(r.final).toBe('I cannot do that.');
  });

  it('fallback provider also uses the tool loop without leaking tool text', async () => {
    const d = makeDeps([CALL, 'From the fallback.'], { tools: [readTool], failFirst: true });
    const r = await run(d);
    expect(r.final).toBe('From the fallback.');
    expect(r.chunks).toEqual(['From the fallback.']);
    expect(d.calls.executed).toHaveLength(1);
  });

  it('night-shift gets tools; project and system channels do not', async () => {
    const night = makeDeps([CALL, 'Night result.'], { tools: [readTool] });
    expect((await run(night, 'night-shift')).final).toBe('Night result.');
    expect(night.calls.executed).toHaveLength(1);

    for (const ch of ['project-engine', 'goal-engine', 'projects', 'conductor', 'api-silent', 'api']) {
      const d = makeDeps(['A plain reply.'], { tools: [readTool] });
      await run(d, ch);
      expect(d.calls.reqs[0].system).not.toContain('# Tools');
      expect(d.calls.reqs[0].system).not.toContain('You have tools');
    }
  });
});

describe('pipeline with no tools available is unchanged', () => {
  const offTool: Tool = { ...readTool, available: () => false };

  it('same request, chunks and reply with no runner, an empty registry, or only unavailable tools', async () => {
    const variants = [
      makeDeps([CALL], { runner: false }),
      makeDeps([CALL], { tools: [] }),
      makeDeps([CALL], { tools: [offTool] }),
    ];
    const results = [];
    for (const d of variants) results.push({ d, r: await run(d) });
    const base = results[0];
    for (const { d, r } of results) {
      expect(d.calls.reqs).toHaveLength(1);
      expect(d.calls.reqs[0]).toEqual(base.d.calls.reqs[0]);
      expect(d.calls.reqs[0].system).not.toContain('Tools');
      // No gate, no parsing: a reply that happens to look like a tool call passes through untouched.
      expect(r.final).toBe(CALL);
      expect(r.chunks).toEqual(base.r.chunks);
      expect(r.chunks.join('')).toBe(CALL);
      expect(r.events).toEqual([]);
      expect(d.calls.executed).toHaveLength(0);
    }
  });
});
