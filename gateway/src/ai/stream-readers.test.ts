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

  it('readNdjson handles CRLF line endings', async () => {
    const seen: any[] = [];
    await readNdjson(bodyFrom(['{"a":1}\r\n{"b":2}\r\n']), (o) => seen.push(o));
    expect(seen).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('readNdjson propagates errors thrown by the consumer', async () => {
    await expect(readNdjson(bodyFrom(['{"a":1}\n']), () => { throw new Error('boom'); })).rejects.toThrow('boom');
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

  it('readSse handles CRLF event separators', async () => {
    const seen: any[] = [];
    await readSse(bodyFrom(['data: {"x":1}\r\n\r\ndata: {"x":2}\r\n\r\n']), (o) => seen.push(o));
    expect(seen).toEqual([{ x: 1 }, { x: 2 }]);
  });

  it('readSse skips a malformed event and keeps going', async () => {
    const seen: any[] = [];
    await readSse(bodyFrom(['data: not json\n\ndata: {"ok":1}\n\n']), (o) => seen.push(o));
    expect(seen).toEqual([{ ok: 1 }]);
  });
});
