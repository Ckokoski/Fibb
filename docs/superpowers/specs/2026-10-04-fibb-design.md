# Fibb — Design Spec

**Date:** 2026-10-04
**Status:** Approved in conversation; awaiting final read of this document
**Supersedes:** AuthorAgent "Conductor's Studio" dashboard and its feature-cockpit model

## 1. Why

AuthorAgent has 50k lines, 255 endpoints, 443 passing tests, and zero real use. Chris uses Muse every day because it is easy, convenient, free, helpful, and talks. Fibb is that experience, built for authors: a writing partner that knows your book, works on it while you sleep, handles the admin around being an author, and talks to you like a friend.

Priorities, in order: looks great, feels great to use, fun, super helpful. Everything below serves those four.

## 2. Shape

One brain, two faces.

- **Brain:** the existing gateway (`gateway/src`), evolved in place. Memory tiers, project engine, quality engine, skills loader, AI router, vault, and tests are kept.
- **Phone face:** Telegram (already wired). Voice notes in, voice or text out, morning brief, proactive nudges.
- **Desktop face:** a new app in `app/` (Vite + React + token CSS), served by the gateway at `/`, installable as a PWA. The old dashboard moves to `/legacy` until the new app covers it, then is deleted.

Fibb is general-purpose for an author's life (admin, research, email triage, agent hunting, scheduling) with deep superpowers for the craft (ideas, outline, draft, book bible, consistency, edit, format).

## 3. Conversation core

**Streaming.** `aiRouter.complete` gains a streaming variant for every provider (Ollama `stream:true`, Gemini/OpenAI/Anthropic/DeepSeek/OpenRouter SSE). The message pipeline emits chunks over the existing Socket.IO `message` channel. Telegram sends a typing action, then edits one message as chunks arrive (throttled to ~1 edit/sec), falling back to chunked sends for replies over 4k chars.

**Persistent history.** Per-channel conversation history is written to `workspace/memory/conversations/` (already exists as a JSONL log) and rehydrated on boot. The in-memory 40-message cap stays as the context window; history on disk is unbounded.

**Facts memory.** New `services/facts.ts`. After each user turn, a free-tier call extracts durable facts into `workspace/memory/facts.json`:

```json
{ "name": "Chris", "pronouns": null,
  "books": [{ "title": "The Iron Throne", "stage": "drafting", "chapter": 10, "goal": "finish draft by Dec 1" }],
  "people": [{ "name": "Mara", "kind": "character", "book": "The Iron Throne", "notes": "can't swim (ch3)" }],
  "preferences": ["prefers morning briefs at 7am", "hates adverbs"],
  "recent": ["2026-10-03: stuck on ferry scene"] }
```

Facts are injected at the top of every system prompt, ahead of book-bible memory, with a 1,500-char budget. The user can say "forget that" and Fibb removes the fact. This is the single change that makes Fibb feel like it knows you; it is distinct from the existing user-model (behavioral stats) and preferences (regex-detected style rules).

**Prompt diet.** The hardcoded Capabilities / Author OS / Project System / Security blocks in `buildSystemPrompt` are removed from chat turns. `SOUL.md` is rewritten for Fibb's voice (section 10). `memory.getRelevant` caches book-bible reads instead of re-reading every file per turn.

## 4. Voice

- **Telegram in:** `message.voice` handled in the poll loop. Audio fetched via `getFile`, transcribed by `services/transcribe.ts` (Gemini audio on the free tier; local whisper.cpp when `AUTHORAGENT_WHISPER_PATH` is set). Transcript enters the pipeline like typed text, tagged `inputMode: "voice"`.
- **Telegram out:** reply is spoken (existing `tts.ts`, Edge voices, no key) when the user spoke, or when `/voice on`. Text always sent too. The `dramatic` preset is either added to `VOICE_PRESETS` or removed from the command list.
- **Desktop in:** mic button in the composer. Web Speech API when available; otherwise `MediaRecorder` → `POST /api/audio/transcribe`.
- **Desktop out:** "read replies aloud" toggle, calls the existing `/api/audio/generate` per reply and plays inline. Duplicate `/api/audio/voices` registration removed.

## 5. Tasks, schedules, and the night shift

**Task model** (`services/tasks.ts`, stored in `workspace/tasks.json`):

```ts
type Task = { id; title; kind: "draft"|"revise"|"research"|"audit"|"admin"|"custom";
  source: "user"|"goal"|"fibb"; book?; status: "queued"|"running"|"review"|"done"|"declined";
  schedule?: CronExpr; budgetUsd?; result?: { summary; files[]; cost } }
```

Three sources:
1. **User:** "tonight, draft chapter 11", "every Monday, summarize my inbox", "remind me Friday to query three agents". Natural language → task, confirmed in one line.
2. **Goal-derived:** each book has a goal (e.g. "finish draft by Dec 1"). Fibb derives the next step: draft next chapter, continuity pass on the last three, resolve open research questions, update the bible.
3. **Fibb-proposed:** from facts, goals, inbox, and calendar: "I noticed your agent-query deadline is Friday and you have no synopsis. Want me to draft one tonight?" Proposals wait for a yes.

