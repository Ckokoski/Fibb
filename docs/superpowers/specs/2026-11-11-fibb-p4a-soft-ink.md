# Fibb P4a: Soft Ink restyle, living Nib, welcome screen

**Date:** 2026-11-11 · **Status:** approved from the clickable mockup (`docs/superpowers/mockups/fibb-soft-ink.html`): "I love the new mockup. Yes, go with that style."

## Why

Side by side with Muse, Fibb felt stiff. The palette (charcoal and amber) fought the mascot (periwinkle and peach), shapes were small and squared, the screen was flat, the app opened on an empty thread, and nothing moved.

## What changed

- **Palette from Nib.** Periwinkle accent, peach highlight, cream-lilac paper in light; deep ink blue in dark. Theme still follows the system unless the author picks one. Tokens renamed from `--amber*` to `--accent*`.
- **Round shapes.** Floating pill dock (was the rail), pill composer with circular buttons, glass cards with 20 to 28 px radii, pill buttons and chips.
- **Depth.** Two slow-drifting blurred glows behind the page, a glow under Nib, glass surfaces with backdrop blur.
- **Welcome screen.** Each time the app opens, Nib sits large (148 px) above a time-of-day greeting, a line about the current book, and three suggestion cards. Sending anything shrinks Nib to 76 px and shows the thread. A link shows the earlier conversation. Greeting text only uses real data (name, book, chapter, streak, words today).
- **Motion.** Spring ease (`cubic-bezier(.22,1,.36,1)`) on message entry, card hover lift, button press, drawer and sheet.
- **Living Nib.** The four state SVGs are now inlined (only the app's own `/mascots/*.svg` files, path-checked) so CSS can animate named groups: eyes blink (single, then a double), the tail sways, cheeks pulse, the body floats. Thinking breathes, listening tilts, speaking pulses, celebrating bounces. All motion stops under `prefers-reduced-motion`.
- Streak chip in the header (opens Tonight) when the streak is above zero.

## Calls made by the builder (not Chris)

- Font is Plus Jakarta Sans (Google Fonts, already allowed by the CSP).
- The welcome screen shows on every app open, not only for new users.
- Photo "looks" other than Nib stay still images and get the float only.

## Not in this phase

Tasks, schedules, night shift, morning brief (P4b). Google connectors and Fibb's own browser behind approval (P4c). Proactive observations (P4d).
