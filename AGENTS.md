# yt-ai-subs

Chrome extension (Manifest V3) that transcribes YouTube audio with a speech-to-text model and, optionally, translates it with an LLM, a few chunks ahead of the playhead, so it only spends money on what the viewer actually watches.

## How agents keep knowledge

- Do not use agent memory features (Claude memory, Codex memories, etc.). Anything worth remembering goes into the repo:
  - project decisions and conventions → this file;
  - repeatable procedures (testing in the browser, releasing, debugging the audio hook) → a skill under `.claude/skills/<name>/SKILL.md`;
  - rules that can be checked mechanically → a lint rule or a test, not prose.
- When a decision here changes, update this file in the same change.

## Product decisions

- **Provider**: Groq first (Whisper `whisper-large-v3` / `whisper-large-v3-turbo` for speech-to-text, `openai/gpt-oss-120b` / `openai/gpt-oss-20b` for translation). OpenRouter / OpenAI are optional extras for translation. No xAI/Grok, no Codex subscription.
- **Groq free tier limits** (design the scheduler to stay under them):
  - Whisper: 20 requests/min, 2,000/day, 7,200 s audio/hour, 28,800 s audio/day, 25 MB per file.
  - gpt-oss-120b / 20b: 30 requests/min, 1,000/day, 8K tokens/min, 200K tokens/day.
- **Languages**: mainly Japanese and Korean sources, Traditional Chinese (Taiwan) target. Translation is optional: a transcribe-only mode must work on its own.
- **Where captions appear**: in YouTube's own caption (CC) menu as a selectable track, not only as a custom overlay. An overlay is acceptable only as a fallback when the menu hook breaks.
- **Audio source**: copy the audio YouTube already appends to its MediaSource buffers (hook `SourceBuffer.prototype.appendBuffer` in the page's MAIN world). Never download media from googlevideo directly.
- **Chunking**: request roughly 30–60 s ahead of the playhead; a short first chunk after start/seek; cancel or deprioritise work that a seek made irrelevant; prefer cutting at silences over a fixed grid.

## Stack

- React + Vite + shadcn/ui + Tailwind CSS for the popup/options UI.
- TypeScript 7 (`tsc` v7, the native compiler) for type checking.
- oxlint for linting, oxfmt for formatting. No ESLint or Prettier.
- pnpm (via corepack) as the package manager.
- Content script (isolated world), page script (MAIN world) and service worker are separate entry points.

## Development environment

- `.devcontainer/` defines a compose-based dev container (service `app`: Node 24, pnpm via corepack, the repo at `/workspaces/yt-ai-subs`, no ports; `pnpm install` on create). Install, build, lint and tests run there, never on the host.
- The build writes the unpacked extension to `dist/`; browser tests load it from the host path of the worktree.

## Secrets

- API keys live only in `chrome.storage.local` of the browser profile. Never commit, log or print a key. For local testing the user supplies the Groq key through T3's secret prompt; agents must not read its value.
