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
- **YouTube may play an AI-dubbed audio track instead of the original.** Some videos have auto-dubbed tracks, and in an English browser the player picks the English dub by default: 19 of the 48 videos of the evaluation set have one, 17 played it on a fresh profile (2026-11-08). The extension then hears English: Whisper with `sourceLanguage: "ja"` gave "yeahyeah." and "i." on dZgXCAWnz2c, and voice detection still calls it speech. Check before any capture: `movie_player.getAudioTrack()` and `getAvailableAudioTracks()` (minified objects; the part with `isAutoDubbed` has `name`, e.g. "English (US)" and "Japanese original"). Select the original with `movie_player.setAudioTrack(<track>)`, then reload the page so the extension starts without dubbed audio in its buffer (the choice survived the reload in the session checked). `eval-collect.py` does this and records the state in every capture; `qa-eval.ts` refuses captures of a dub.
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

## 6. Quota levels and Groq replies without Groq (fake replies)

To run the real background code (rate limiter, `x-ratelimit-*` headers, quota levels, the translation pause, the low-quota scheduling) without a key or a Groq call, `test/fake-groq/fake-groq.mjs` answers the service worker's requests to `https://api.groq.com/*` through CDP. It is a CDP client run with the VM's `node` (it listens on nothing); it is test-only, never part of the extension.

```bash
SP=<scratchpad>
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36"
# 1. Start the browser with Groq unresolvable, so a request the fake misses fails instead of reaching Groq.
agent-browser --session $S --extension <path>/dist --extension <path>/test/ad-skip --user-agent "$UA" \
  --args "--no-sandbox,--disable-blink-features=AutomationControlled,--host-resolver-rules=MAP api.groq.com ~NOTFOUND" open about:blank
# 2. The fake: what it answers comes from control.json, re-read for every request.
echo '{"delayMs":0,"whisper":{"remaining":1900,"limit":2000},"chat":{"remaining":900,"limit":1000}}' > $SP/control.json
node <path>/test/fake-groq/fake-groq.mjs "$(agent-browser --session $S get cdp-url)" $SP/control.json $SP/fake-log.jsonl   # in the background
# 3. A fake key on the popup page (section 3), then play a video with speech (muted).
```

- `fake-log.jsonl` gets `attached` (with `fetchEnabled: true`) for the extension's service worker, then `whisper-start` / `whisper-done` and `chat-start` / `chat-done` per request. Whisper replies are two numbered Japanese lines (`偽の字幕その<n>番です。`) at 1–3 s and 4–6 s of each chunk; translations are `【假譯】<line>`.
- `remaining` / `limit` become the `x-ratelimit-*-requests` headers (the daily request budget, reset in 2 h): `remaining` under 10% of `limit` puts that kind at `low`, 0 at `out`, from the next reply on. The content script learns it from that reply or its next `get-quota` (every 30 s).
- `delayMs` holds every reply that long: above the 5 s a chunk waits for the one before it, it shows whether two Whisper requests run at once (`whisper-start` twice before a `whisper-done`).
- The fake auto-attaches to service workers that start later, paused until interception is on; a restart of ours was not observed in the runs so far (the attached CDP session seems to keep it alive; `Target.closeTarget` on it reported success but no new worker started), so that path is untested. The `--host-resolver-rules` guard covers it either way: 0 `blocked` lines and no Groq traffic in 3 runs. Stop the fake before closing the browser.
- To show a budget in the popup without any request, seed `groqUsage` instead (e.g. 185,000 chat tokens in the current hour: `{hours: {chat: [{hour: Math.floor(Date.now() / 3600000), cost: {requests: 0, audioSeconds: 0, tokens: 185000}}], whisper: []}, videos: {}}`). The service worker reads `groqUsage` only when it starts, so for the extension itself use the headers.

What the levels must do (AGENTS.md, "Quota and usage"), and where to see it:

| Level         | Check                                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| chat `low`    | no further `chat-start` in the fake log; `whisper` lines still logged; the CC track shows the original only; status "翻譯額度剩不到 10%，暫停翻譯，只顯示原文"; the `cache:<video>:…` entry lists only translated chunks |
| whisper `low` | never two `whisper-start` without a `whisper-done` between them (with `delayMs` over 5 s); chunks end at most ~30 s + one chunk ahead of the playhead                                                                    |
| whisper `out` | no `whisper-start` after the reply that said 0; `state` logs `reason` "今天的語音辨識額度用完了"; status "AI 字幕：今天的語音辨識額度用完了"                                                                             |

The popup's "Groq 今日額度" lists each budget ("剩 50 / 1,000") with the warnings.

## 7. Evaluating caption quality offline (debug captures)

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

## 8. Evaluation set (ground truth, captures, scores)

The evaluation set (`src/qa/dataset.ts`: video IDs with language, content type and voice type) scores voice detection (layer A), the hallucination filters (B) and the captions the viewer gets (C) against creator caption tracks, so a change to `voice.ts`, the filters or segmentation is judged by numbers. Caption text and captures stay in `.qa/` (gitignored); only voice features and speech intervals of a few stretches are committed, as CI fixtures (`src/test/eval/`).

Collect on the VM host with the two scripts next to this file (Python, agent-browser; they wait while 3 or more agent-browser Chromes run or under 3 GB is free, pace page loads one per video, and never print the key):

