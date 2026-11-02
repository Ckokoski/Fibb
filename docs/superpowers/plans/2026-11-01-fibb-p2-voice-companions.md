# Fibb P2 Implementation Plan — Companions, Voice, Connections, Polish

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Fibb a chosen companion (picture, name, voice), voice in and out on Telegram and desktop, a secure Connections screen, Markdown rendering, and a polish pass.

**Architecture:** New `CompanionService` holds the active companion and threads its name into the prompt and its voice into TTS. New `TranscribeService` wraps Gemini audio (free) with an optional whisper.cpp path; one multipart route exposes it. Telegram handles voice notes; the app gets mic, read-aloud, hands-free, a companion picker, and a Settings view with Connections and Voice sections.

**Tech Stack:** TypeScript on tsx (NodeNext, `.js` imports), Express 4, multer (shared `upload` in `api/context.ts`), vitest; `node-edge-tts` (already present); app: Vite + React 18 + TS, add `marked` and `dompurify` (+ `@types/dompurify`); Python 3 + Pillow for the one-off image prep.

**Spec:** `docs/superpowers/specs/2026-11-01-fibb-p2-voice-companions.md` (binding) on top of `docs/superpowers/specs/2026-10-04-fibb-design.md`.

**Repo root for every command:** the repository checkout (branch `fibb-p2` from `main` @ f88bc7a or later). Git Bash syntax.

**Conventions:** `.js` import extensions; tests beside source as `*.test.ts` using `mkdtempSync(join(tmpdir(), 'fibb-...'))`; `npm run check` (tsc + vitest, currently 26 files / 461 tests) and `npm run app:build` must pass before each commit; commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; never POST to vault routes with real slot names in tests; never kill processes you did not start.

**Existing facts the tasks rely on:**
- `TTSService` (`gateway/src/services/tts.ts`): `static VOICE_PRESETS` (9 Edge presets: narrator_female, narrator_male, narrator_deep, narrator_warm, british_male, british_female, storyteller, snarky_nerd, curious_kid, each `{id, voice, description, gender}`), `listPresets()`, `generate(text, {voice, provider, ...}) → {success, filename?, url?, error?}`, `getActiveVoice()`, `setVoice()`.
- Routes: `POST /api/audio/generate {text, voice?}` returns the generate result (includes a file URL under `/api/audio/file/:filename`), `GET /api/audio/voices`, `POST /api/audio/config {voice, provider}`, `POST /api/vault {key,value}`, `GET /api/vault/keys → {keys: string[]}`, `DELETE /api/vault/:key`, `POST /api/providers/refresh → {providers:[{id,name,model,tier}]}`, `GET /api/models → {providers: [...]}`, `POST /api/models {provider, model}`.
- `ApiContext` exposes `app`, `gateway`, `services`, `baseDir`; `upload` multer instance exported from `gateway/src/api/context.ts`.
- Gemini: vault key `gemini_api_key`, endpoint `https://generativelanguage.googleapis.com/v1beta`; the router's gemini provider has `.model`.
- Telegram bridge: `poll()` currently `continue`s on `!message?.text`; `handleInput(chatId, text, userName)`; `voiceMode: Map<number, string|boolean>`; `generateAndSendVoice(chatId, text, preset)`; `sendMessage`.
- Pipeline: `buildSystemPrompt` starts with `# Your Identity` + soul; `this.deps.facts.render(1500)` follows. `SoulService.getName()` reads the first `#` heading of SOUL.md.
- App: `app/src/{App.tsx, components/{ChatView,Message,Composer,TonightPanel,FirstRunCard,Rail}.tsx, lib/{api,theme}.ts, styles/{tokens,app}.css}`; `View = 'chat'|'books'|'ideas'|'review'|'settings'`.

---

## File structure

**Gateway**
- Create `gateway/src/services/companion.ts` + test: companion table, persistence, active selection.
- Create `gateway/src/services/transcribe.ts` + test: Gemini audio / whisper.cpp transcription.
- Create `gateway/src/api/routes/companion.ts`: `GET /api/companions`, `GET/POST /api/companion`.
- Modify `gateway/src/api/routes/audio.ts`: add `POST /api/audio/transcribe`; make `/api/audio/generate` default to the companion voice when no voice given.
- Modify `gateway/src/api/routes.ts`: register companion routes.
- Modify `gateway/src/services/container.ts`, `gateway/src/index.ts`: wire `companion`, `transcribe`.
- Modify `gateway/src/services/message-pipeline.ts`: identity line with companion name; voice-note tag awareness.
- Modify `gateway/src/services/soul.ts`: `{{name}}` templating.
- Modify `workspace/soul/SOUL.md`: use `{{name}}`.
- Modify `gateway/src/bridges/telegram.ts`: voice notes in, voice replies for voice turns, grouped `/voice` list.
- Create `scripts/prep-mascots.py`; regenerate `app/public/mascots/*.webp` (512px, caption cropped) and `app/public/icons/{icon-192,icon-512}.png`.

**App**
- Modify `app/src/lib/api.ts`: companions, transcribe, tts, vault/model/provider helpers.
- Create `app/src/lib/voice.ts`: Web Speech wrapper + MediaRecorder fallback + audio playback queue.
- Create `app/src/components/{CompanionPicker,SettingsView,MascotAvatar,VoiceControls,EmptyState,TonightSheet}.tsx`.
- Modify `app/src/components/{ChatView,Message,Composer,TonightPanel,FirstRunCard}.tsx`, `App.tsx`, `styles/app.css`, `public/manifest.webmanifest`, `index.html`.

---

## Task 1: Companion service

**Files:** Create `gateway/src/services/companion.ts`, `gateway/src/services/companion.test.ts`

- [ ] **Step 1: Failing test**

