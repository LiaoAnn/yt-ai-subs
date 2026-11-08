---
name: test-extension-in-browser
description: Use when you need to build the extension and load it in a real Chrome (agent-browser) to check that it works on a YouTube page or that the popup saves settings.
---

# Build and test the extension in agent-browser

The extension is loaded unpacked from `dist/` of your worktree. Builds run in the dev container; the browser runs on the host (the desktop VM) and reads `dist/` straight from the worktree path.

`<path>` below is your worktree (the git top level). Never sign in to YouTube or Google, and never call Groq or any paid API without the user's OK.

## 1. Build

```bash
T3CODE_WORKTREE_PATH=<path> wt-exec pnpm check
T3CODE_WORKTREE_PATH=<path> wt-exec pnpm build
```

`dist/` must contain `manifest.json`, `popup.html`, `background.js`, `content.js`, `page.js` and `assets/`. For iterative work, run `pnpm dev` (watch) in a tmux session instead, and reload the extension after each rebuild.

## 2. Open YouTube with the extension

Use your own agent-browser session (stable per worktree), and **always load the test ad skipper (`test/ad-skip/`) next to `dist/`**: repeat `--extension` once per directory (tested with agent-browser 0.41; its `--help` also lists `AGENT_BROWSER_EXTENSIONS=<dir1>,<dir2>`, untested):

```bash
S=$(agent-browser session id --scope worktree --prefix task)
agent-browser --session $S --extension <path>/dist --extension <path>/test/ad-skip --args "--no-sandbox" open "https://www.youtube.com/watch?v=jNQXAC9IVRw"
agent-browser --session $S wait --load load
agent-browser --session $S console | grep -E 'yt-ai-subs|ad-skip'
```

- The ad skipper is a test-only helper, never part of the product. While `#movie_player` has `ad-showing` / `ad-interrupting` it mutes the ad `<video>`, plays it at 16×, keeps seeking to the end of what is buffered (seeking past it stalls the ad until YouTube fetches the end) and clicks any skip or overlay-close button. Afterwards it restores the main video's `playbackRate` and `muted` for an ad in the middle of a video; after a pre-roll it sets the rate to 1 and leaves `muted` alone (unmuting would pause a muted headless autoplay). Console lines: `[ad-skip] loaded` (once per page load: it is installed), then per ad `ad started at /watch?v=…`, `fast-forward ad (t …/… s, paused …, readyState …, buffered […])`, `clicked skip (<selector>)`, `ad over after <ms> ms, <n> seeks; …`, and `ad still showing after 10 s: …` when it did not work. Count ads with `console | grep -c "ad-skip] ad started"`; no `ad started` line means that page showed no ad.
- Ads are rare in this headless setup: in runs of one page view per minute in one session, 2, 4 and 3 of 15, 15 and 8 page views showed an ad (pre-rolls, and pre-rolls of the next video YouTube autoplays after a short one). Do not open many videos quickly to find one: after a few dozen page views in ~15 minutes YouTube redirected to Google's `google.com/sorry/…` CAPTCHA page. Check `eval "location.host"` when a page looks empty, and wait (20 minutes was enough).
- `--extension` and `--args` apply only when the session's browser starts. If the session is already running (without the extension, or with an old build), `agent-browser --session $S close` first.
- `--no-sandbox` is required on the dev VM: Chrome dies with `No usable sandbox!` because Ubuntu's AppArmor blocks unprivileged user namespaces.
- Add `--headed` only when someone needs to watch on the shared desktop; headless works for everything below.
- Extensions do not run in incognito; agent-browser's default profile is fine.
- The session's profile is temporary: `close` wipes `chrome.storage` (settings, key, cache). To load a rebuild, `close` and start again, then set the settings again. Do not call `chrome.runtime.reload()`: it leaves an extension loaded with `--extension` disabled.
- Headless autoplay is blocked (`play()` rejects with `NotAllowedError`): set `video.muted = true` before `play()`. Muted playback still feeds MediaSource, so the hook gets the audio. YouTube may set `muted` back to false about a second after playback starts (its own volume setting), and Chrome then pauses the video: in one run, 10 of 10 videos stopped at about 1 s after a single muted `play()`. Re-mute and `play()` again whenever the video is paused, until it keeps playing.
- **Start the browser with a normal user agent and without the automation flag**, or YouTube stops playback after about 20–40 s ("Something went wrong. Refresh or try again later."), and at once on any seek. It takes both: `--user-agent` with a plain `Chrome/<version>` (not `HeadlessChrome`) and `--disable-blink-features=AutomationControlled` (so `navigator.webdriver` is false). Either one alone still failed (1 run each); with both, playback ran 5+ minutes and seeks worked. No account, no persistent profile needed.

  ```bash
  UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36"
  agent-browser --session $S --extension <path>/dist --extension <path>/test/ad-skip --user-agent "$UA" \
    --args "--no-sandbox,--disable-blink-features=AutomationControlled" open "https://www.youtube.com/watch?v=<id>&t=60s"
  ```

