# Fibb P3 Implementation Plan — One Identity, Restyle, Human Voices

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fibb speaks and looks like one character (Nib with expression states), the app reads as premium-minimal on desktop and mobile, and replies can be spoken by human-sounding free voices (Kokoro locally, Gemini TTS in the cloud).

**Architecture:** `CompanionService` becomes an appearance service with a fixed name "Fibb" and an optional per-look `states` map. `TTSService` gains two providers behind namespaced voice ids and a small voice catalog; Kokoro loads lazily and caches under `workspace/.models`. The app replaces the three-column shell with a centered column, a top hero (`Hero.tsx`) driven by a single `mascotState`, a Tonight drawer, icon header controls, and restyled tokens; Settings gets provider cards and an Appearance section.

**Tech Stack:** TypeScript on tsx (NodeNext), Express, vitest; `kokoro-js` (+ its `@huggingface/transformers` dependency), `node-edge-tts`; app: Vite + React 18 + TS, `marked`, `dompurify`.

**Spec:** `docs/superpowers/specs/2026-11-01-fibb-p3-identity-restyle-voices.md`. Branch `fibb-p3` from main 20c7cf8.

**Conventions:** as P1/P2 (`.js` imports, tests beside source, `npm run check` + `npm run app:build` green before each commit, commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`, never POST to vault routes in tests, never kill processes you did not start).

**Existing facts:** `CompanionService` (`gateway/src/services/companion.ts`): `COMPANIONS` table `{id,name,voicePreset,tagline,image}`, `getActive()`, `getVoicePreset()`, `setActive`, `setVoiceOverride(preset|null)` validated against `TTSService.VOICE_PRESETS`; routes `GET /api/companions`, `GET/POST /api/companion`; pipeline identity line uses `companion.name`; `soul.getFullContextFor(name)`. `TTSService` (`tts.ts`): `VOICE_PRESETS` (9 Edge), `resolveVoice(input)`, `detectProviderForVoice`, `generate(text,{voice,provider,...}) → {success,file,filename,format,size,duration,provider}`, `generateEdge`, `generateElevenLabs`, `listPresets()`, config persisted under `workspace/.config`. Routes in `audio.ts`: `/api/audio/generate|voices|config|file/:filename|transcribe`. App: `App.tsx` (shell grid 64/1fr/320, header pills, `TonightPanel`, `TonightSheet`, `SettingsView`, `CompanionPicker`, `MascotAvatar`, `ChatView` with `onBusy/onListening`, `voice.ts`, `api.ts`).

---

## Task 1: Gateway identity — Fibb only, looks with states

**Files:** Modify `gateway/src/services/companion.ts`, `companion.test.ts`, `gateway/src/api/routes/companion.ts`, `gateway/src/services/message-pipeline.ts`, `workspace/soul/SOUL.md`

- [ ] **Step 1: Tests first.** In `companion.test.ts` change the expectations: `getActive().name` is always `'Fibb'` for every look; `getActive().look` is the id (`'nib'`); `COMPANIONS.nib.states` equals `{ idle:'/mascots/nib/nib-idle.svg', thinking:'/mascots/nib/nib-thinking.svg', listening:'/mascots/nib/nib-listening.svg', celebrating:'/mascots/nib/nib-celebrating.svg' }` and other looks have no `states`. Add a test that `imageFor('thinking')` returns the thinking SVG for nib and the single `image` for quill. Run → RED.
- [ ] **Step 2: Implement.** In `companion.ts`:
  - `export interface Companion { id: string; look: string; name: 'Fibb'; voicePreset: string; tagline: string; image: string; states?: Record<'idle'|'thinking'|'listening'|'celebrating', string> }`.
  - Every table row gets `look: <id>`, `name: 'Fibb'`; `nib` gets `states` as above; taglines become look descriptions (keep text).
  - Add `imageFor(state: 'idle'|'thinking'|'listening'|'celebrating'): string { const c = this.getActive(); return c.states?.[state] ?? c.image; }`.
  - Default voice preset for nib becomes `'kokoro:af_heart'` ONLY after Task 2 lands; for now keep `narrator_warm` (Task 2 changes it).
- [ ] **Step 3: Pipeline.** Identity line becomes: `` `You are Fibb, the author's writing partner. You are a small ink-drop character at the author's desk; never claim another name.\n\n` `` (no tagline, no companion name variable). `soul.getFullContextFor('Fibb')`. Update any pipeline test fake that asserts the old line.
- [ ] **Step 4: SOUL.md**: replace `{{name}}` occurrences with `Fibb` (the template stays harmless but the text should read naturally). Keep `getFullContextFor` for compatibility.
- [ ] **Step 5: Routes.** `GET /api/companion` now returns `{ name:'Fibb', look, image, states?, voicePreset, defaultVoicePreset, tagline }`. `POST /api/companion { look?: string, voicePreset?: string|null }` (accept legacy `id` as alias of `look`).
- [ ] **Step 6:** `npm run check` green. Commit `P3: one identity (Fibb) — companions become looks; Nib expression states`.

## Task 2: TTS providers — Kokoro and Gemini, namespaced voice catalog

**Files:** Modify `gateway/src/services/tts.ts`; Create `gateway/src/services/tts-catalog.ts` + `tts-catalog.test.ts`, `gateway/src/services/tts-kokoro.ts`, `gateway/src/services/tts-gemini.ts` + `tts-gemini.test.ts`; Modify `gateway/src/api/routes/audio.ts`, `companion.ts` (default voice), `package.json`

- [ ] **Step 1: Catalog (pure, tested).**
```ts
// gateway/src/services/tts-catalog.ts
export type TTSProvider = 'edge' | 'kokoro' | 'gemini' | 'elevenlabs';
export interface CatalogVoice { id: string; provider: TTSProvider; label: string; gender: 'Female' | 'Male'; accent: string; note?: string }
export const KOKORO_VOICES: CatalogVoice[] = [
  { id: 'kokoro:af_heart', provider: 'kokoro', label: 'Heart', gender: 'Female', accent: 'American', note: 'warm, clear — Fibb’s default' },
  { id: 'kokoro:af_bella', provider: 'kokoro', label: 'Bella', gender: 'Female', accent: 'American' },
  { id: 'kokoro:af_nicole', provider: 'kokoro', label: 'Nicole', gender: 'Female', accent: 'American', note: 'soft, intimate' },
  { id: 'kokoro:bf_emma', provider: 'kokoro', label: 'Emma', gender: 'Female', accent: 'British' },
  { id: 'kokoro:am_michael', provider: 'kokoro', label: 'Michael', gender: 'Male', accent: 'American' },
  { id: 'kokoro:am_adam', provider: 'kokoro', label: 'Adam', gender: 'Male', accent: 'American' },
  { id: 'kokoro:bm_george', provider: 'kokoro', label: 'George', gender: 'Male', accent: 'British' },
  { id: 'kokoro:bm_fable', provider: 'kokoro', label: 'Fable', gender: 'Male', accent: 'British' },
];
export const GEMINI_VOICES: CatalogVoice[] = [
  { id: 'gemini:Kore', provider: 'gemini', label: 'Kore', gender: 'Female', accent: 'Neutral', note: 'assertive' },
  { id: 'gemini:Aoede', provider: 'gemini', label: 'Aoede', gender: 'Female', accent: 'Neutral', note: 'airy' },
  { id: 'gemini:Leda', provider: 'gemini', label: 'Leda', gender: 'Female', accent: 'Neutral', note: 'youthful' },
  { id: 'gemini:Puck', provider: 'gemini', label: 'Puck', gender: 'Male', accent: 'Neutral', note: 'energetic' },
  { id: 'gemini:Charon', provider: 'gemini', label: 'Charon', gender: 'Male', accent: 'Neutral', note: 'explanatory' },
  { id: 'gemini:Fenrir', provider: 'gemini', label: 'Fenrir', gender: 'Male', accent: 'Neutral', note: 'enthusiastic' },
];
/** Parse a namespaced voice id. Un-prefixed ids are Edge presets (legacy). */
export function parseVoiceId(id: string): { provider: TTSProvider; voice: string } {
  const m = /^(edge|kokoro|gemini|elevenlabs):(.+)$/.exec(id.trim());
  if (m) return { provider: m[1] as TTSProvider, voice: m[2] };
  if (/^[A-Za-z0-9]{18,24}$/.test(id) && !id.includes('-') && !id.includes('_')) return { provider: 'elevenlabs', voice: id };
  return { provider: 'edge', voice: id };
}
export function isKnownVoice(id: string): boolean {
  const p = parseVoiceId(id);
  if (p.provider === 'kokoro') return KOKORO_VOICES.some(v => v.id === `kokoro:${p.voice}`);
  if (p.provider === 'gemini') return GEMINI_VOICES.some(v => v.id === `gemini:${p.voice}`);
  return true; // edge presets/raw ids and elevenlabs ids are validated elsewhere
}
```
Tests: `parseVoiceId('kokoro:af_heart')`, `('narrator_warm')` → edge, `('gemini:Kore')`, `('21m00Tcm4TlvDq8ikWAM')` → elevenlabs; `isKnownVoice('kokoro:zz')` false.

- [ ] **Step 2: Kokoro adapter.** `npm i kokoro-js`. Create `tts-kokoro.ts`:
```ts
import { join } from 'path';
import { mkdir } from 'fs/promises';
import { logger } from './logger.js';
export class KokoroEngine {
  private tts: any | null = null; private loading: Promise<any> | null = null;
  private progress: { status: 'idle'|'downloading'|'ready'|'error'; percent?: number; error?: string } = { status: 'idle' };
  constructor(private modelsDir: string, private modelId = 'onnx-community/Kokoro-82M-v1.0-ONNX', private dtype: 'q8'|'fp16'|'fp32' = 'q8') {}
  getStatus() { return this.progress; }
  async load(): Promise<any> {
    if (this.tts) return this.tts;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      await mkdir(this.modelsDir, { recursive: true });
      const { KokoroTTS } = await import('kokoro-js');
      const hf: any = await import('@huggingface/transformers');
      hf.env.cacheDir = this.modelsDir; hf.env.allowLocalModels = true;
      this.progress = { status: 'downloading', percent: 0 };
      const tts = await KokoroTTS.from_pretrained(this.modelId, {
        dtype: this.dtype, device: 'cpu',
        progress_callback: (p: any) => { if (p?.status === 'progress' && typeof p.progress === 'number') this.progress = { status: 'downloading', percent: Math.round(p.progress) }; },
      });
      this.progress = { status: 'ready', percent: 100 };
      this.tts = tts; return tts;
    })().catch(err => { this.progress = { status: 'error', error: String(err?.message || err) }; this.loading = null; throw err; });
    return this.loading;
  }
  /** Returns 24 kHz mono WAV bytes. */
  async synthesize(text: string, voice: string): Promise<Buffer> {
    const tts = await this.load();
    const audio = await tts.generate(text, { voice });
    const wav = audio.toWav ? audio.toWav() : audio.toBlob ? Buffer.from(await (await audio.toBlob()).arrayBuffer()) : null;
    if (!wav) throw new Error('kokoro-js returned no WAV encoder');
    return Buffer.isBuffer(wav) ? wav : Buffer.from(wav);
  }
}
```
Read `node_modules/kokoro-js` type definitions to confirm the audio object's WAV method name (`toWav()` returns an ArrayBuffer in recent versions; `save()` writes a file) and `progress_callback` support; adapt. If `@huggingface/transformers` is not a direct dependency, import it from `kokoro-js`'s dependency via `createRequire` or add it as a direct dependency with the same version kokoro-js uses.

- [ ] **Step 3: Gemini adapter (tested with fake fetch).**
```ts
// gateway/src/services/tts-gemini.ts
export async function geminiSynthesize(apiKey: string, text: string, voice: string, model = 'gemini-3.8-flash-tts', fetchFn: typeof fetch = fetch): Promise<Buffer> {
  const res = await fetchFn('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      model,
      input: [{ type: 'user_input', content: [{ type: 'text', text }] }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice }] },
    }),
  });
  if (res.status === 429) throw Object.assign(new Error('Gemini TTS rate limit reached'), { code: 'RATE_LIMIT' });
  if (!res.ok) throw new Error(`Gemini TTS failed (HTTP ${res.status})`);
  const data: any = await res.json();
  const steps: any[] = data?.steps || [];
  let b64: string | undefined;
  for (const s of steps) for (const c of (s?.content || [])) if (c?.type === 'audio' && typeof c.data === 'string') b64 = c.data;
  if (!b64 && typeof data?.output_audio?.data === 'string') b64 = data.output_audio.data;
  if (!b64) throw new Error('Gemini TTS returned no audio');
  return Buffer.from(b64, 'base64');
}
```
Test: fake fetch asserting header `x-goog-api-key`, body model/voice, returns `{steps:[{content:[{type:'audio',data: base64('RIFF....')}]}]}` → buffer starts with `RIFF`; 429 → error code `RATE_LIMIT`; no audio → throws.

- [ ] **Step 4: Wire into `TTSService`.** Extend `TTSProviderId` to `'edge'|'kokoro'|'gemini'|'elevenlabs'`. Constructor takes `workspaceDir` (already) → `this.kokoro = new KokoroEngine(join(workspaceDir, '.models'))`. In `generate`: `const parsed = parseVoiceId(options.voice ?? this.getActiveVoice())`; dispatch: kokoro → `this.kokoro.synthesize(text, parsed.voice)` write `.wav` into `audioDir` as `tts-<hash>.wav`, return `{success:true, file, filename, format:'wav', size, provider:'kokoro'}`; gemini → `geminiSynthesize(await vault.get('gemini_api_key'), text, parsed.voice)`; on `RATE_LIMIT` fall back to kokoro if `kokoro.getStatus().status==='ready'` else to Edge preset `narrator_warm`; edge/elevenlabs unchanged (edge receives `parsed.voice` resolved through `VOICE_PRESETS`). Add `listCatalog(): { provider, label, available, voices: CatalogVoice[] }[]` where available: edge true; kokoro `status==='ready'` (plus `status` field); gemini `!!await vault.get('gemini_api_key')`; elevenlabs `!!await vault.get('elevenlabs_api_key')`. Edge presets are exposed in the catalog as `edge:<preset>` entries built from `VOICE_PRESETS`. Keep `setVoice/getActiveVoice` storing namespaced ids; `resolveVoice` understands prefixes. Text cap for kokoro/gemini: 20,000 chars; split kokoro input into sentences of ≤ 400 chars and concatenate WAVs (strip the 44-byte header from all but the first, fix RIFF sizes) — implement `concatWav(buffers)` in `tts-catalog.ts` with a test.
- [ ] **Step 5: Routes (`audio.ts`).** `GET /api/audio/voices` now returns `{ activeVoice, catalog: await tts.listCatalog(), kokoro: tts.kokoroStatus() }`. `POST /api/audio/kokoro/install` → kicks off `kokoro.load()` (no await) and returns `{status}`; `GET /api/audio/kokoro/status` → status. `POST /api/audio/config { voice }` accepts namespaced ids (validate with `isKnownVoice`). `/api/audio/generate` unchanged signature; falls back as above.
- [ ] **Step 6: Default voice.** In `companion.ts` the nib row gets `voicePreset: 'kokoro:af_heart'` and `getVoicePreset()` returns the Edge fallback `narrator_warm` when Kokoro is not ready: give `CompanionService` an optional `isVoiceAvailable: (id) => boolean` injected from index.ts (`id => services.tts.isVoiceReadySync(id)`), and have `getVoicePreset()` return `override ?? (isVoiceAvailable(companion.voicePreset) ? companion.voicePreset : 'narrator_warm')`. `isVoiceReadySync` on TTSService: edge → true; kokoro → status ready; gemini/elevenlabs → cached key presence (refresh on `reinitialize`/vault write; simplest: check `vault.has` synchronously if it exists, else cache a boolean refreshed in `initialize()` and in the vault POST route).
- [ ] **Step 7:** `npm run check` green; smoke (own server, `AUTHORCLAW_NO_OPEN=1`): `POST /api/audio/kokoro/install`, poll status until ready (download ~92 MB, allow up to 5 min), then `POST /api/audio/generate {text:"Hello Chris, this is Fibb.", voice:"kokoro:af_heart"}` → `format:'wav'`, size > 20 KB; `voice:"gemini:Kore"` → 200 or a clear 429/503 with fallback noted. Commit `P3: Kokoro (local) and Gemini TTS providers; namespaced voice catalog; Fibb default voice`.

## Task 3: App — centered layout, hero with states, Tonight drawer, restyle

**Files:** Create `app/src/components/Hero.tsx`, `app/src/components/TonightDrawer.tsx`, `app/src/components/IconButton.tsx`; Modify `App.tsx`, `ChatView.tsx`, `Message.tsx`, `Composer.tsx`, `Rail.tsx`, `TonightPanel.tsx` (export `TonightBody` only), `MascotAvatar.tsx` (delete or reduce to `Hero`), `styles/tokens.css`, `styles/app.css`, `lib/api.ts` (`Companion` type gains `look`, `states?`)

- [ ] **Step 1: State model.** In `App.tsx`: `type MascotState = 'idle'|'thinking'|'listening'|'celebrating'`; derive: listening if `listening`, else thinking if `busy`, else celebrating if `celebrateUntil > Date.now()`, else idle. `celebrateUntil` is set (4 s) when: writing stats `currentStreakDays` increases vs the previous poll, or the last assistant message matches `/\b(congrat|well done|nice work|🎉|streak)\b/i` (cheap heuristic, documented).
- [ ] **Step 2: Hero.tsx**
```tsx
import type { Companion } from '../lib/api';
export function Hero({ c, state, line2 }: { c: Companion | null; state: 'idle'|'thinking'|'listening'|'celebrating'; line2?: string }) {
  const src = c?.states?.[state] ?? c?.image ?? '/mascots/nib/nib-idle.svg';
  const status = state === 'thinking' ? 'thinking…' : state === 'listening' ? 'listening…' : state === 'celebrating' ? 'celebrating' : 'awake';
  return (
    <div className={`hero ${state}`} aria-live="polite">
      <div className="hero-img-wrap">
        {(['idle','thinking','listening','celebrating'] as const).map(s => (
          <img key={s} src={c?.states?.[s] ?? c?.image ?? '/mascots/nib/nib-idle.svg'} alt={s === state ? `Fibb, ${status}` : ''} className={`hero-img${s === state ? ' on' : ''}`} draggable={false} aria-hidden={s !== state} />
        ))}
      </div>
      <div className="hero-status">Fibb <span className="dot">·</span> {status}</div>
      {line2 && <div className="hero-line2">{line2}</div>}
    </div>
  );
}
```
(All four images stay mounted and crossfade via opacity so switching is instant.) When the look has no `states`, the same `image` is used for all four and nothing flickers.
- [ ] **Step 3: Layout + CSS.** `.shell{display:grid;grid-template-columns:64px 1fr}` (no third column). `.main{max-width:720px;margin:0 auto;width:100%}` inside a full-width wrapper so the header spans the page. Hero: `.hero{display:flex;flex-direction:column;align-items:center;padding:28px 0 8px}.hero-img-wrap{position:relative;width:120px;height:120px}.hero-img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;opacity:0;transition:opacity .2s ease-out}.hero-img.on{opacity:1}.hero.thinking .hero-img.on{animation:breathe 2.4s ease-in-out infinite}.hero.listening .hero-img.on{transform:translateY(-2px) scale(1.04)}.hero.celebrating .hero-img.on{animation:bounce .6s ease-out}.hero-status{margin-top:10px;font-size:13px;color:var(--text-2)}.hero-line2{font-size:12px;color:var(--text-3);margin-top:2px}` + `@media (prefers-reduced-motion: reduce){.hero-img{transition:none}.hero .hero-img.on{animation:none;transform:none}}`.
  Messages: `.msg.fibb .b{background:none;border:0;padding:4px 0 4px 14px;border-left:2px solid var(--amber-dim)}` and `.msg.fibb .m{display:none}` (the hero is the avatar now); `.msg{font-size:16px;line-height:1.6;max-width:100%}`; `.msg.me .b{font-size:15px;padding:10px 14px;border-radius:18px 18px 4px 18px}`. Composer floats: `.composer{box-shadow:var(--shadow);border-color:transparent;background:var(--surface-2)}`. Chips: `.chip{border:0;background:transparent;color:var(--text-3)} .chip:hover{color:var(--text)}`. Header: `.topbar{border-bottom:0;height:60px}` and right side uses `IconButton`s (24 px icons, 36 px hit area, `title` + `aria-label`, `aria-pressed` for toggles).
  Tokens: body 16 px; `--shadow: 0 8px 30px rgba(0,0,0,.18)`; `--line` lighter in dark (`#262932`). Light theme: `--amber` stays `#9a5f0c`.