```ts
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
    expect(svc.getActive().name).toBe('Nib');
    expect(svc.getActive().voicePreset).toBe('narrator_warm');
  });
  it('persists the selection and rejects unknown ids', async () => {
    await svc.setActive('quill');
    expect(existsSync(join(dir, '.config', 'companion.json'))).toBe(true);
    const again = new CompanionService(dir); await again.initialize();
    expect(again.getActive().id).toBe('quill');
    await expect(svc.setActive('dragonzilla')).rejects.toThrow(/unknown companion/i);
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
```

- [ ] **Step 2:** `npx vitest run gateway/src/services/companion.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
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
```

- [ ] **Step 4:** run the test → 4 passed. `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** `P2: CompanionService (six companions, persisted selection, voice override)`

## Task 2: Wire companion into container, prompt, soul, and routes

**Files:** Modify `gateway/src/services/container.ts`, `gateway/src/index.ts`, `gateway/src/services/soul.ts`, `workspace/soul/SOUL.md`, `gateway/src/services/message-pipeline.ts`; Create `gateway/src/api/routes/companion.ts`; Modify `gateway/src/api/routes.ts`

- [ ] **Step 1: Container + index.** Add `companion: CompanionService` to the ServiceContainer interface, class field, and deps object (next to `facts`). In `index.ts`, where `facts` is constructed (right after `PreferenceStore`), add:
```ts
    this.companion = new CompanionService(this.workspaceDir);
    await this.companion.initialize();
```
using whatever variable holds the workspace directory there (the same one passed to `TTSService`). Add the getter/setter proxy pair the file uses for other services.

- [ ] **Step 2: Soul templating.** In `soul.ts` add:
```ts
  /** Render the soul text with the companion name substituted for {{name}}. */
  getFullContextFor(name: string): string {
    return this.getFullContext().replace(/\{\{\s*name\s*\}\}/g, name);
  }
```
Keep `getFullContext()` as is (used by project engine). In `workspace/soul/SOUL.md`, replace the title line `# Fibb` with `# {{name}}` and the first sentence `You are **Fibb**, an author's writing partner.` with `You are **{{name}}**, an author's writing partner inside Fibb.` Everything else unchanged. In `soul.ts` `load()`, the name extraction from the heading will now read `{{name}}`; change `getName()` to return `'Fibb'` when the heading contains `{{`.

- [ ] **Step 3: Pipeline.** In `handleMessage`, where `soul` is read (`const soul = this.deps.soul.getFullContext()` or similar), use `this.deps.soul.getFullContextFor(this.deps.companion.getActive().name)`. In `buildSystemPrompt`, directly after `prompt += '# Your Identity\n\n';` add:
```ts
    const companion = this.deps.companion.getActive();
    prompt += `Your name is ${companion.name}. Fibb is the product you live in; you are ${companion.name}, ${companion.tagline}. Introduce yourself as ${companion.name}.\n\n`;
```
Also record the companion in facts when it changes: not needed here (route does it).

- [ ] **Step 4: Routes.**
```ts
// gateway/src/api/routes/companion.ts
import type { Request, Response } from 'express';
import type { ApiContext } from '../context.js';

export function registerCompanionRoutes(ctx: ApiContext): void {
  const { app, services } = ctx;
  app.get('/api/companions', (_req: Request, res: Response) => {
    res.json({ companions: services.companion.list(), activeId: services.companion.getActive().id });
  });
  app.get('/api/companion', (_req: Request, res: Response) => {
    const c = services.companion.getActive();
    res.json({ ...c, voicePreset: services.companion.getVoicePreset(), defaultVoicePreset: c.voicePreset });
  });
  app.post('/api/companion', async (req: Request, res: Response) => {
    const { id, voicePreset } = req.body || {};
    try {
      if (typeof id === 'string') await services.companion.setActive(id);
      if (voicePreset === null || typeof voicePreset === 'string') await services.companion.setVoiceOverride(voicePreset);
      const c = services.companion.getActive();
      res.json({ ...c, voicePreset: services.companion.getVoicePreset(), defaultVoicePreset: c.voicePreset });
    } catch (err: any) {
      res.status(400).json({ error: String(err?.message || err) });
    }
  });
}
```
Register in `routes.ts` right after `registerChatStreamRoutes(ctx)`.

- [ ] **Step 5: Audio default voice.** In `audio.ts` `/api/audio/generate`, when `voice` is absent and `resolveVoiceForRequest` returns no explicit persona voice, use `services.companion.getVoicePreset()` as the voice (the TTS service already resolves preset ids to Edge voices via its preset lookup; pass the preset id). Keep persona override precedence: explicit voice > persona voice > companion preset.

- [ ] **Step 6:** `npm run check` → green (update the pipeline test fakes with `companion: { getActive: () => ({ id:'nib', name:'Nib', voicePreset:'narrator_warm', tagline:'t', image:'/mascots/nib.webp' }), getVoicePreset: () => 'narrator_warm' }` and `soul.getFullContextFor` if they fake soul). Smoke: start server (`AUTHORCLAW_NO_OPEN=1`), `curl -s localhost:3847/api/companion` → nib; `curl -s -X POST localhost:3847/api/companion -H 'Content-Type: application/json' -d '{"id":"quill"}'` → quill; chat once and confirm the reply introduces itself as Quill; set back to nib; kill your server.
- [ ] **Step 7: Commit** `P2: companion wired into prompt, soul template, audio default voice, and API`

## Task 3: Mascot image prep and app icons

**Files:** Create `scripts/prep-mascots.py`; regenerate `app/public/mascots/*.webp`; create `app/public/icons/icon-192.png`, `icon-512.png`; modify `app/public/manifest.webmanifest`, `app/index.html`