Expected console lines (all entries log with the `[yt-ai-subs]` prefix):

```
[log] [yt-ai-subs] page script loaded (MAIN world) loading
[log] [yt-ai-subs] content script loaded (isolated world) loading
[log] [yt-ai-subs] content script got page message: page-ready
[log] [yt-ai-subs] background replied: {type: "pong", version: "0.1.0"}
```

`loading` is `document.readyState`: it proves the scripts ran at `document_start`. The last two lines prove page → content (`window.postMessage`) and content → background (`chrome.runtime.sendMessage`) messaging.

## 3. Open the popup

agent-browser cannot click the toolbar icon, so open the popup page as a tab. Find the extension ID first:

```bash
agent-browser --session $S open chrome://extensions
agent-browser --session $S eval "document.querySelector('extensions-manager').shadowRoot.querySelector('extensions-item-list').shadowRoot.querySelector('extensions-item').id"
agent-browser --session $S open chrome-extension://<id>/popup.html
agent-browser --session $S set viewport 360 480
agent-browser --session $S snapshot -i
```

To test saving, use a fake key (e.g. `gsk_fake_not_a_real_key`), never a real one:

- After choosing an option in a shadcn/Radix `Select`, `wait 800` before the next click: while the dropdown closes, an overlay swallows clicks ("Element is covered by …").
- Save, `wait --text "已儲存"`, `reload`, and snapshot again: the fields should keep their values.
- Read what was stored without printing the key:

```bash
agent-browser --session $S eval "chrome.storage.local.get('settings').then(s => ({...s.settings, groqApiKey: s.settings.groqApiKey ? '(set, ' + s.settings.groqApiKey.length + ' chars)' : ''}))"
```

## 4. Logs and state

The background's own `console.log` lines go to the service worker, not the page console. The content script logs what matters to the page console instead, so `console | grep yt-ai-subs` shows it:

- `whisper <start>–<end> s (<n> s audio): <ms> ms[, waited <ms> ms for the rate limit], <n> lines`
- `translation <start>–<end> s: <n> lines, <tokens> tokens, <ms> ms`
- `first caption <ms> ms after play/seek`, `cancel <range> (playhead <t>)`, `cache hit: …`
- every 10 s, `state {…}`: buffered audio ranges, jobs in flight, cue count, last error, and why nothing was sent (`reason`).

