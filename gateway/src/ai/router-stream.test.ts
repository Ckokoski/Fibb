import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AIRouter } from './router.js';

function streamResponse(chunks: string[], headers: Record<string, string> = {}): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) { for (const s of chunks) c.enqueue(enc.encode(s)); c.close(); },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json', ...headers } });
}

const fakeVault = { get: vi.fn(async (_k: string) => 'test-key') } as any;
const fakeCosts = { isOverBudget: vi.fn(() => false) } as any;

describe('AIRouter.completeStream', () => {
  let router: AIRouter;
  beforeEach(() => {
    router = new AIRouter({}, fakeVault, fakeCosts);
    (router as any).providers.set('ollama', {
      id: 'ollama', name: 'Ollama', tier: 'free', endpoint: 'http://localhost:11434',
      model: 'llama3.2', maxTokens: 4096, costPer1kInput: 0, costPer1kOutput: 0, available: true,
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('streams Ollama NDJSON chunks and returns the joined text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([
      '{"message":{"content":"Hel"},"done":false}\n',
      '{"message":{"content":"lo"},"done":false}\n',
      '{"message":{"content":""},"done":true,"prompt_eval_count":10,"eval_count":2}\n',
    ])));
    const chunks: string[] = [];
    const res = await router.completeStream(
      { provider: 'ollama', system: 'sys', messages: [{ role: 'user', content: 'hi' }] },
      (c) => chunks.push(c),
    );
    expect(chunks).toEqual(['Hel', 'lo']);
    expect(res.text).toBe('Hello');
    expect(res.tokensUsed).toBe(12);
    expect(res.provider).toBe('ollama');
  });

  it('throws when the stream ends with no text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(['{"done":true}\n'])));
    await expect(router.completeStream(
      { provider: 'ollama', system: 'sys', messages: [{ role: 'user', content: 'hi' }] },
      () => {},
    )).rejects.toThrow(/empty/i);
  });
});
