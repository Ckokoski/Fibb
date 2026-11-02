# Fibb P3 — One Identity, Premium-Minimal Restyle, Human Voices

**Date:** 2026-11-01 · **Status:** approved in conversation ("Yes do all of that") · **Extends:** P2 spec

## 1. One identity: Fibb

The assistant is always **Fibb**. The companion characters become **looks** (avatar + default voice), never names. Nib is Fibb's face and the only look with expression states. The other five remain available under Settings → Appearance as alternate looks (single still each). The onboarding picker is removed; first run shows Nib.

Expression states (Nib, transparent SVG, `app/public/mascots/nib/`): `idle`, `thinking` (while a reply streams), `listening` (mic open), `celebrating` (streak day gained, word milestone, or a reply that contains a celebration cue). States crossfade over 200 ms; `thinking` adds a slow breathe; `listening` a gentle lean; `celebrating` a short bounce then returns to idle after 4 s.

Prompt: `You are Fibb, …` (SOUL `{{name}}` → Fibb). History, facts, Telegram and the app all say Fibb.

## 2. Premium-minimal layout and restyle

Reference points: Muse, Dot, Linear. Principles: one column, generous whitespace, almost no boxes, one accent, quiet type.

**Desktop layout**
- Rail (64 px) stays: Chat, Books, Ideas, Review, Settings, with a small Fibb glyph on top.
- Main column, max 720 px, centered. At the top: the **hero**: Nib at 120 px, centered, with a one-line status under it (`Fibb · awake`, `listening…`, `thinking…`, `celebrating`) and, when known, a second muted line: `The Iron Throne · ch. 10 · 14-day streak`.
- Conversation below the hero. Assistant messages have **no bubble**: plain text on the page with a 2-px accent hairline on the left and 16 px serif-ish body? No: keep Inter at 16 px / 1.6 line height; serif only for quoted manuscript lines. User messages are soft pills right-aligned, accent background, 15 px.
- Composer: a single rounded field with mic and send inside, floating with a soft shadow, 8 px above the bottom; chips above it as quiet text buttons.
- The old right panel is gone. **Tonight** becomes a drawer from the right, opened by a header icon; it holds streak, goal, queue, schedules (same `TonightBody`).
- Header: wordmark `Fibb` left with the Beta pill; right side is icon buttons only (Read aloud, Hands-free, Tonight, Theme) with tooltips. No "Legacy" link in the header; it moves to Settings → Advanced.

**Tokens**
- Keep Night Desk palette; soften surfaces: `--surface-2` used only for user pills and the composer; borders mostly replaced by spacing. Shadows: one soft `0 8px 30px rgba(0,0,0,.18)` for floating elements.
- Type scale: 16 body, 15 user pill, 13 meta, 12 labels; headings in Settings 18/600. Letter-spacing on uppercase labels .08em.
- Motion: 160–220 ms ease-out everywhere; respect `prefers-reduced-motion`.

**Mobile (< 900 px)**: rail becomes the bottom bar; hero shrinks to 64 px and sits in the header row; the Tonight drawer becomes the existing sheet; composer sticks to the bottom with safe-area padding.

## 3. Human voices

Add two TTS providers beside Edge and ElevenLabs:

- **Kokoro (local, free, no key).** `kokoro-js`, model `onnx-community/Kokoro-82M-v1.0-ONNX`, dtype `q8` (~92 MB), device `cpu`, cached under `workspace/.models/` (set the transformers.js cache dir). Lazy-loaded on first use; Settings offers an explicit **Download** button with progress, and shows "Ready" once cached. Voices exposed (28 English; curated six first): `af_heart` (Heart, warm American female, **default**), `af_bella`, `af_nicole`, `am_michael` (Michael, American male), `am_adam`, `bf_emma` (Emma, British female), `bm_george` (George, British male), `bm_fable`. Generation runs in-process; long texts are split into sentences and concatenated; a 20,000-char cap per request.
- **Gemini TTS (cloud, uses the existing Gemini key).** Interactions API `POST https://generativelanguage.googleapis.com/v1beta/interactions`, model `gemini-3.8-flash-tts`, `response_format: {type:'audio'}` (WAV 24 kHz), `generation_config.speech_config: [{voice}]`, key via `x-goog-api-key`. Curated voices: Kore, Aoede, Leda (female); Puck, Charon, Fenrir (male). Free-tier quotas are tight and unverified; the UI labels it "free tier, limited" and falls back to Kokoro or Edge on 429.
- Voice ids are namespaced: `edge:<preset>`, `kokoro:<voice>`, `gemini:<Voice>`, `elevenlabs:<voice_id>`. Un-prefixed legacy ids resolve as Edge presets. The "companion default" voice becomes `kokoro:af_heart` when Kokoro is ready, else the Edge preset.
- Settings → Voice: provider cards (Edge: free, online · Kokoro: free, local, download once · Gemini: free tier, your key · ElevenLabs: paid) with status, a voice list for the selected provider grouped Female/Male, Preview, and "Use as Fibb's voice". Read-aloud and Telegram both use the chosen voice.

## 4. Out of scope (P4)

Night shift, goals/ideas views, connectors, computer use, proactive observations.
