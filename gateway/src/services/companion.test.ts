// gateway/src/services/companion.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CompanionService, COMPANIONS } from './companion.js';

let dir: string; let svc: CompanionService;
beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), 'fibb-companion-')); svc = new CompanionService(dir); await svc.initialize(); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

describe('CompanionService', () => {
  it('ships six companions with nib as the default', () => {
    expect(Object.keys(COMPANIONS)).toEqual(['nib', 'fable', 'folio', 'mote', 'quill', 'pip']);
    expect(svc.getActive().id).toBe('nib');
    expect(svc.getActive().name).toBe('Fibb');
    expect(svc.getActive().look).toBe('nib');
    expect(svc.getActive().voicePreset).toBe('narrator_warm');
  });
  it('every look is Fibb; only nib has states; imageFor picks a state image', async () => {
    for (const c of Object.values(COMPANIONS)) { expect(c.name).toBe('Fibb'); expect(c.look).toBe(c.id); }
    expect(COMPANIONS.nib.states).toEqual({ idle: '/mascots/nib/nib-idle.svg', thinking: '/mascots/nib/nib-thinking.svg', listening: '/mascots/nib/nib-listening.svg', celebrating: '/mascots/nib/nib-celebrating.svg' });
    for (const id of ['fable', 'folio', 'mote', 'quill', 'pip']) expect(COMPANIONS[id].states).toBeUndefined();
    expect(svc.imageFor('thinking')).toBe('/mascots/nib/nib-thinking.svg');
    await svc.setActive('quill');
    expect(svc.imageFor('thinking')).toBe(COMPANIONS.quill.image);
  });
  it('persists the selection and rejects unknown ids', async () => {
    await svc.setActive('quill');
    expect(existsSync(join(dir, '.config', 'companion.json'))).toBe(true);
    const again = new CompanionService(dir); await again.initialize();
    expect(again.getActive().id).toBe('quill');
    await expect(svc.setActive('dragonzilla')).rejects.toThrow(/unknown companion/i);
  });
  it('rejects unknown voice presets and accepts known ones', async () => {
    await expect(svc.setVoiceOverride('nope_voice')).rejects.toThrow(/unknown voice preset/i);
    await svc.setVoiceOverride('narrator_warm');
    await svc.setVoiceOverride(null);
  });
  it('falls back to nib when the saved file is corrupt', async () => {
    const { mkdirSync, writeFileSync } = await import('fs');
    mkdirSync(join(dir, '.config'), { recursive: true });
    writeFileSync(join(dir, '.config', 'companion.json'), '{not json');
    const c = new CompanionService(dir); await c.initialize();
    expect(c.getActive().id).toBe('nib');
  });
  it('lists companions with image paths', () => {
    const list = svc.list();
    expect(list).toHaveLength(6);
    expect(list.find(c => c.id === 'mote')!.image).toBe('/mascots/mote.webp');
  });
});
