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
- **Where captions appear**: in YouTube's own caption (CC) menu as a selectable track ("AI 繁中", "AI 英文" or "AI 原文", named from the settings when the video loads), drawn by YouTube's renderer with the viewer's caption settings. The page script adds the track to every player response (`ytInitialPlayerResponse`, `/youtubei/v1/get_watch` and `/player` via `fetch`), answers the player's timedtext XHR for it with our json3, selects it once per video, and reloads it when new cues arrive. The overlay is only the fallback, used per video when a health check sees the hook break; the popup shows which mode the tab uses. How it works and how to debug it: the `debug-caption-track` skill.
- **Audio source**: copy the audio YouTube already appends to its MediaSource buffers (hook `SourceBuffer.prototype.appendBuffer` in the page's MAIN world). Never download media from googlevideo directly.
- **Chunking**: request roughly 30–60 s ahead of the playhead; a short first chunk after start/seek; cancel or deprioritise work that a seek made irrelevant; prefer cutting at silences over a fixed grid.
- **Rate limiting**: every Groq request goes through one limiter in the background (`src/background/rate-limiter.ts`), with our own ceilings a little under the free tier: Whisper 18 req/min and 7,000 audio s/hour (each request billed as at least 10 s, as Groq does); gpt-oss 28 req/min and 7,500 tokens/min. It also obeys Groq's `x-ratelimit-remaining-*` / `x-ratelimit-reset-*` headers (Groq sends `requests` (per day), `tokens`, `audio-seconds`) and a 429's `retry-after`, and its log survives service worker restarts in `chrome.storage.session`.
- **Translation requests**: `reasoning_effort: "low"`, JSON mode, lines sent and returned as a numbered object (`{"1": …, "2": …}`). A plain list let the model merge a sentence split over two lines and shift every later translation by one.
- **Caption data**: `Cue` (`src/shared/captions.ts`, seconds, `original` + optional `translation`) converts one-to-one to YouTube timedtext json3 (`toJson3`); the CC-menu track shows the translation, with the original on the line above when "翻譯上方顯示原文" is on.
- **Cache**: finished chunks per video and per caption-shaping settings in `chrome.storage.local` (`cache:<video>:<whisper model>:<language>:<translation or none>`), at most 50 entries and 30 days, tracked in `cacheIndex`. Chunks whose translation failed are not cached.

## Stack

- React + Vite + shadcn/ui + Tailwind CSS for the popup/options UI.
- TypeScript 7 (`tsc` v7, the native compiler) for type checking.
- oxlint for linting, oxfmt for formatting. No ESLint or Prettier.
- pnpm (via corepack) as the package manager.
- Content script (isolated world), page script (MAIN world) and service worker are separate entry points.
- Build: plain Vite 8, one build per entry point, driven by `scripts/build.ts` (no `@crxjs/vite-plugin`). The page script must run synchronously at `document_start`, before YouTube's player code, so it is bundled as a single classic script (IIFE) with no loader; CRXJS injects content scripts through an async dynamic-import loader, which would install the `appendBuffer` hook too late. The content script is an IIFE too (content scripts cannot be ES modules); the service worker is an ES module; the popup is a normal Vite HTML build (`vite.config.ts`).
- `public/manifest.json` is copied to `dist/` as is; edit it there. `vite build` alone builds only the popup: use `pnpm build`.

## Project layout

- `src/page/` MAIN-world page script (hooks the audio, posts it with `window.postMessage`; serves the CC-menu caption track).
- `src/content/` isolated-world content script (chunking, scheduling, captions).
- `src/background/` service worker (speech-to-text and translation API calls).
- `src/popup/` settings popup (React); `src/components/ui/` shadcn/ui components (add more with `pnpm dlx shadcn@<version> add <name>`, then check that imports use `@/lib/utils`).
- `src/shared/` code shared by the entry points: message types (`messages.ts`), settings and `chrome.storage.local` access (`settings.ts`), caption data (`captions.ts`), YouTube URL helpers (`youtube.ts`), the `[yt-ai-subs]` log prefix (`log.ts`).
- Pure logic lives in its own module with a `*.test.ts` next to it (Vitest, Node environment, no `chrome.*`): WebM parsing, audio coverage, scheduling, segmentation, rate limiting, cache eviction. Keep browser glue (`index.ts`, `wav.ts`'s decoding, `overlay.ts`) thin. Test fixtures go in `src/test/`.

## Scripts

Run them in the dev container (see the next section).

- `pnpm build` builds the unpacked extension into `dist/` (production, minified).
- `pnpm dev` rebuilds `dist/` on change (development, inline source maps). Reload the extension in `chrome://extensions` (and the YouTube tab) after a rebuild. Changes to `public/manifest.json` need a restart of `pnpm dev`.
- `pnpm typecheck` (`tsc -b`), `pnpm lint` (oxlint), `pnpm format` / `pnpm format:check` (oxfmt).
- `pnpm test` runs the unit tests (Vitest, `vitest.config.ts`).
- `pnpm check` runs typecheck, lint, format:check and test; it must pass before a commit.

## Development environment

- `.devcontainer/` defines a compose-based dev container (service `app`: Node 24, pnpm via corepack, the repo at `/workspaces/yt-ai-subs`, no ports; `pnpm install` on create). Install, build, lint and tests run there, never on the host.
- The build writes the unpacked extension to `dist/`; browser tests load it from the host path of the worktree. How: the `test-extension-in-browser` skill.

## Development workflow

Every change goes through these four steps, in order:

1. **Plan** with the `plan-it` skill: approach, scope and how it will be verified.
2. **Implement** with the `implement-plan` skill, until `pnpm check` and `pnpm build` pass.
3. **Review** the diff with the `review-change` skill (`git diff main...HEAD` plus uncommitted changes). The review is done by Codex `gpt-6.1-sol` at medium reasoning effort, delegated from the working thread in the same worktree; it reports findings only and does not edit files. Fix what it finds; re-run the review only after large changes.
4. **Verify** in a real browser: install the built extension with agent-browser and check the effect on a YouTube page (the `test-extension-in-browser` skill; keep evidence with the `verification-evidence` skill).

## Secrets

- API keys live only in `chrome.storage.local` of the browser profile. Never commit, log or print a key. For local testing the user supplies the Groq key through T3's secret prompt; agents must not read its value.