- [ ] **Step 1: Script**
```python
# scripts/prep-mascots.py — one-off: crop the baked caption, square, resize, write webp + icons.
import sys, pathlib
from PIL import Image
root = pathlib.Path(__file__).resolve().parents[1]
src_dir = root / 'app' / 'public' / 'mascots'
icons = root / 'app' / 'public' / 'icons'; icons.mkdir(exist_ok=True)
for p in sorted(src_dir.glob('*.webp')):
    im = Image.open(p).convert('RGB')
    w, h = im.size
    im = im.crop((0, 0, w, int(h * 0.90)))          # drop the caption strip
    side = min(im.size); l = (im.width - side) // 2; t = (im.height - side) // 2
    im = im.crop((l, t, l + side, t + side)).resize((512, 512), Image.LANCZOS)
    im.save(p, 'WEBP', quality=88, method=6)
    print('wrote', p.name, im.size)
nib = Image.open(src_dir / 'nib.webp').convert('RGBA')
for s in (192, 512):
    nib.resize((s, s), Image.LANCZOS).save(icons / f'icon-{s}.png')
print('icons written')
```
Run: `python -I scripts/prep-mascots.py` (install Pillow if missing: `python -m pip install pillow`). Expected: six `wrote … (512, 512)` lines and `icons written`; each webp now < 60 KB.

- [ ] **Step 2: Manifest + head.** `manifest.webmanifest` `icons`: `[{"src":"/icons/icon-192.png","sizes":"192x192","type":"image/png"},{"src":"/icons/icon-512.png","sizes":"512x512","type":"image/png"}]`. In `app/index.html` add `<link rel="icon" href="/icons/icon-192.png" />` and `<link rel="apple-touch-icon" href="/icons/icon-192.png" />`.
- [ ] **Step 3:** `npm run app:build` clean. Commit `P2: mascot images cropped to 512px; app icons from Nib`.

## Task 4: Transcribe service

**Files:** Create `gateway/src/services/transcribe.ts`, `gateway/src/services/transcribe.test.ts`

- [ ] **Step 1: Failing test**
```ts
// gateway/src/services/transcribe.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TranscribeService } from './transcribe.js';

const vault = { get: vi.fn(async (k: string) => (k === 'gemini_api_key' ? 'test-key' : null)) } as any;
afterEach(() => vi.restoreAllMocks());

describe('TranscribeService', () => {
  it('sends inline audio to Gemini and returns the text', async () => {
    const fetchMock = vi.fn(async (url: string, init: any) => {
      expect(url).toContain(':generateContent?key=test-key');
      const body = JSON.parse(init.body);
      expect(body.contents[0].parts[0].inlineData.mimeType).toBe('audio/ogg');
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: ' hello world ' }] } }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const svc = new TranscribeService(vault, { geminiModel: 'gemini-2.0-flash' });
    const out = await svc.transcribe(Buffer.from('abc'), 'audio/ogg');
    expect(out).toEqual({ text: 'hello world', provider: 'gemini' });
  });
  it('throws a clear error when no transcription provider is available', async () => {
    const noKey = { get: vi.fn(async () => null) } as any;
    const svc = new TranscribeService(noKey, { geminiModel: 'gemini-2.0-flash' });
    await expect(svc.transcribe(Buffer.from('abc'), 'audio/ogg')).rejects.toThrow(/no transcription provider/i);
  });
  it('rejects empty or oversized audio', async () => {
    const svc = new TranscribeService(vault, { geminiModel: 'gemini-2.0-flash' });
    await expect(svc.transcribe(Buffer.alloc(0), 'audio/ogg')).rejects.toThrow(/empty/i);
    await expect(svc.transcribe(Buffer.alloc(11 * 1024 * 1024), 'audio/ogg')).rejects.toThrow(/too large/i);
  });
});
```
- [ ] **Step 2:** run → FAIL (module not found).
- [ ] **Step 3: Implement**
```ts
// gateway/src/services/transcribe.ts
/**
 * Speech-to-text (spec P2 §2). Gemini audio understanding on the free tier by
 * default; local whisper.cpp when AUTHORAGENT_WHISPER_PATH points at the
 * `whisper-cli` binary (model path in AUTHORAGENT_WHISPER_MODEL).
 */
import { writeFile, readFile, unlink, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Vault } from '../security/vault.js';
import { logger } from './logger.js';

const execFileP = promisify(execFile);
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export interface TranscribeResult { text: string; provider: 'gemini' | 'whisper' }

export class TranscribeService {
  constructor(
    private vault: Pick<Vault, 'get'>,
    private opts: { geminiModel: string; geminiEndpoint?: string; whisperPath?: string; whisperModel?: string } = { geminiModel: 'gemini-2.0-flash' },
  ) {}

  async transcribe(audio: Buffer, mimeType: string): Promise<TranscribeResult> {
    if (!audio || audio.length === 0) throw new Error('Audio is empty');
    if (audio.length > MAX_AUDIO_BYTES) throw new Error(`Audio too large (max ${MAX_AUDIO_BYTES / 1024 / 1024} MB)`);
    const whisperPath = this.opts.whisperPath ?? process.env.AUTHORAGENT_WHISPER_PATH;
    if (whisperPath) {
      try { return await this.viaWhisper(audio, mimeType, whisperPath); }
      catch (err) { logger.warn('whisper transcription failed, trying Gemini', err); }
    }
    const key = await this.vault.get('gemini_api_key');
    if (key) return this.viaGemini(audio, mimeType, key);
    throw new Error('No transcription provider available. Add a free Gemini key or set AUTHORAGENT_WHISPER_PATH.');
  }

  private async viaGemini(audio: Buffer, mimeType: string, key: string): Promise<TranscribeResult> {
    const endpoint = this.opts.geminiEndpoint ?? 'https://generativelanguage.googleapis.com/v1beta';
    const res = await fetch(`${endpoint}/models/${this.opts.geminiModel}:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [
          { inlineData: { mimeType, data: audio.toString('base64') } },
          { text: 'Transcribe this audio verbatim. Return only the spoken words, no commentary, no timestamps.' },
        ] }],
        generationConfig: { temperature: 0 },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gemini transcription error ${res.status}: ${body.slice(0, 200)}`);
    }
    const data: any = await res.json();
    const text = (data?.candidates?.[0]?.content?.parts || []).map((p: any) => p?.text || '').join('').trim();
    if (!text) throw new Error('Gemini returned no transcript');
    return { text, provider: 'gemini' };
  }

  private async viaWhisper(audio: Buffer, mimeType: string, whisperPath: string): Promise<TranscribeResult> {
    const dir = await mkdtemp(join(tmpdir(), 'fibb-stt-'));
    const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('webm') ? 'webm' : mimeType.includes('wav') ? 'wav' : 'mp3';
    const inFile = join(dir, `in.${ext}`);
    const outBase = join(dir, 'out');
    try {
      await writeFile(inFile, audio);
      const args = ['-f', inFile, '-otxt', '-of', outBase, '-nt'];
      const model = this.opts.whisperModel ?? process.env.AUTHORAGENT_WHISPER_MODEL;
      if (model) args.unshift('-m', model);
      await execFileP(whisperPath, args, { timeout: 120_000 });
      const text = (await readFile(`${outBase}.txt`, 'utf-8')).trim();
      if (!text) throw new Error('whisper returned no transcript');
      return { text, provider: 'whisper' };
    } finally {
      for (const f of [inFile, `${outBase}.txt`]) { try { await unlink(f); } catch { /* ignore */ } }
    }
  }
}
```
- [ ] **Step 4:** test → 3 passed; tsc clean. **Step 5: Commit** `P2: TranscribeService (Gemini audio, optional whisper.cpp)`.

