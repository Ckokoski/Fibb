/**
 * Per-channel chat history persisted as JSON under <memoryDir>/history/.
 * The MessagePipeline keeps its in-memory Map as the hot path; this store
 * makes it survive restarts (spec §3 "Persistent history").
 */
import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

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
    try {
      const raw = JSON.parse(await readFile(file, 'utf-8')) as Array<{ role: string; content: string; timestamp: string }>;
      return raw.map(m => ({ role: m.role, content: m.content, timestamp: new Date(m.timestamp) }));
    } catch {
      return [];
    }
  }

  async save(channel: string, messages: HistoryMessage[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const trimmed = messages.slice(-this.maxMessages).map(m => ({
      role: m.role, content: m.content, timestamp: m.timestamp.toISOString(),
    }));
    await writeFile(this.fileFor(channel), JSON.stringify(trimmed));
  }
}
