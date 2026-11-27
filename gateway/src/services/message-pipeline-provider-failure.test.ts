import { describe, it, expect } from 'vitest';
import { plainProviderFailure } from './message-pipeline.js';

describe('plainProviderFailure', () => {
  it('explains a rejected key and where to fix it', () => {
    const t = plainProviderFailure('gemini', 'Gemini error 400: API key not valid. Please pass a valid API key.');
    expect(t).toBe('Your Gemini key was rejected. It may have been deleted or replaced. Add a fresh one under Settings, Connections.');
  });
  it('explains a used-up limit', () => {
    expect(plainProviderFailure('gemini', 'error 429 RESOURCE_EXHAUSTED')).toMatch(/limit is used up/);
  });
  it('explains a network problem', () => {
    expect(plainProviderFailure('deepseek', 'TypeError: fetch failed')).toMatch(/could not reach Deepseek/);
  });
  it('falls back to a general sentence', () => {
    expect(plainProviderFailure('', 'something odd')).toMatch(/could not answer just now/);
  });
});