- [ ] **Step 4: TonightDrawer.tsx**: right-side drawer (`position:fixed;top:0;right:0;bottom:0;width:340px;transform:translateX(100%);transition:transform .22s`), `.open{transform:none}`, scrim, Escape closes, focus moves to the drawer heading on open and back to the trigger on close; renders `TonightBody`. Under 900 px, `App` renders `TonightSheet` instead (existing).
- [ ] **Step 5: Rail**: top glyph becomes the Nib idle SVG at 28 px; icons unchanged; active state uses `--amber-dim` background only (no border).
- [ ] **Step 6: App.tsx**: remove `TonightPanel` aside and `MascotAvatar`; render `<Hero c={companion} state={mascotState} line2={line2} />` above `ChatView` in the main column (also above the other views, smaller: pass a `compact` prop that renders 56 px when `view !== 'chat'`). Header right: `IconButton`s for Read aloud (speaker), Hands-free (waveform), Tonight (moon), Theme (sun/moon/auto). Remove the Legacy link (moved to Settings → Advanced in Task 4). Mobile: `.hero{padding:12px 0 0}.hero-img-wrap{width:64px;height:64px}`.
- [ ] **Step 7:** `npm run app:build` clean. Commit `P3(app): centered layout, Nib hero with expression states, Tonight drawer, premium-minimal restyle`.