## Task 5: Transcribe route, container wiring

**Files:** Modify `gateway/src/api/routes/audio.ts`, `container.ts`, `index.ts`

- [ ] **Step 1:** Container: add `transcribe: TranscribeService` (interface, field, deps). In `index.ts` next to `companion`:
```ts
    this.transcribe = new TranscribeService(this.vault, { geminiModel: this.aiRouter.getProviderModel?.('gemini') ?? 'gemini-2.0-flash' });
```
If the router has no `getProviderModel`, read the gemini provider's `.model` via `getProviderModelInfo()` (find the entry with `id === 'gemini'`), falling back to `'gemini-2.0-flash'`.
- [ ] **Step 2:** Route in `audio.ts` (import `upload` from `../context.js`):
```ts
  app.post('/api/audio/transcribe', upload.single('audio'), async (req: Request, res: Response) => {
    const file = (req as any).file as { buffer: Buffer; mimetype: string; size: number } | undefined;
    if (!file?.buffer?.length) return res.status(400).json({ error: 'audio file required (multipart field "audio")' });
    if (file.size > 10 * 1024 * 1024) return res.status(413).json({ error: 'Audio too large (max 10 MB)' });
    try {
      const out = await services.transcribe.transcribe(file.buffer, file.mimetype || 'audio/webm');
      res.json(out);
    } catch (err: any) {
      const msg = String(err?.message || err);
      res.status(msg.includes('No transcription provider') ? 503 : 500).json({ error: msg });
    }
  });
```
Confirm `upload` uses memory storage (check `context.ts`); if it uses disk storage, read `file.path` into a Buffer and unlink it.
- [ ] **Step 3:** `npm run check` green; smoke: `curl -s -F "audio=@/dev/null;type=audio/ogg" localhost:3847/api/audio/transcribe` → 400. Commit `P2: POST /api/audio/transcribe`.

## Task 6: Telegram voice notes in, voice replies, grouped /voice

**Files:** Modify `gateway/src/bridges/telegram.ts`, `gateway/src/index.ts` (wiring of a transcribe callback)

- [ ] **Step 1:** Add to the bridge a `setTranscriber(fn: (audio: Buffer, mime: string) => Promise<string>)` and `setCompanionVoice(fn: () => string)` and store them. In `index.ts` where the bridge is constructed, call both: `this.telegram.setTranscriber((b, m) => this.transcribe.transcribe(b, m).then(r => r.text))` and `this.telegram.setCompanionVoice(() => this.companion.getVoicePreset())`.
- [ ] **Step 2:** In `poll()`, replace `if (!message?.text) continue;` with:
```ts
        if (!message) continue;
        if (!message.text && !message.voice && !message.audio) continue;
```
and after the allow-list check, before `handleInput`:
```ts
        if (message.voice || message.audio) {
          await this.handleVoiceNote(chatId, message.voice ?? message.audio, userName);
          continue;
        }
```
- [ ] **Step 3:** Add:
```ts
  private async handleVoiceNote(chatId: number, media: { file_id: string; mime_type?: string; duration?: number }, userName: string): Promise<void> {
    if (!this.transcriber) { await this.sendMessage(chatId, 'I can hear you, but speech-to-text is not set up yet. Add a free Gemini key in Settings → Connections.'); return; }
    if ((media.duration ?? 0) > 180) { await this.sendMessage(chatId, 'That voice note is over 3 minutes. Send a shorter one and I will transcribe it.'); return; }
    await this.sendChatAction(chatId, 'typing');
    try {
      const meta = await fetch(`https://api.telegram.org/bot${this.token}/getFile?file_id=${encodeURIComponent(media.file_id)}`).then(r => r.json()) as any;
      const path = meta?.result?.file_path;
      if (!path) throw new Error('getFile returned no path');
      const buf = Buffer.from(await (await fetch(`https://api.telegram.org/file/bot${this.token}/${path}`)).arrayBuffer());
      const text = await this.transcriber(buf, media.mime_type || 'audio/ogg');
      this.voiceTurn.add(chatId);
      await this.handleInput(chatId, text, userName);
    } catch (err) {
      await this.sendMessage(chatId, 'I could not transcribe that voice note. Try again or type it out.');
    } finally {
      this.voiceTurn.delete(chatId);
    }
  }