**Schedules.** Any task can carry a cron expression. The existing `cron-scheduler.ts` runs them. Users manage schedules in chat ("change my brief to 6:30") and in the app's Tonight panel. Defaults: morning brief daily, inbox triage daily if Gmail is connected, bible refresh weekly.

**Night shift** (`services/night-shift.ts`). A window (default 23:00–06:00, configurable; also runs when the user has been idle for 2h if enabled). Picks queued tasks in priority order, executes through the existing step executor and quality services, writes results to the Review inbox. Rules:
- Never publishes, sends, or posts externally. Drafts only.
- Per-night cost cap (default $2; free tier first per routing policy).
- A failed task is logged and reported in the brief, not retried more than once.
- Manuscript files are never overwritten; results are new files or suggested diffs.

## 6. Proactivity and celebration

- **Morning brief** (Telegram, scheduled): what Fibb did overnight, what wants review, one question about the current scene, one celebration if earned. Under 120 words. Never sent in quiet hours.
- **Nudges** (max 2/day, user-tunable): "You wrote 1,400 words yesterday, that's a 9-day streak." "Chapter 12 contradicts chapter 3: Mara can't swim." Plot holes come from the existing contradiction detector, phrased as a question.
- **Celebrations:** streaks, word milestones, finished drafts, first query sent. Short and specific. The mascot's celebrate state plays in the app.
- **Gentle mentions:** at most once a week, only when relevant, Fibb may mention Chris's Bestseller Trends tool (when the user is choosing a premise), his YouTube channel (when they ask craft questions it covers), or Ko-Fi (never unprompted; only when the user asks how to support the project). Implemented as a `mentions` policy with a per-item cooldown so it can be tuned or disabled.

## 7. Manuscript sync

- **Watched folder:** `services/manuscript-watch.ts` watches a configured folder (OneDrive is fine) for `.docx`/`.md`/`.txt`. Changed files are parsed (existing docx tooling), split into chapters, and ingested into the project and memory tiers. Word counts and streaks update from real writing, not only agent output.
- **Google Docs:** via the Google connector (section 8). A book can point at a Drive folder; Fibb pulls changed docs on the same cadence.
- Fibb never writes into the author's live file. Edits are proposed as new files or tracked-changes exports (existing `track-changes.ts`).

## 8. Connectors and capabilities

**MCP client** (`services/mcp-client.ts`, config in `config/mcp.json`). First release: Google Drive/Docs/Gmail/Calendar, Notion, Obsidian (local vault folder, no server needed), web search/fetch with citations. Gmail and Calendar are read and draft only; sending requires explicit confirmation per message.

**Email triage:** daily or on request, Fibb reads the inbox, pulls out author-relevant mail (agents, editors, readers, newsletter replies, KDP/ACX notices), summarizes, drafts replies to review. Everything else is left alone.

**Browser control and desktop files:** behind a capability switch per source, off by default. Browser: a headless session Fibb can drive for research and form-filling, every navigation logged, no credentials typed. Files: a user-approved allowlist of folders. Both reuse the existing confirmation gate; the gate prompt appears in chat and in the app.

**Teachable skills:** "Fibb, learn this: every Friday pull my KDP sales and tell me the trend." Fibb writes a `SKILL.md` draft (existing skill-drafts route), shows it, and activates it on approval. Skills remain prompt-text plus optional tool allowances.

**Fibb as MCP server:** `gateway/src/mcp-server.ts` exposes `chat`, `queue_task`, `get_brief`, `search_manuscript`, `check_continuity`, so Claude or ChatGPT can delegate to Fibb.

**Models:** existing router keeps every provider (Ollama local, Gemini, DeepSeek, Claude, OpenAI, OpenRouter). Routing policy stays cost-efficient: free tier for chat, transcription, extraction, and audits; premium only for final prose and judging. Model choice is a setting.

## 9. Security

Existing: vault, path sandbox, injection detector, audit log, localhost bind, confirmation gate. Added for Fibb:

- **Untrusted-content boundary.** Anything fetched from the web, email, or a connector is wrapped as data with a visible marker before it enters a prompt, and instruction-like text inside it is flagged. Fibb never acts on instructions found in fetched content; it quotes them and asks.
- **Capability scopes.** Browser, files, connectors, and sending are separate switches with their own audit entries.
- **Night shift sandbox.** Overnight tasks cannot use send, post, purchase, or delete capabilities regardless of switches.
- **Prompt-injection tests** for the email and web paths join the vitest suite.

## 10. Personality