## Task 4: App — Settings (Voice providers, Appearance, Advanced), onboarding without picker

**Files:** Modify `SettingsView.tsx`, `CompanionPicker.tsx` (→ `LookPicker`, compact, no names shown as identities: label is the look name as a *look*, e.g. "Nib (default)", "Quill"), `ChatView.tsx` (remove onboarding picker and companion-name greeting → "Hi, I'm Fibb…"), `lib/api.ts` (voices/catalog/kokoro helpers), `styles/app.css`

- [ ] **Step 1: api.ts**: `getVoiceCatalog(): Promise<{activeVoice:string; catalog: Array<{provider:string; label:string; available:boolean; status?:any; voices: Array<{id,label,gender,accent,note?}>}>; kokoro:{status:string; percent?:number; error?:string}}>`, `installKokoro()`, `kokoroStatus()`, `setActiveVoice(id)` (POST `/api/audio/config`), `setLook(look)` (POST `/api/companion {look}`), `setVoiceOverride(id|null)`.
- [ ] **Step 2: Voice section**: four provider cards in a row (wrap on mobile): Edge "Free · online", Kokoro "Free · runs on your PC" with a Download button and progress bar (poll status every 1.5 s while downloading; show "Ready" when done; error inline), Gemini "Free tier · uses your Gemini key" (disabled with hint when no key), ElevenLabs "Paid" (disabled without key). Selecting a card lists its voices grouped Female / Male as radio rows with Preview (speaks "Hi, I'm Fibb. Let's write something today." with that id) and the active one marked. "Use as Fibb's voice" sets both `setActiveVoice(id)` and `setVoiceOverride(id)`. A "Reset to default" link clears the override.
- [ ] **Step 3: Appearance section**: `LookPicker` grid of the six looks (Nib first, labelled "Nib · default"); copy under the heading: "Fibb is always Fibb. Pick the look you like." Selecting posts `look`.
- [ ] **Step 4: Advanced section**: link to `/legacy/` ("Previous dashboard") and the `AUTHORAGENT_WHISPER_PATH` note.
- [ ] **Step 5: ChatView**: greeting `"Hi, I'm Fibb. I keep your book straight, draft when you ask, and work on it while you sleep. What's your name, and what are you working on?"`; remove the onboarding picker and `fibb_onboarded` logic; composer placeholder "Talk to Fibb…".
- [ ] **Step 6:** `npm run app:build` clean; root `npm run check` green. Commit `P3(app): voice provider cards with Kokoro download, Appearance looks, Advanced; Fibb-only greeting`.

