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

  it('parses OpenAI-compatible SSE (deepseek)', async () => {
    (router as any).providers.set('deepseek', {
      id: 'deepseek', name: 'DeepSeek', tier: 'cheap', endpoint: 'https://api.deepseek.com',
      model: 'deepseek-chat', maxTokens: 4096, costPer1kInput: 0.00014, costPer1kOutput: 0.00028, available: true,
    });
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
      'data: {"usage":{"total_tokens":7},"choices":[]}\n\n',
      'data: [DONE]\n\n',
    ])));
    const chunks: string[] = [];
    const res = await router.completeStream(
      { provider: 'deepseek', system: 's', messages: [{ role: 'user', content: 'hi' }] },
      (c) => chunks.push(c),
    );
    expect(chunks).toEqual(['Hi', ' there']);
    expect(res.text).toBe('Hi there');
    expect(res.tokensUsed).toBe(7);
    expect(res.provider).toBe('deepseek');
  });

  it('parses Gemini SSE', async () => {
    (router as any).providers.set('gemini', {
      id: 'gemini', name: 'Gemini', tier: 'free', endpoint: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-2.0-flash', maxTokens: 4096, costPer1kInput: 0, costPer1kOutput: 0, available: true,
    });
    const f = vi.fn(async (_u: any, _i?: any) => streamResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}\n\n',
      'data: {"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}\n\n',
    ]));
    vi.stubGlobal('fetch', f);
    const res = await router.completeStream(
      { provider: 'gemini', system: 's', messages: [{ role: 'user', content: 'hi' }] },
      () => {},
    );
    expect(res.text).toBe('Hello');
    expect(res.tokensUsed).toBe(7);
    expect(String(f.mock.calls[0][0])).toContain(':streamGenerateContent?alt=sse');
  });

  it('falls back to complete() when thinking is set', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const spy = vi.spyOn(router, 'complete').mockResolvedValue(
      { text: 'full', tokensUsed: 3, estimatedCost: 0, provider: 'ollama' } as any);
    const chunks: string[] = [];
    await router.completeStream(
      { provider: 'ollama', system: 's', messages: [{ role: 'user', content: 'hi' }], thinking: 'high' },
      (c) => chunks.push(c),
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(chunks).toEqual(['full']);
    expect(f).not.toHaveBeenCalled();
  });
});
