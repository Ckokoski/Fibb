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

const tick = () => new Promise(r => setTimeout(r, 10));

describe('pipeline streaming and history/extraction gating', () => {
  it('webchat + onChunk streams, saves history, extracts facts', async () => {
    const calls = newCalls();
    const chunks: string[] = [];
    await new MessagePipeline(makeDeps(calls)).handleMessage('Tell me about my protagonist arc', 'webchat', () => {}, undefined, undefined, undefined, c => chunks.push(c));
    await tick();
    expect(calls.stream).toBe(1);
    expect(calls.complete).toBe(0);
    expect(chunks).toEqual(['he', 'llo']);
    expect(calls.save.some(s => s[0] === 'webchat')).toBe(true);
    expect(calls.extract.length).toBe(1);
  });
  it('project-engine + onChunk uses complete, no save or extract', async () => {
    const calls = newCalls();
    await new MessagePipeline(makeDeps(calls)).handleMessage('Tell me about my protagonist arc', 'project-engine', () => {}, undefined, undefined, undefined, () => {});
    await tick();
    expect(calls.complete).toBe(1);
    expect(calls.stream).toBe(0);
    expect(calls.save.length).toBe(0);
    expect(calls.extract.length).toBe(0);
  });
  it('conductor: no save, no extract', async () => {
    const calls = newCalls();
    await new MessagePipeline(makeDeps(calls)).handleMessage('Tell me about my protagonist arc', 'conductor', () => {});
    await tick();
    expect(calls.save.length).toBe(0);
    expect(calls.extract.length).toBe(0);
  });
});