## Task 5: Controller verification (browser pane)

- [ ] Start `fibb`; confirm hero top-center with Nib idle at 120 px; send a message → state `thinking` during stream (breathe class present) then back to idle; toggle Read aloud → spoken reply plays; open Tonight drawer (focus lands in drawer, Escape closes); Settings → Voice: Kokoro card shows Download → click → progress → Ready (allow minutes); choose `kokoro:af_heart` → Preview plays a WAV (`/api/audio/file/*.wav` 200); Gemini card state matches key presence; Appearance: switch look to Quill → hero image changes, header still says Fibb, reply still says Fibb; switch back to Nib. Mobile 375 px: hero 64 px, bottom bar, Tonight sheet via icon. Light + dark DOM checks. Console clean. Reset voice override. Push `fibb-p3`.

## Self-review
- Spec §1 → T1 (+ T3 hero states, T4 greeting/looks). §2 → T3 (+ T4 Advanced/legacy move). §3 → T2 (+ T4 UI). Verification → T5.
- Types: `Companion{id,look,name:'Fibb',voicePreset,tagline,image,states?}` identical in `companion.ts` and `api.ts`; voice ids namespaced everywhere (`parseVoiceId` is the single parser; `isKnownVoice` the single validator used by `setVoiceOverride` and `/api/audio/config`); `MascotState` union shared by `Hero` and `App`.
- Risk flagged: kokoro-js API surface (`toWav`, `progress_callback`, transformers cache env) must be confirmed against the installed package before Task 2 Step 2 code is trusted; Gemini TTS free-tier quota unverified → fallback path is mandatory.
