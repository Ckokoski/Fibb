// gateway/src/services/companion.ts
/**
 * Companions (spec P2 §1): the character the author talks to. Picking one
 * changes the avatar, the name the assistant introduces itself with, and its
 * default voice preset. "Fibb" stays the product name.
 */
import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { logger } from './logger.js';

export interface Companion {
  id: string;
  name: string;
  voicePreset: string;   // key of TTSService.VOICE_PRESETS
  tagline: string;
  image: string;         // public path served by the app
}

export const COMPANIONS: Record<string, Companion> = {
  nib:   { id: 'nib',   name: 'Nib',   voicePreset: 'narrator_warm',  tagline: 'the ink drop who never forgets a thread', image: '/mascots/nib.webp' },
  fable: { id: 'fable', name: 'Fable', voicePreset: 'storyteller',    tagline: 'a small dragon who guards your book',      image: '/mascots/fable.webp' },
  folio: { id: 'folio', name: 'Folio', voicePreset: 'british_female', tagline: 'pages for ears, tidy to a fault',          image: '/mascots/folio.webp' },
  mote:  { id: 'mote',  name: 'Mote',  voicePreset: 'curious_kid',    tagline: 'a moth drawn to a bright idea',            image: '/mascots/mote.webp' },
  quill: { id: 'quill', name: 'Quill', voicePreset: 'british_male',   tagline: 'a hedgehog made of pens',                  image: '/mascots/quill.webp' },
  pip:   { id: 'pip',   name: 'Pip',   voicePreset: 'narrator_female', tagline: 'the sprout, small and relentless',         image: '/mascots/pip.webp' },
};

export const DEFAULT_COMPANION_ID = 'nib';

export class CompanionService {
  private file: string;
  private activeId: string = DEFAULT_COMPANION_ID;
  private voiceOverride: string | null = null;

  constructor(workspaceDir: string) {
    this.file = join(workspaceDir, '.config', 'companion.json');
  }

  async initialize(): Promise<void> {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf-8'));
      if (typeof raw?.id === 'string' && COMPANIONS[raw.id]) this.activeId = raw.id;
      if (typeof raw?.voiceOverride === 'string' && raw.voiceOverride) this.voiceOverride = raw.voiceOverride;
    } catch (err) {
      logger.warn('companion.json unreadable, using default companion', err);
    }
  }

  list(): Companion[] { return Object.values(COMPANIONS); }

  getActive(): Companion { return COMPANIONS[this.activeId]; }

  /** The voice preset id to speak with: user override first, else the companion's. */
  getVoicePreset(): string { return this.voiceOverride ?? this.getActive().voicePreset; }

  async setActive(id: string): Promise<Companion> {
    if (!COMPANIONS[id]) throw new Error(`Unknown companion: ${id}`);
    this.activeId = id;
    await this.persist();
    return this.getActive();
  }

  /** Pass null to clear the override and return to the companion's default voice. */
  async setVoiceOverride(preset: string | null): Promise<void> {
    this.voiceOverride = preset && preset.trim() ? preset.trim() : null;
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(join(this.file, '..'), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    const { rename, unlink } = await import('fs/promises');
    try {
      await writeFile(tmp, JSON.stringify({ id: this.activeId, voiceOverride: this.voiceOverride }, null, 2));
      await rename(tmp, this.file);
    } catch (err) {
      try { await unlink(tmp); } catch { /* ignore */ }
      throw err;
    }
  }
}
