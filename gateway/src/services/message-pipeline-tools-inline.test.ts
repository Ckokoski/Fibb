import { describe, it, expect } from 'vitest';
import { splitToolCall } from './message-pipeline.js';

describe('splitToolCall', () => {
  it('returns the whole text when there is no tool call', () => {
    expect(splitToolCall('Just an answer.')).toEqual({ before: 'Just an answer.', call: '' });
  });

  it('separates prose from a trailing tool call', () => {
    const r = splitToolCall('I will click it now.\n<tool>{"name":"web_click","args":{"text":"Learn more"}}</tool>');
    expect(r.before).toBe('I will click it now.');
    expect(r.call).toBe('<tool>{"name":"web_click","args":{"text":"Learn more"}}</tool>');
  });

  it('handles a reply that is only a tool call', () => {
    const r = splitToolCall('<tool>{"name":"web_open","args":{"url":"https://example.com"}}</tool>');
    expect(r.before).toBe('');
    expect(r.call.startsWith('<tool>')).toBe(true);
  });

  it('tolerates non-string input', () => {
    expect(splitToolCall(undefined as unknown as string)).toEqual({ before: '', call: '' });
  });
});
