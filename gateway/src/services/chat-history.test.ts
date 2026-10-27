import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ChatHistoryStore } from './chat-history.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fibb-history-')); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

describe('ChatHistoryStore', () => {
  it('returns an empty array for an unknown channel', async () => {
    const store = new ChatHistoryStore(dir);
    expect(await store.load('webchat')).toEqual([]);
  });

  it('round-trips messages per channel and sanitizes the channel name into a filename', async () => {
    const store = new ChatHistoryStore(dir);
    const msgs = [
      { role: 'user', content: 'hi', timestamp: new Date('2026-10-07T10:00:00Z') },
      { role: 'assistant', content: 'hello', timestamp: new Date('2026-10-07T10:00:01Z') },
    ];
    await store.save('telegram:12345', msgs);
    expect(existsSync(join(dir, 'history', 'telegram_12345.json'))).toBe(true);
    const loaded = await store.load('telegram:12345');
    expect(loaded.map(m => m.content)).toEqual(['hi', 'hello']);
    expect(loaded[0].timestamp).toBeInstanceOf(Date);
    expect(await store.load('webchat')).toEqual([]);
  });

  it('keeps only the newest maxMessages on save', async () => {
    const store = new ChatHistoryStore(dir, 3);
    const msgs = [1, 2, 3, 4, 5].map(i => ({ role: 'user', content: String(i), timestamp: new Date() }));
    await store.save('webchat', msgs);
    expect((await store.load('webchat')).map(m => m.content)).toEqual(['3', '4', '5']);
  });

  it('writes atomically: no .tmp file is left behind after save', async () => {
    const store = new ChatHistoryStore(dir);
    await store.save('webchat', [{ role: 'user', content: 'x', timestamp: new Date() }]);
    expect(readdirSync(join(dir, 'history')).some(f => f.endsWith('.tmp'))).toBe(false);
  });

  it('skips invalid entries instead of throwing on a non-object element', async () => {
    mkdirSync(join(dir, 'history'), { recursive: true });
    writeFileSync(join(dir, 'history', 'webchat.json'), JSON.stringify([null, 1, { role: 'user', content: 'ok', timestamp: '2026-01-01T00:00:00.000Z' }]));
    const store = new ChatHistoryStore(dir);
    const loaded = await store.load('webchat');
    expect(loaded).toHaveLength(1);
    expect(loaded[0].content).toBe('ok');
  });

  it('quarantines a corrupt history file and returns empty', async () => {
    mkdirSync(join(dir, 'history'), { recursive: true });
    writeFileSync(join(dir, 'history', 'webchat.json'), '{{{ not json');
    const store = new ChatHistoryStore(dir);
    expect(await store.load('webchat')).toEqual([]);
    expect(readdirSync(join(dir, 'history')).some(f => /^webchat\.json\.corrupt-/.test(f))).toBe(true);
  });
});
