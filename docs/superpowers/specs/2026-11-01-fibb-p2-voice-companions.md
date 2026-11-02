# Fibb P2 — Companions, Voice, Connections, Polish

**Date:** 2026-11-01 · **Status:** approved in conversation (Chris: "go ahead") · **Extends:** `2026-10-04-fibb-design.md` §4, §11, §13

## 1. Companions (mascot = picture + name + default voice)

Fibb is the product. The **companion** is who the author talks to. Six companions ship, from Chris's art in `app/public/mascots/`:

| id | name | voice preset (Edge, free) | tagline |
|---|---|---|---|
| nib | Nib | `narrator_warm` (Jenny) | the ink drop who never forgets a thread |
| fable | Fable | `storyteller` (Andrew) | a small dragon who guards your book |
| folio | Folio | `british_female` (Sonia) | pages for ears, tidy to a fault |
| mote | Mote | `curious_kid` (Ana) | a moth drawn to a bright idea |
| quill | Quill | `british_male` (Ryan) | a hedgehog made of pens |
| pip | Pip | `narrator_female` (Aria) | the sprout, small and relentless |

**Default: Nib.** The user picks in first run and in Settings; the pick persists at `workspace/.config/companion.json` and is exposed by `GET/POST /api/companion`, `GET /api/companions`. The system prompt opens with `You are {name}, …` (SOUL.md is templated on `{{name}}`), the app header and greeting use the name, the Tonight panel shows the image, and voice replies default to the companion's preset unless the user overrides the voice. Facts memory stores `companion` so Telegram and the app agree.

Images: 1254px with a baked caption in the bottom ~8%; a script crops and resizes to 512px (`scripts/prep-mascots.py`, run once, output committed). Manifest icons use Nib at 192/512 PNG.

## 2. Voice, both surfaces, both directions

- **Speech-to-text:** `services/transcribe.ts`. Gemini audio (`generateContent` with inline audio, free tier) by default; local whisper.cpp when `AUTHORAGENT_WHISPER_PATH` is set. `POST /api/audio/transcribe` (multipart `audio`, ≤ 10 MB, 60 s guard) returns `{text}`. In the browser, Web Speech API is used first when present (free, no upload); the server route is the fallback.
- **Telegram in/out:** `message.voice` → `getFile` → download → transcribe → pipeline with `[voice note]` tag. A voice-note turn is answered in voice (companion preset or `/voice <preset>`), plus text. `/voice` lists the presets grouped Male / Female.
- **Desktop:** mic button (tap to talk, tap to stop; shows a live interim transcript), **Read aloud** toggle (every reply spoken via `/api/audio/generate` with the companion voice), per-message "Read" button for any assistant message (and later any manuscript text), and **Hands-free** mode: when a spoken reply finishes playing, the mic reopens automatically until the user stops. Voice picker in Settings → Voice with Male / Female groups and a 5-second preview.
- All free by default (Edge TTS, Web Speech, Gemini free tier). ElevenLabs remains optional for audiobook-grade output.

## 3. Connections (secure, easy credentials)

Settings → Connections lists every provider in two groups: **Free, no key needed** (Ollama local, Edge voices, Web Speech) and **Bring your key** (Gemini free tier, DeepSeek, OpenRouter, OpenAI, Anthropic, ElevenLabs, Telegram bot token). Each row: status dot (connected / not set / error), masked input that never echoes a stored value, Save, Remove, and Test (runs `POST /api/providers/refresh` and reports which providers came online). Keys go to the existing AES-256-GCM vault; the UI only ever receives key *names* (`GET /api/vault/keys`). A short "where to get this" link per provider. Model dropdown per provider from `GET/POST /api/models`.

## 4. Polish

- Assistant messages render Markdown safely (bold, italics, lists, headings, code) with sanitization; user messages stay plain.
- Tonight panel on mobile becomes a bottom sheet opened by a "Tonight" chip.
- Books / Ideas / Review placeholders become proper empty states with one sentence and one action each.
- Companion image replaces the CSS blob; mascot has idle/thinking states (subtle CSS: thinking = gentle pulse while a reply streams).
- Header shows companion name; "Beta" pill stays.

## 5. Out of scope for P2 (next)

Night shift / schedules / goals / ideas (P3). Google Drive/Docs/Gmail/Calendar, computer use, teachable skills UI, proactive "I noticed" suggestions, social media automation (P4). Observing how the author works and suggesting optimizations is P4 work on top of the facts memory and activity log.
