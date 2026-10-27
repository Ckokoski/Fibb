# Fibb Quick Start

Get Fibb running and writing in under 5 minutes.

## Quick Start (2 minutes, no Docker)

```bash
git clone https://github.com/Ckokoski/Fibb.git fibb
cd fibb
npm install
npm start
```

Your browser opens http://localhost:3847 automatically. Fibb says hello and asks your name and what you're
working on. If no AI provider is reachable, the chat shows one card: paste a free Gemini key
(aistudio.google.com) or install Ollama. That's the whole setup.

Docker is only for always-on VPS deployments (see SECURITY.md); you never need it on your own PC.

## View Results

- **Dashboard** → Activity Log tab shows everything the agent did
- **Files**: `workspace/projects/` contains all generated content
- **Telegram**: Use `/files` to list, `/read [file]` to preview

## Add More Providers

Fibb gets smarter with better models. In Settings, add:

- **Anthropic Claude** — Best for complex editing and reasoning ($3/M tokens)
- **DeepSeek** — Good for creative writing at low cost ($0.14/M tokens)
- **Ollama** — Free local models (requires Ollama installed)

## Next Steps

- Run a full novel: `/goal write a full tech-thriller from start to finish`
- Do research: `/research medieval sword fighting techniques`
- Customize: Edit `workspace/soul/STYLE-GUIDE.md` for your writing style

## Premium Skills Bundle

Extend Fibb with advanced writing capabilities. The **Premium Skills Bundle** includes 10 premium skills — Ghostwriter Pro, Series Architect, Book Launch Machine, First Chapter Hook, Comp Title Finder, Dictation Cleanup, Sensitivity Reader, Read Aloud, Narrative Voice Coach, and Writing Secrets Integration — all in one package.

**Get it on Ko-Fi:** [ko-fi.com/writingsecrets](https://ko-fi.com/s/4e24f1dfa5)

### Install Premium Skills

1. Purchase the bundle from Ko-Fi
2. Download and extract the zip
3. Copy all skill folders to `skills/premium/`
4. Restart Fibb — premium skills appear with a star in the console

## Author OS Integration

If you have the Author OS tool suite, mount the tools for enhanced capabilities:

- **Local**: Place at `~/author-os`
- **Docker**: Mount to `/app/author-os`

Fibb auto-detects: Workflow Engine, Book Bible Engine, Format Factory Pro, Manuscript Autopsy, AI Author Library, Creator Asset Suite.

Format Factory Pro requires Python 3 for manuscript export.
