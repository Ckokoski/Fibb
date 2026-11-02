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
import { TTSService } from './tts.js';

export type NibState = 'idle' | 'thinking' | 'listening' | 'celebrating';

export interface Companion {
  id: string;
  look: string;          // the look's id; the character is always Fibb
  name: 'Fibb';
  voicePreset: string;   // key of TTSService.VOICE_PRESETS
  tagline: string;
  image: string;         // public path served by the app
  states?: Record<NibState, string>;
}

export const COMPANIONS: Record<string, Companion> = {
  nib:   { id: 'nib',   look: 'nib', name: 'Fibb',   voicePreset: 'narrator_warm',  tagline: 'the ink drop who never forgets a thread', image: '/mascots/nib.webp',
          states: { idle: '/mascots/nib/nib-idle.svg', thinking: '/mascots/nib/nib-thinking.svg', listening: '/mascots/nib/nib-listening.svg', celebrating: '/mascots/nib/nib-celebrating.svg' } },
  fable: { id: 'fable', look: 'fable', name: 'Fibb', voicePreset: 'storyteller',    tagline: 'a small dragon who guards your book',      image: '/mascots/fable.webp' },
  folio: { id: 'folio', look: 'folio', name: 'Fibb', voicePreset: 'british_female', tagline: 'pages for ears, tidy to a fault',          image: '/mascots/folio.webp' },
  mote:  { id: 'mote',  look: 'mote', name: 'Fibb',  voicePreset: 'curious_kid',    tagline: 'a moth drawn to a bright idea',            image: '/mascots/mote.webp' },
  quill: { id: 'quill', look: 'quill', name: 'Fibb', voicePreset: 'british_male',   tagline: 'a hedgehog made of pens',                  image: '/mascots/quill.webp' },
  pip:   { id: 'pip',   look: 'pip', name: 'Fibb',   voicePreset: 'narrator_female', tagline: 'the sprout, small and relentless',         image: '/mascots/pip.webp' },
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

  imageFor(state: NibState): string { const c = this.getActive(); return c.states?.[state] ?? c.image; }

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
    const next = preset && preset.trim() ? preset.trim() : null;
    if (next && !Object.keys(TTSService.VOICE_PRESETS).includes(next)) throw new Error('Unknown voice preset');
    this.voiceOverride = next;
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