```
with fields `private transcriber: ((a: Buffer, m: string) => Promise<string>) | null = null; private companionVoice: (() => string) | null = null; private voiceTurn = new Set<number>();`.
- [ ] **Step 4:** In the regular-message respond callback, change the voice condition to `if (this.voiceMode.has(chatId) || this.voiceTurn.has(chatId))` and compute the preset as `const preset = this.voiceMode.get(chatId); const voice = typeof preset === 'string' ? preset : (this.companionVoice?.() ?? undefined);` passing `voice` to `generateAndSendVoice`. Also prefix the AI input for voice turns with `[voice note] ` so the model knows the user spoke.
- [ ] **Step 5:** `/voice` help: list presets grouped by gender from `TTSService.VOICE_PRESETS` (import the class, not an instance): "Female: narrator_female, narrator_warm, british_female, curious_kid · Male: narrator_male, narrator_deep, british_male, storyteller, snarky_nerd". Replace the hard-coded list.
- [ ] **Step 6:** `npm run check` green (tsc is the guard; no bridge tests exist). Commit `P2: Telegram voice notes transcribed; voice replies for voice turns; grouped /voice presets`.

## Task 7: App — API client, voice helper, Markdown deps

**Files:** Modify `app/package.json`, `app/src/lib/api.ts`; Create `app/src/lib/voice.ts`

- [ ] **Step 1:** `cd app && npm i marked dompurify && npm i -D @types/dompurify` (marked ≥ 12 ships types).
- [ ] **Step 2:** Append to `api.ts`:
```ts
export interface Companion { id: string; name: string; voicePreset: string; tagline: string; image: string; defaultVoicePreset?: string }
export async function getCompanions(): Promise<{ companions: Companion[]; activeId: string }> {
  const r = await fetch('/api/companions'); return r.ok ? r.json() : { companions: [], activeId: 'nib' };
}
export async function getCompanion(): Promise<Companion | null> {
  const r = await fetch('/api/companion'); return r.ok ? r.json() : null;
}
export async function setCompanion(body: { id?: string; voicePreset?: string | null }): Promise<Companion | null> {
  const r = await fetch('/api/companion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.ok ? r.json() : null;
}
export interface VoicePreset { id: string; voice: string; description: string; gender: 'Male' | 'Female' }
export async function getVoices(): Promise<{ presets: VoicePreset[] }> {
  const r = await fetch('/api/audio/voices'); return r.ok ? r.json() : { presets: [] };
}
export async function speak(text: string, voice?: string): Promise<string | null> {
  const r = await fetch('/api/audio/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text.slice(0, 8000), ...(voice ? { voice } : {}) }) });
  if (!r.ok) return null;
  const j = await r.json();
  return j.url || (j.filename ? `/api/audio/file/${j.filename}` : null);
}
export async function transcribe(blob: Blob): Promise<string> {
  const fd = new FormData(); fd.append('audio', blob, 'note.webm');
  const r = await fetch('/api/audio/transcribe', { method: 'POST', body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j.text || '';
}
export async function getVaultKeys(): Promise<string[]> {
  const r = await fetch('/api/vault/keys'); if (!r.ok) return []; return (await r.json()).keys || [];
}
export async function saveVaultKey(key: string, value: string): Promise<{ ok: boolean; warning?: string }> {
  const r = await fetch('/api/vault', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value }) });
  const j = await r.json().catch(() => ({})); return { ok: r.ok, warning: j.warning };
}
export async function deleteVaultKey(key: string): Promise<boolean> {
  const r = await fetch(`/api/vault/${encodeURIComponent(key)}`, { method: 'DELETE' }); return r.ok;
}
export async function refreshProviders(): Promise<Array<{ id: string; name: string; model: string; tier: string }>> {
  const r = await fetch('/api/providers/refresh', { method: 'POST' }); if (!r.ok) return []; return (await r.json()).providers || [];
}
export async function getModels(): Promise<any[]> {
  const r = await fetch('/api/models'); if (!r.ok) return []; return (await r.json()).providers || [];
}
export async function setModel(provider: string, model: string): Promise<boolean> {
  const r = await fetch('/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, model }) }); return r.ok;
}
```
Check whether the `/api/audio/generate` response exposes `url` or `filename` (read `tts.ts` `generate` return and `audio.ts`); make `speak()` match exactly.

- [ ] **Step 3: `voice.ts`**
```ts
// app/src/lib/voice.ts — mic capture (Web Speech first, MediaRecorder fallback) and spoken-reply playback.
import { transcribe } from './api';

type SR = typeof window extends { SpeechRecognition: infer T } ? T : any;
const getSR = (): any => (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;

export interface Listener { stop: () => void }

/** Start listening. onInterim gets live partial text; onFinal gets the transcript when the user stops. */
export function startListening(onInterim: (t: string) => void, onFinal: (t: string) => void, onError: (m: string) => void): Listener {
  const SRCtor = getSR();
  if (SRCtor) {
    const rec = new SRCtor(); rec.continuous = true; rec.interimResults = true; rec.lang = navigator.language || 'en-US';
    let finalText = '';
    rec.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t + ' '; else interim += t;
      }
      onInterim((finalText + interim).trim());
    };
    rec.onerror = (e: any) => { if (e.error !== 'aborted') onError(e.error || 'speech error'); };
    rec.onend = () => onFinal(finalText.trim());
    rec.start();
    return { stop: () => { try { rec.stop(); } catch { /* ignore */ } } };
  }
  // Fallback: record and upload.
  let recorder: MediaRecorder | null = null; const chunks: Blob[] = [];
  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      try { onFinal(await transcribe(new Blob(chunks, { type: 'audio/webm' }))); } catch (err: any) { onError(err.message || 'transcription failed'); onFinal(''); }
    };
    recorder.start(); onInterim('Listening…');
  }).catch(err => onError(err.message || 'microphone unavailable'));
  return { stop: () => { try { recorder?.stop(); } catch { /* ignore */ } } };
}

export function micSupported(): boolean { return !!getSR() || !!navigator.mediaDevices?.getUserMedia; }

