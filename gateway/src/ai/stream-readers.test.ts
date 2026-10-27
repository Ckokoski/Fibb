import { describe, it, expect } from 'vitest';
import { readNdjson, readSse } from './stream-readers.js';

function bodyFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

describe('readNdjson', () => {
  it('yields one parsed object per line even when lines split across chunks', async () => {
    const body = bodyFrom(['{"a":1}\n{"b":', '2}\n', '{"c":3}']);
    const seen: any[] = [];
    await readNdjson(body, (obj) => seen.push(obj));
    expect(seen).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it('skips blank and malformed lines without throwing', async () => {
    const body = bodyFrom(['\n{"ok":true}\nnot json\n']);
    const seen: any[] = [];
    await readNdjson(body, (obj) => seen.push(obj));
    expect(seen).toEqual([{ ok: true }]);
  });
});

describe('readSse', () => {
  it('yields the data payload of each event and stops on [DONE]', async () => {
    const body = bodyFrom([
      'data: {"x":1}\n\n',
      'event: ping\ndata: {"x":', '2}\n\n',
      'data: [DONE]\n\n',
      'data: {"x":3}\n\n',
    ]);
    const seen: any[] = [];
    await readSse(body, (obj) => seen.push(obj));
    expect(seen).toEqual([{ x: 1 }, { x: 2 }]);
  });
});