```bash
cp -r <path>/dist <scratchpad>/ext    # a copy: a rebuild must not change the extension mid-run
export QA_EXTENSION=<scratchpad>/ext QA_AD_SKIP=<path>/test/ad-skip
D=<path>/.claude/skills/test-extension-in-browser
python3 -I $D/eval-collect.py dry <session> <path>/.qa <id>...       # creator + automatic tracks, dry run 0–480 s at 2×
python3 -I $D/eval-collect.py gt <session> <path>/.qa <id>...        # tracks only; a failed fetch (error or empty track) is fetched again
python3 -I $D/eval-plan.py <path>/.qa <ids-file> <ids-to-translate> > <scratchpad>/plan.json
python3 -I $D/eval-collect.py whisper <session> <path>/.qa <scratchpad>/plan.json   # Groq: needs the brief's OK
```

- `dry` and `whisper` set `debugCapture`, `debugForceWhisper` (videos with a creator track would otherwise skip Whisper) and, for `dry`, `debugDryRun`. Every video of the set has creator tracks.
- Tracks: the player's own timedtext request carries the `pot` token; the script records the URLs the player opens (the extension answers some requests itself, so they never reach the network), switches to a real track to make the player ask, and `setOption("captions", "reload", true)` when the first request had no token.
- Whisper windows (`eval-plan.py`): the 180 s inside 0–480 s with the most speech, preferring one with a pause of 8 s or more. Playback stops 80 s before the window's end (the scheduler's lead), then the popup tab comes to the front: a hidden tab starts no new chunk, so nothing is billed past the window. The extension is turned off before the YouTube tab is shown again, or it schedules more chunks for the paused playhead (2 wasted requests in the first run). One window costs about 7 requests and 190 s of audio; translation about 10,000 tokens.
- Every page load checks the audio track (section 2: auto-dubbed tracks), switches a dub to the original and reloads, and writes the state to the capture (`audio`); `eval-collect.py audio <session> <qa-dir> <id>...` lists the tracks of each video into `<qa-dir>/audio.json` without capturing. `qa-eval.ts` refuses a capture whose state says a dub played, and one without a state for a video that has a dub track.
- Stop at the first `google.com/sorry` (the script does) and wait 20 minutes.

Score (in the dev container, no API calls):

```bash
T3CODE_WORKTREE_PATH=<path> wt-exec node scripts/qa-eval.ts             # per video, per category, voice type, language
T3CODE_WORKTREE_PATH=<path> wt-exec node scripts/qa-eval.ts --dataset   # what each video's ground truth supports, and why
T3CODE_WORKTREE_PATH=<path> wt-exec node scripts/qa-eval.ts --video <id>   # one video, every number
T3CODE_WORKTREE_PATH=<path> wt-exec node scripts/qa-eval.ts --saved     # C on the cues saved at capture time, not a replay
T3CODE_WORKTREE_PATH=<path> wt-exec node scripts/qa-eval.ts --write-fixture <id> <from> <to> <name>   # a CI fixture
```

What the columns mean:

- **Ground truth** (`src/qa/ground-truth.ts`, the trap rules of the `research-youtube-captions` skill): the creator track in the spoken language is compared with YouTube's automatic track. Line starts are matched to automatic words that start with the line's first two characters (the nearest start alone mismatched on tracks with sparse word timing: p90 1.17 s instead of 0.27 s on Il3rOIG-6pg). A copy of the automatic track (start offset |median| and p90 under 0.03 s and difference under 0.1) is dropped; YouTube-aligned timing (offset 0, text hand-made) keeps CER only; a difference over 0.5, under 60% of the automatic speech covered, or start p90 over 1 s each turn off what they spoil. Precision needs gaps between lines (20% of gaps over 0.3 s) and an automatic track. A translation track alone (ROLAND) gives recall and the reference translation. Cards, notes and speaker labels are removed from the text first.
- **A**: the dry-run features laid end to end, and a 10 s and a 30 s chunk starting at every second, each decided as the content script does (`bestVoicedWindow ≥ MIN_VOICED_SHARE`). `talk`: talk seconds in sent chunks; `lines skipped`: lines (by midpoint) that some skipped chunk contained; `BGM skipped` / `quiet skipped`: no-speech chunks (neither creator nor automatic track within 0.5 s) louder / quieter than −45 dBFS median that were skipped; `prec`: sent chunks with at least 0.5 s of talk.
- **B**: every Whisper segment of the captures with the filters' decision (`segmentDecisions`), labelled speech (overlaps creator lines, or shares half its character pairs with the lines within 3 s), no speech (nothing from the creator or the automatic track within 1 s, only where precision is supported) or unsure.
- **C**: over the window the captures cover, with segmentation replayed by the current code: share of talk seconds while a line shows; CER of all our lines against the creator's (NFKC, no punctuation or spaces; kanji/kana spelling differences count as errors, so compare numbers between versions, not with other systems); start/end offsets for lines that start (end) with the same two characters within 2 s; chrF (character n-grams 1–6, β = 2) of the translation against a Traditional Chinese creator track over the window. chrF needs no word segmentation and ignores where lines were split, which differs between our lines and the creator's.

## 9. Evidence and cleanup

- `agent-browser --session $S screenshot <scratchpad>/<name>.png` for the YouTube page and the popup.
- `agent-browser --session $S close` when done.
