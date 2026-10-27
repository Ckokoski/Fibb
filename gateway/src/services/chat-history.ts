/**
 * Per-channel chat history persisted as JSON under <memoryDir>/history/.
 * The MessagePipeline keeps its in-memory Map as the hot path; this store
 * makes it survive restarts (spec §3 "Persistent history").
 */
import { mkdir, readFile, writeFile, rename, copyFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { logger } from './logger.js';

export interface HistoryMessage { role: string; content: string; timestamp: Date }

let writeSeq = 0;

/** Write to a unique temp file beside `file`, then rename over it. Cleans up the temp on failure. */
async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.${++writeSeq}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

const isEntry = (m: unknown): m is { role: string; content: string; timestamp: string } =>
  typeof m === 'object' && m !== null && !Array.isArray(m) &&
  typeof (m as any).role === 'string' && typeof (m as any).content === 'string';

export class ChatHistoryStore {
  private dir: string;
  private writeChain: Promise<void> = Promise.resolve();
  constructor(memoryDir: string, private maxMessages = 200) {
    this.dir = join(memoryDir, 'history');
  }

  private fileFor(channel: string): string {
    const safe = channel.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    return join(this.dir, `${safe}.json`);
  }

  async load(channel: string): Promise<HistoryMessage[]> {
    const file = this.fileFor(channel);
    if (!existsSync(file)) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, 'utf-8'));
    } catch (err) {
      logger.warn(`chat history for ${channel} unreadable, starting empty`, err);
      await quarantine(file);
      return [];
    }
    if (!Array.isArray(raw)) {
      logger.warn(`chat history for ${channel} is not an array, starting empty`);
      return [];
    }
    return raw
      .filter(isEntry)
      .map(m => ({ role: m.role, content: m.content, timestamp: new Date(m.timestamp) }));
  }

  /** Writes for this store run one at a time; the returned promise settles when this write lands. */
  save(channel: string, messages: HistoryMessage[]): Promise<void> {
    const trimmed = messages.slice(-this.maxMessages).map(m => ({
      role: m.role, content: m.content, timestamp: m.timestamp.toISOString(),
    }));
    const file = this.fileFor(channel);
    const next = this.writeChain.then(async () => {
      await mkdir(this.dir, { recursive: true });
      await writeAtomic(file, JSON.stringify(trimmed));
    });
    this.writeChain = next.catch(() => {});
    return next;
  }
}

/** Copy an unreadable file aside so it is never silently overwritten. */
async function quarantine(file: string): Promise<void> {
  const dest = `${file}.corrupt-${Date.now()}`;
  try {
    await copyFile(file, dest);
  } catch (err) {
    logger.warn(`could not quarantine ${file}`, err);
  }
}
