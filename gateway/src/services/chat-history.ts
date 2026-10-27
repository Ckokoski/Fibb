/**
 * Per-channel chat history persisted as JSON under <memoryDir>/history/.
 * The MessagePipeline keeps its in-memory Map as the hot path; this store
 * makes it survive restarts (spec §3 "Persistent history").
 */
import { mkdir, readFile, writeFile, rename, copyFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { logger } from './logger.js';

export interface HistoryMessage { role: string; content: string; timestamp: Date }

export class ChatHistoryStore {
  private dir: string;
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
      await quarantine(file);
      return [];
    }
    return (raw as Array<{ role: string; content: string; timestamp: string }>)
      .map(m => ({ role: m.role, content: m.content, timestamp: new Date(m.timestamp) }));
  }

  async save(channel: string, messages: HistoryMessage[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const trimmed = messages.slice(-this.maxMessages).map(m => ({
      role: m.role, content: m.content, timestamp: m.timestamp.toISOString(),
    }));
    const file = this.fileFor(channel);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(trimmed));
    await rename(tmp, file);
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