Warm writing buddy. First-name basis, curious, celebrates small wins, honest about problems, kind about it. One good question at a time. Matches energy: loose when the user is loose, focused when they are in deep work. Never a yes-machine, never a ghostwriter that hides its work, never judgmental about genre. `SOUL.md` is rewritten to this, shorter than today's, and the facts memory makes the "remembers you" promise real.

## 11. Desktop app

**Stack:** `app/` folder, Vite + React + TypeScript, CSS custom properties (no Tailwind), Inter for UI and a serif (Source Serif) for manuscript text. Built output served by the gateway. PWA manifest and service worker so it installs on desktop and phone.

**Look: Night Desk.** Charcoal surfaces, warm amber accent, generous spacing, soft shadows, 12px radii. Dark by default, light variant via `prefers-color-scheme` and a toggle. No gradients, no glassmorphism, no emoji-as-icons.

**Layout:** slim left rail (Chat, Books, Review, Settings), conversation centered with a max line length, right panel "Tonight" showing the queue, schedules, streak, and the mascot. Under 900px the rail becomes a bottom tab bar and the Tonight panel becomes a sheet.

**Views:**
- **Chat (home):** streaming messages, mic, attach, read-aloud toggle, quick chips ("Check chapter 10", "What's on tonight?", "Brainstorm a premise"). History persists.
- **Books:** each book as a card with stage, goal, progress; opens to chapters with inline Check and Revise actions and a readable chapter view.
- **Review:** the inbox of overnight results; accept, discard, or discuss each one in chat.
- **Settings:** connections (keys and connectors), capabilities (browser, files, sending), schedules, voice, appearance.

**Mascot:** four states (idle, thinking, working overnight, celebrating) as PNG/SVG, generated by Chris from the brief in Appendix A. Shown in the Tonight panel, the empty states, and the morning brief in the app.

## 12. Cleanup and rename

- Archive branch `archive/wave3-marketing` receives: `ams-ads`, `bookbub-submitter`, `launch-orchestrator`, `release-calendar`, `disclosures`, `reader-feedback`, `reader-intel`, `blog-post-drafter`, `website-*`, `video-research`, `translation-pipeline`, `audiobook-prep`, `sleep-consolidation`, `skill-curator`, `auto-skill`, `orchestrator`, the Wave 3 and website route modules, and the ops/marketing skills except `blurb-writer`. Delete `bestseller-trends.ts` (dead placeholder); the Bestseller mention policy in section 6 replaces it.
- Remove `better-sqlite3` and `dotenv` (unused); move `@types/multer` to devDependencies.
- Rename user-facing strings AuthorAgent → Fibb. Keep `AUTHORCLAW_*`/`AUTHORAGENT_*` env vars, the vault key path, and localStorage keys for compatibility.
- Fix stale docs (QUICKSTART panels, LAUNCH-GUIDE vault key, ROADMAP stray shell commands).

## 13. First run

`npm start` opens the browser automatically. If no provider is reachable, the chat shows one card: "Paste a free Gemini key or install Ollama" with a link, and the key input is right there. First message from Fibb asks for your name and what you're working on, which seeds the facts memory. No wizard.

## 14. Testing

- vitest for every new service: facts extraction, task parsing, night-shift selection and caps, transcribe adapter, manuscript-watch chapter splitting, mention cooldowns, untrusted-content wrapping.
- Prompt-injection regression tests for email and web paths.
- Preview-browser verification before every UI commit (desktop and mobile widths, dark and light).

## 15. Phases

Each phase ships on its own and is usable.

- **P0 — Archive and rename.** Section 12. One day.
- **P1 — Conversation core and app shell.** Streaming, persistent history, facts memory, prompt diet, new SOUL, the `app/` shell with Chat view in Night Desk, first-run card. This is the "Muse feeling."
- **P2 — Voice.** Both surfaces, both directions.
- **P3 — Tasks, schedules, night shift, morning brief, Review view.**
- **P4 — Manuscript sync, connectors, email triage, teachable skills, capability switches, security boundary, Fibb MCP server.**
- **P5 — Books view polish, mascot states, PWA, proactive nudges and mentions, light theme, docs.**

## Appendix A — Mascot brief for ChatGPT Images

Fibb is a small, round, friendly creature who lives at a writer's desk. Think a cross between an inkblot and a sleepy owl: soft charcoal body, big curious eyes, a tiny warm-amber glow (like a desk lamp) somewhere on it. No text. Flat illustration, minimal shading, transparent background, 1024×1024, consistent across all four:

1. **Idle:** sitting on a stack of two books, looking at the viewer, content.
2. **Thinking:** one eye squinted, a small pencil tucked behind an ear, a thought-bubble with a single star.
3. **Working overnight:** eyes half closed, wearing a tiny nightcap, a single warm lamp beside it, a page with three lines being written.
4. **Celebrating:** arms up, a few confetti bits in amber, mouth open in a cheer.

Palette: body #2A2D36, eyes #F3F1EC, accent #E8A33D. Avoid: gradients, 3D render look, human features, hats other than the nightcap.
