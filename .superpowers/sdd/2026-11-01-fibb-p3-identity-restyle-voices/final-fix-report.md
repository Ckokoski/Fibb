# Final fix wave (fibb-p3)

1. companion.setVoiceOverride: `edge:X` normalizes to `X` when VOICE_PRESETS[X] exists. Test added; RED before (companion.test.ts 1 failed / 6 passed with the old file), GREEN after.
2. tts.generateGemini: missing key, any HTTP error (status attached to errors in tts-gemini.ts), network error, non-WAV all go through shared `fallbackToDefault(text, reason, options)` (Kokoro if ready, else Edge narrator_warm). Log carries HTTP status only. Kokoro not-ready/synthesis errors use the same helper.
3. KokoroEngine.detectCached() looks for model_quantized.onnx under modelsDir/onnx-community/Kokoro-82M-v1.0-ONNX; initialize() sets `cached` and starts load() unawaited. Status stays `cached` during load. isVoiceReadySync/isAvailable/listCatalog use cached||ready.
4. Tests: gateway/src/services/tts-fallback.test.ts (kokoro-js mocked): load failure+retry, not-ready->Edge, synth throw->Edge, cached detection, Gemini 429/404/500/403->Edge, 429->Kokoro when ready, missing key/network error, concatWav sizes.
5. telegram.ts logs HTTP status on voice send failure; VoiceSection poll wrapped in try/catch.
6. ChatView onSpeaking; App priority listening > thinking > speaking > celebrating > idle; Hero shows idle image + "speaking…", no animation; onBusy excludes speaking.
7. TonightDrawer: double rAF focus with preventScroll (cancelled in cleanup), transitionend backstop, `inert` on `.main` while open.
8. CSS: removed duplicate hero rule in first mobile block and width/height transition; end-of-file block uses `.main .hero-img-wrap` / `.main .hero`.
9. VoiceSection: cached counts as Ready; friendly error copy with raw message in title; `.prov.off` uses --text-3 instead of opacity.
10. README and QUICKSTART updated.

## Results
- `npm run check`: Test Files 32 passed (32), Tests 492 passed (492), tsc clean.
- `npm run app:build`: built in 869ms, clean.