/** Plays one audio URL at a time; resolves when playback ends. */
let current: HTMLAudioElement | null = null;
export function playUrl(url: string): Promise<void> {
  return new Promise(resolve => {
    stopPlayback();
    const a = new Audio(url); current = a;
    a.onended = () => { if (current === a) current = null; resolve(); };
    a.onerror = () => { if (current === a) current = null; resolve(); };
    a.play().catch(() => resolve());
  });
}
export function stopPlayback(): void { if (current) { try { current.pause(); } catch { /* ignore */ } current = null; } }
```
- [ ] **Step 4:** `npm run app:build` clean. Commit `P2(app): API helpers for companions/voice/vault; voice capture + playback helper; marked + dompurify`.

## Task 8: App — Markdown messages, mic, read-aloud, hands-free, companion-aware chat

**Files:** Modify `app/src/components/{Message,Composer,ChatView}.tsx`; Create `app/src/components/VoiceControls.tsx`; Modify `app/src/styles/app.css`

- [ ] **Step 1: Message.tsx** (safe Markdown for assistant text; plain for user):
```tsx
import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

export interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string; streaming?: boolean }
marked.setOptions({ breaks: true, gfm: true });

export function Message({ m, onRead }: { m: ChatMessage; onRead?: (text: string) => void }) {
  if (m.role === 'user') return <div className="msg me"><div className="b">{m.content}</div></div>;
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(m.content || '') as string, { USE_PROFILES: { html: true } }), [m.content]);
  return (
    <div className={`msg fibb${m.streaming ? ' streaming' : ''}`}>
      <div className="m" aria-hidden />
      <div className="b">
        <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
        {!m.streaming && m.content && onRead && (
          <button className="read" onClick={() => onRead(m.content)} aria-label="Read aloud" title="Read aloud">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>
          </button>
        )}
      </div>
    </div>
  );
}
```
(The HTML is sanitized by DOMPurify before insertion; this is the one permitted use of `dangerouslySetInnerHTML`.) CSS: `.md p{margin:0 0 .6em}.md p:last-child{margin:0}.md ul,.md ol{margin:.3em 0 .6em 1.2em;padding:0}.md h1,.md h2,.md h3{font-size:1em;margin:.6em 0 .3em}.md code{background:var(--surface-3);padding:.1em .35em;border-radius:5px;font-size:.9em}.md pre{background:var(--surface-3);padding:10px;border-radius:9px;overflow:auto}.md blockquote{border-left:2px solid var(--amber);margin:.4em 0;padding-left:10px;color:var(--text-2);font-family:var(--serif);font-style:italic} .msg.fibb .b{position:relative} .read{position:absolute;right:8px;bottom:-14px;width:26px;height:26px;border-radius:50%;background:var(--surface);border:1px solid var(--line);color:var(--text-3);display:grid;place-items:center;opacity:0;transition:opacity .15s} .read svg{width:14px;height:14px} .msg.fibb:hover .read{opacity:1} @media (hover:none){.read{opacity:1}}`.

- [ ] **Step 2: Composer.tsx** — add a mic button (real now) left of send, with `listening` and `interim` props:
```tsx
import { useRef, useState } from 'react';
export function Composer({ onSend, disabled, listening, onMic, interim, micAvailable }: {
  onSend: (text: string) => void; disabled: boolean; listening: boolean; onMic: () => void; interim: string; micAvailable: boolean;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const submit = () => { const t = text.trim(); if (!t || disabled) return; onSend(t); setText(''); if (ref.current) ref.current.style.height = 'auto'; };
  const shown = listening && interim ? interim : text;
  return (
    <div className={`composer${listening ? ' listening' : ''}`}>
      <textarea ref={ref} rows={1} placeholder={listening ? 'Listening… tap the mic to finish' : 'Talk to your companion…'} value={shown} disabled={disabled || listening}
        onChange={e => { setText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'; }}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }} aria-label="Message" />
      {micAvailable && (
        <button className={`cbtn mic${listening ? ' on' : ''}`} onClick={onMic} aria-pressed={listening} aria-label={listening ? 'Stop listening' : 'Speak'} title={listening ? 'Stop' : 'Speak'}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v4"/></svg>
        </button>
      )}
      <button className="cbtn send" onClick={submit} disabled={disabled || listening || !text.trim()} aria-label="Send" title="Send (Enter)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>
      </button>
    </div>
  );
}
```
CSS: `.cbtn.send{background:var(--amber);color:var(--amber-ink)} .cbtn.send:disabled{opacity:.4} .cbtn.mic{background:var(--surface-3);color:var(--text)} .cbtn.mic.on{background:var(--red);color:#fff;animation:pulse 1.2s ease-in-out infinite} @keyframes pulse{50%{box-shadow:0 0 0 6px rgba(224,108,108,.25)}} .composer.listening{border-color:var(--red)}`.

- [ ] **Step 3: VoiceControls.tsx** (two toggles in the header):
```tsx
export function VoiceControls({ readAloud, handsFree, onReadAloud, onHandsFree, micAvailable }: {
  readAloud: boolean; handsFree: boolean; onReadAloud: () => void; onHandsFree: () => void; micAvailable: boolean;
}) {
  return (
    <>
      <button className={`pill${readAloud ? ' on' : ''}`} onClick={onReadAloud} aria-pressed={readAloud} title="Speak every reply">Read aloud</button>
      {micAvailable && <button className={`pill${handsFree ? ' on' : ''}`} onClick={onHandsFree} aria-pressed={handsFree} title="After a spoken reply, listen again automatically">Hands-free</button>}
    </>
  );
}
```
- [ ] **Step 4: ChatView.tsx** — add voice state and companion name. New props: `companionName: string; readAloud: boolean; handsFree: boolean; voicePreset?: string`. Changes:
  - Greeting uses the name: `` `Hi, I'm ${companionName}. I'm your writing partner inside Fibb: I keep your book straight, draft when you want me to, and work on it while you sleep. What's your name, and what are you working on?` `` (compute at render for the `greet` message id so a companion change re-labels the greeting).
  - State: `const [listening, setListening] = useState(false); const [interim, setInterim] = useState(''); const listenerRef = useRef<Listener | null>(null);`
  - `const toggleMic = () => { if (listening) { listenerRef.current?.stop(); return; } stopPlayback(); setListening(true); setInterim(''); listenerRef.current = startListening(setInterim, (final) => { setListening(false); setInterim(''); listenerRef.current = null; if (final.trim()) send(final.trim(), true); }, (msg) => { setListening(false); setInterim(''); setMsgs(m => [...m, { id: crypto.randomUUID(), role: 'assistant', content: `Mic problem: ${msg}` }]); }); };`
  - `send(text, spoken = false)`: after the `done` event, `if ((readAloud || spoken) && acc) { const url = await speak(acc, voicePreset); if (url) { await playUrl(url); if (handsFree && spoken) toggleMic(); } }` (place this after the loop in the `try`, before `finally`).
  - `onRead` for messages: `(t) => speak(t, voicePreset).then(u => u && playUrl(u))`.
  - Pass to `Composer`: `listening`, `interim`, `onMic={toggleMic}`, `micAvailable={micSupported()}`.
  - Unmount cleanup: `useEffect(() => () => { listenerRef.current?.stop(); stopPlayback(); }, [])`.
  - Chips after first turn: add `'Read that back to me'` which calls `onRead` on the last assistant message instead of sending.
- [ ] **Step 5:** `npm run app:build` clean. Commit `P2(app): Markdown replies, mic, read-aloud, hands-free, companion-aware greeting`.

## Task 9: App — companion picker, mascot avatar, Settings view (Connections + Voice + Companion), empty states, Tonight sheet

**Files:** Create `app/src/components/{CompanionPicker,MascotAvatar,SettingsView,EmptyState,TonightSheet}.tsx`; Modify `App.tsx`, `TonightPanel.tsx`, `FirstRunCard.tsx`, `Rail.tsx` (no change needed unless icons), `styles/app.css`

- [ ] **Step 1: MascotAvatar.tsx**
```tsx
import type { Companion } from '../lib/api';
export function MascotAvatar({ c, state = 'idle', size = 116 }: { c: Companion | null; state?: 'idle' | 'thinking' | 'listening'; size?: number }) {
  return (
    <div className={`mascot ${state}`} style={{ height: size }}>
      {c ? <img src={c.image} alt={`${c.name}, ${c.tagline}`} className="mascot-img" draggable={false} /> : <div className="blob" aria-hidden><span className="e l" /><span className="e r" /><span className="g" /></div>}
      <span className="cap-txt">{c ? `${c.name} · ${state === 'thinking' ? 'thinking' : state === 'listening' ? 'listening' : 'awake'}` : 'Fibb'}</span>
    </div>
  );
}
```
CSS: `.mascot-img{height:84%;width:auto;border-radius:50%;object-fit:cover;background:#fff;box-shadow:0 6px 18px rgba(0,0,0,.25);transition:transform .3s} .mascot.thinking .mascot-img{animation:breathe 1.6s ease-in-out infinite} .mascot.listening .mascot-img{transform:scale(1.05)} @keyframes breathe{50%{transform:translateY(-3px) scale(1.02)}}`.

- [ ] **Step 2: CompanionPicker.tsx**
```tsx
import { useEffect, useState } from 'react';
import { getCompanions, setCompanion, type Companion } from '../lib/api';
export function CompanionPicker({ onPicked, compact = false }: { onPicked: (c: Companion) => void; compact?: boolean }) {
  const [list, setList] = useState<Companion[]>([]); const [active, setActive] = useState('nib'); const [busy, setBusy] = useState(false);
  useEffect(() => { getCompanions().then(r => { setList(r.companions); setActive(r.activeId); }); }, []);
  return (
    <div className={`picker${compact ? ' compact' : ''}`} role="radiogroup" aria-label="Choose your companion">
      {list.map(c => (
        <button key={c.id} role="radio" aria-checked={active === c.id} className={`pick${active === c.id ? ' on' : ''}`} disabled={busy}
          onClick={async () => { setBusy(true); const r = await setCompanion({ id: c.id }); setBusy(false); if (r) { setActive(r.id); onPicked(r); } }}>
          <img src={c.image} alt="" draggable={false} />
          <div className="pick-name">{c.name}</div>
          {!compact && <div className="pick-tag">{c.tagline}</div>}
        </button>
      ))}
    </div>
  );
}
```
CSS: `.picker{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-top:12px} .pick{background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius);padding:14px 10px;display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center} .pick img{width:96px;height:96px;border-radius:50%;background:#fff;object-fit:cover} .pick.on{border-color:var(--amber);box-shadow:0 0 0 3px var(--amber-dim)} .pick-name{font-weight:600} .pick-tag{font-size:12px;color:var(--text-2)} .picker.compact .pick img{width:56px;height:56px}`.

- [ ] **Step 3: EmptyState.tsx**
```tsx
export function EmptyState({ title, text, action, onAction }: { title: string; text: string; action?: string; onAction?: () => void }) {
  return (
    <div className="thread"><div className="thread-inner"><div className="card empty">
      <div className="t">{title}</div><div className="s">{text}</div>
      {action && onAction && <div className="act"><button className="btn pri" onClick={onAction}>{action}</button></div>}
    </div></div></div>
  );
}
```
- [ ] **Step 4: SettingsView.tsx** — three sections. Connections rows from a static table:
```tsx
const SLOTS = [
  { key: 'gemini_api_key', label: 'Google Gemini', free: true, hint: 'Free tier; powers chat, memory, and voice notes', url: 'https://aistudio.google.com/app/apikey' },
  { key: 'deepseek_api_key', label: 'DeepSeek', free: false, hint: 'Cheap, strong drafting', url: 'https://platform.deepseek.com/' },
  { key: 'openrouter_api_key', label: 'OpenRouter', free: false, hint: 'One key, many models', url: 'https://openrouter.ai/keys' },
  { key: 'openai_api_key', label: 'OpenAI', free: false, hint: 'Premium', url: 'https://platform.openai.com/api-keys' },
  { key: 'anthropic_api_key', label: 'Anthropic Claude', free: false, hint: 'Premium editing and judging', url: 'https://console.anthropic.com/' },
  { key: 'elevenlabs_api_key', label: 'ElevenLabs', free: false, hint: 'Audiobook-grade voices (Edge voices are free and built in)', url: 'https://elevenlabs.io/' },
  { key: 'telegram_bot_token', label: 'Telegram bot', free: true, hint: 'Talk to your companion from your phone', url: 'https://core.telegram.org/bots#botfather' },
];
```
Component behavior: load `getVaultKeys()` → status per slot (`connected` if key present). Each row: label + free/paid badge + hint link, status dot, `<input type="password" placeholder={connected ? '•••••••• (stored)' : 'Paste key'} />`, Save (calls `saveVaultKey`, shows warning if returned, refreshes list), Remove (confirm via `window.confirm`, then `deleteVaultKey`), and a top "Test connections" button that calls `refreshProviders()` and lists which came online. A **Free, no key needed** block above lists Ollama (status from `getModels()` having an `ollama` entry marked available if that info exists, else "detected at start"), Edge voices (always on), Web Speech (`micSupported()`). A **Models** block: for each provider from `getModels()`, a `<select>`/text input to call `setModel`. **Voice** section: `getVoices()` presets grouped by gender with a radio per preset, "Preview" (speak("Hi, I'm {name}. Let's write something today.", preset) → playUrl), and "Use companion default" which calls `setCompanion({ voicePreset: null })`; choosing a preset calls `setCompanion({ voicePreset: id })`. **Companion** section: `<CompanionPicker />`. Check the exact vault slot name Telegram uses (`grep -n "telegram" gateway/src/index.ts gateway/src/api/routes/system.ts | grep -i vault`) and use it.
  Never render a stored key value; the UI only knows names.
- [ ] **Step 5: TonightSheet.tsx** (mobile): a chip-triggered bottom sheet rendering the same `TonightPanel` content; CSS `.sheet{position:fixed;inset:auto 0 0 0;max-height:80vh;background:var(--surface);border-top-left-radius:18px;border-top-right-radius:18px;box-shadow:var(--shadow);overflow:auto;z-index:20}.sheet-scrim{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:19}`; shown only under 900px via a "Tonight" chip in the chips row.
- [ ] **Step 6: App.tsx** — load companion on mount and after Settings changes; header title stays "Fibb" with a secondary `· {companion.name}`; `readAloud`/`handsFree` state (persist in localStorage `fibb_voice`); render `VoiceControls` in the header right; `view === 'settings'` renders `SettingsView`; `books/ideas/review` render `EmptyState` with texts: Books — "No books yet" / "Tell your companion what you're writing and it will keep the bible, the chapters, and the goal here." / action "Start in chat" → setView('chat'); Ideas — "Nothing captured yet" / "Say 'idea: …' in chat and it lands here." ; Review — "Nothing to review" / "Overnight work will wait here for your yes.". First run: if `GET /api/facts` has no `name` AND localStorage `fibb_onboarded` is unset, show `CompanionPicker` in a card above the greeting (ChatView prop `onboarding`), set `fibb_onboarded=1` after a pick. `TonightPanel` receives `companion` and `state` (thinking while ChatView is busy — lift `busy` via an `onBusy` callback).
- [ ] **Step 7:** `npm run app:build` clean. Commit `P2(app): companion picker, mascot avatar, Settings (Connections/Voice/Companion), empty states, Tonight sheet`.

## Task 10: Preview verification (controller, browser pane)

- [ ] Start with `preview_start {name:"fibb"}` (`.claude/launch.json` exists locally). Check: `/api/companion` → nib; header shows "· Nib"; Tonight panel shows the Nib image; first-run picker appears when facts has no name (temporarily `DELETE /api/facts?phrase=Chris` is NOT allowed — instead test the picker from Settings). Switch to Quill in Settings → header updates, chat greeting re-labels, send "who are you?" → reply introduces itself as Quill. Toggle Read aloud → send a message → `/api/audio/generate` 200 and an `<audio>` plays (check `read_network_requests` for `/api/audio/file/`). Mic: if the pane lacks mic permission, verify `micSupported()` gating hides nothing wrongly and that the fallback path posts to `/api/audio/transcribe` (use `curl -F` with a small wav to prove the route; a 503 without Gemini key is acceptable and must say so). Connections: list shows stored key NAMES only (never values), Test button returns providers. Markdown: a reply with `**bold**` and a list renders without raw asterisks. Mobile 375px: Tonight chip opens the sheet; composer has mic + send. Reset companion to Nib. Console: no errors except known stale ones. Light + dark screenshots or DOM checks.
- [ ] `npm run check` + `npm run app:build` green; push `fibb-p2`.

## Self-review
- Spec §1 → T1, T2, T3, T9. §2 → T4, T5, T6, T7, T8. §3 → T9 (SettingsView). §4 → T8 (Markdown, read button), T9 (avatar states, empty states, sheet). Verification → T10.
- Types: `Companion {id,name,voicePreset,tagline,image}` identical in `companion.ts` and `api.ts`; `getVoicePreset()` is the single source for the spoken voice (gateway audio route and Telegram); `startListening(onInterim,onFinal,onError) → {stop}`; `speak(text, voice?) → url|null`; `playUrl(url) → Promise<void>`.
- Plan risk flagged for the executor: the `/api/audio/generate` response field for the file URL must be confirmed before Task 7 (`url` vs `filename`).
