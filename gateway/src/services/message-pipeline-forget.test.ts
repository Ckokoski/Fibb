import { describe, it, expect } from 'vitest';
import { MessagePipeline } from './message-pipeline.js';
import type { ServiceContainer } from './container.js';

function makeDeps(calls: any) {
  const log = () => {};
  const deps: any = {
    injectionDetector: { detect: () => ({ detected: false, patterns: [], hasHardPattern: false }) },
    permissions: { checkRateLimit: () => true },
    audit: { log }, activityLog: { log },
    preferences: { detectFromMessage: async () => [], buildContext: () => '' },
    chatHistory: { load: async () => [], save: async (c: string, h: any) => { calls.save.push([c, h]); } },
    facts: {
      render: () => '',
      forget: async (p: string) => { calls.forget.push(p); return 1; },
      extractFromTurn: async (...a: any[]) => { calls.extract.push(a); },
    },
    soul: { getFullContext: () => 'SOUL' },
    memory: {
      getRelevant: async () => '', getActiveProject: async () => null, getActiveProjectId: () => null,
      getActivePersonaId: () => null, process: async () => {},
    },
    skills: { matchSkills: () => [] },
    heartbeat: { getContext: () => '', recordActivity: log },
    aiRouter: {
      selectProvider: () => ({ id: 'gemini' }),
      getCheapestAvailableProviderId: () => 'ollama',
      complete: async () => { calls.complete++; return { text: 'ok reply', tokensUsed: 1, estimatedCost: 0, provider: 'gemini' }; },
      completeStream: async (_r: any, onChunk: (c: string) => void) => {
        calls.stream++; onChunk('he'); onChunk('llo');
        return { text: 'hello', tokensUsed: 1, estimatedCost: 0, provider: 'gemini' };
      },
      getFallbackProvider: () => null,
    },
    config: { get: (_k: string, d: any) => d },
    costs: { record: log },
    authorOS: { getAvailableTools: () => [] },
    research: { getAllowedDomains: () => [] },
  };
  return deps as ServiceContainer;
}
const newCalls = () => ({ save: [] as any[], forget: [] as string[], extract: [] as any[], complete: 0, stream: 0 });

describe('"forget that" user path', () => {
  it('calls facts.forget and makes no AI call', async () => {
    const calls = newCalls();
    const out: string[] = [];
    await new MessagePipeline(makeDeps(calls)).handleMessage('forget that I hate adverbs', 'webchat', t => out.push(t), undefined, undefined, undefined, () => {});
    expect(calls.forget).toEqual(['I hate adverbs']);
    expect(calls.complete + calls.stream).toBe(0);
    expect(out[0]).toContain('forgotten that about "I hate adverbs"');
    expect(calls.save.length).toBe(1);
  });
  it('bare "forget that" goes to the AI', async () => {
    const calls = newCalls();
    await new MessagePipeline(makeDeps(calls)).handleMessage('forget that', 'webchat', () => {});
    expect(calls.forget).toEqual([]);
    expect(calls.complete).toBe(1);
  });
  it('creative prose with a comma is not swallowed', async () => {
    const calls = newCalls();
    await new MessagePipeline(makeDeps(calls)).handleMessage('Forget the plan, Mara runs the heist', 'webchat', () => {});
    expect(calls.forget).toEqual([]);
    expect(calls.complete).toBe(1);
  });
  it('implicit forget with no match falls through to the AI', async () => {
    const calls = newCalls();
    const deps: any = makeDeps(calls);
    deps.facts.forget = async (p: string) => { calls.forget.push(p); return 0; };
    await new MessagePipeline(deps).handleMessage('forget that quantum physics', 'webchat', () => {});
    expect(calls.forget).toEqual(['quantum physics']);
    expect(calls.complete).toBe(1);
  });
  it('explicit "fibb, forget" with no match replies without the AI', async () => {
    const calls = newCalls();
    const deps: any = makeDeps(calls);
    deps.facts.forget = async (p: string) => { calls.forget.push(p); return 0; };
    const out: string[] = [];
    await new MessagePipeline(deps).handleMessage('fibb, forget quantum physics', 'webchat', t => out.push(t));
    expect(calls.complete + calls.stream).toBe(0);
    expect(out[0]).toContain("don't have anything");
  });
  it('a normal message calls the router', async () => {
    const calls = newCalls();
    await new MessagePipeline(makeDeps(calls)).handleMessage('Please outline chapter three', 'webchat', () => {});
    expect(calls.forget).toEqual([]);
    expect(calls.complete).toBe(1);
  });
});