From the popup page (`chrome-extension://<id>/popup.html`) an eval can read `chrome.storage.local` (`cache:*` with their `cachemeta:*` keys, `groqUsage`: billed usage per hour and per video) and `chrome.storage.session` (`rateLimiter`: the limiter's log and the budgets Groq reported in its `x-ratelimit-*` headers).

## 5. With a real Groq key (only with the user's OK for that run)

Never print the key or put it on a command line. Pipe the script into `eval --stdin` and return only its length, e.g. a script that runs `python3 -I` to read the key file (`/home/dev/.local/state/yt-ai-subs/groq-key` on the dev VM; see "Secrets" in `AGENTS.md`) and print `chrome.storage.local.set({settings: {...stored, groqApiKey: <json>}})` JS, piped into `agent-browser --session $S eval --stdin`, run on the popup page. Count usage from the `whisper` / `translation` log lines (Groq bills each transcription as at least 10 s).

## 6. Evaluating caption quality offline (debug captures)

To judge timing and line breaks without paying for the same audio twice, record what each chunk produced and re-run segmentation on it locally.

1. Turn on `debugCapture` (a setting not shown in the popup) together with the key, from the popup page: `chrome.storage.local.set({settings: {...stored, debugCapture: true}})`. Then every finished chunk is saved as `debug:<video>:<start>` in `chrome.storage.local`: Whisper's raw `verbose_json`, the prompt sent, a loudness envelope (dBFS per 20 ms, no audio) and the cues shown.
2. Play the video (muted) for as long as you want to evaluate; pause and wait ~20 s so in-flight chunks finish.
3. Export from the popup page and delete them, e.g. `chrome.storage.local.get(null).then(all => JSON.stringify(Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith('debug:')))))`, saved as a JSON file under `.qa/` (gitignored) or your scratchpad. Never commit captures: they are other people's transcripts.
4. Re-run segmentation on them in the dev container (no API calls):

   ```bash
   T3CODE_WORKTREE_PATH=<path> wt-exec node scripts/qa-replay.ts .qa/            # per video + overall statistics
   T3CODE_WORKTREE_PATH=<path> wt-exec node scripts/qa-replay.ts --cues .qa/x.json   # every line with its timing
   T3CODE_WORKTREE_PATH=<path> wt-exec node scripts/qa-replay.ts --saved .qa/x.json  # the lines as shown at capture time
   ```

   The summary has chunk count and length, `startError` / `endError` (line edge minus the speech onset/offset found in the envelope, only for lines next to a pause; positive = late), line length and duration, `badBreaks` (line split inside a word), `tinyLines`, `cutSentences`. Compare `--saved` with a replay to see what a segmentation change does to the same audio. The envelope measure is noisy with background music or several speakers; read the lines too.

5. On-screen timing (native CC or overlay): sample `.ytp-caption-segment` (and `#yt-ai-subs-captions`) text with `video.currentTime` every 100 ms from a page eval, and compare when each cue's text first appears with its `start`. The CC track only changes after YouTube reloads it (`setOption("captions","reload")`, which waits for a gap between captions, up to 3 s), so measure there, not from the cue list.

Tuning without the API: add `debugDryRun: true` (and no key) to the settings. Chunks are then decoded, measured (loudness and `voiceFeatures`) and saved as captures, but nothing is sent. Playing at `video.playbackRate = 2` halves the wall time. Line up the features with an earlier capture of the same video, using its Whisper segments as the speech labels.

Re-translating saved lines without Whisper: `node scripts/qa-replay.ts --json <capture>` prints the lines per chunk. From the popup page, send each chunk as `chrome.runtime.sendMessage({type: "translate", requestId, lines, context})`; the background answers with the real prompt and limiter, and the key never leaves it. Pace the calls (about 12 s apart): when the limiter makes a call wait longer than agent-browser's eval timeout, the eval comes back empty, but the request still runs and is billed.

Groq usage for a run: count the `whisper … (<n> s audio)` and `translation …, <n> tokens` lines in the console (Groq bills each transcription as at least 10 s), and read `rateLimiter` from `chrome.storage.session` for the remaining budgets Groq reported.

## 7. Evidence and cleanup

- `agent-browser --session $S screenshot <scratchpad>/<name>.png` for the YouTube page and the popup.
- `agent-browser --session $S close` when done.
