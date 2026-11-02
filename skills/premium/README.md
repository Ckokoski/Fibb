# Premium Skills (Bring Your Own Tools)

This directory is where Fibb looks for premium skills that you've added
yourself. Drop a folder containing a `SKILL.md` here and Fibb auto-loads
it on startup.

## How to expand Fibb with the Writing Secrets toolset

Writing Secrets sells stand-alone author tools (Book Bible Engine, Workflow
Engine, Manuscript Autopsy, Style Clone Pro, etc.). Fibb can plug into
any of them in two ways:

### Option 1 — Place the tool folder next to Fibb

If you've purchased a Writing Secrets tool that ships as a folder of files
(workflow JSONs, book bible templates, prompt libraries, etc.), drop that
folder here:

```
<wherever Fibb lives>/
├── authoragent/
└── Author OS/             ← your purchased tools live here
    ├── Author Workflow Engine/
    ├── Book Bible Engine/
    ├── Manuscript Autopsy/
    ├── AI Author Library/
    └── Creator Asset Suite/
```

Fibb auto-discovers any of these on startup and **auto-generates skills
for each tool** (`author-os-workflow`, `author-os-book-bible`, etc.) so you can
use them by name in chat.

### Option 2 — Expose any tool via a Skill folder

If you've got a tool, prompt library, or template set you want Fibb to
treat as a skill, drop a `SKILL.md` in this directory:

```
skills/premium/
└── my-cool-tool/
    └── SKILL.md
```

Fibb will load it on next startup. The `skill-acquisition` skill can also
help you draft a `SKILL.md` for an existing tool — just say "create a skill
for [tool name and description]".

## Where to buy author tools

[**Writing Secrets Ko-Fi store**](https://ko-fi.com/ckokoski/shop) —
one-off purchases of standalone author tools (Book Bible Engine, Workflow
Engine, Manuscript Autopsy, Style Clone Pro, and others). These work
standalone *and* plug into Fibb via Option 1 or Option 2 above.

[**getwritingsecrets.com**](https://www.getwritingsecrets.com) — guides,
prompts, frameworks, and the Writing Secrets newsletter.

## Verification

After adding a tool, restart Fibb and check the startup log. You'll see:

```
✓ Author OS: N tools found at <path>
✓ Author OS skills auto-registered: M skill(s)
```

Or, for skills you dropped directly into `skills/premium/`:

```
★ Premium skill loaded: <skill-name>
```

You can also check `workspace/SKILLS.txt` (auto-generated on startup) for the
full list of skills currently active.
