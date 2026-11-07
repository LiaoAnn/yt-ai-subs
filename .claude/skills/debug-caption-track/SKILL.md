---
name: debug-caption-track
description: Use when the AI caption track is missing from YouTube's caption (CC) menu, shows nothing or stale text, or the extension fell back to its overlay; explains how the CC-menu hook works, which YouTube internals it relies on, and how to check each step in agent-browser.
---

# Debug the AI caption track in YouTube's CC menu

The captions are served as one more caption track in YouTube's own player, so YouTube's renderer draws them with the viewer's caption settings. Nothing here is a public API: every step below leans on YouTube internals that can change without notice. When one breaks, the extension falls back to its overlay (`src/content/overlay.ts`) and the popup says why ("字幕顯示：備用疊加字幕（…）").

Code: `src/page/caption-track.ts` (pure logic, unit-tested), `src/page/caption-hooks.ts` (MAIN-world glue), `src/content/caption-track.ts` (content side), `src/popup/DisplayModeStatus.tsx`.

## How it works

1. **Track config before the player exists.** The first player response is assigned while the HTML is parsing, before the content script can answer anything, and the page script cannot read `chrome.storage`. So the content script mirrors `{enabled, label, languageCode}` into the page's `localStorage["yt-ai-subs:track"]` (`src/shared/track-config.ts`), and the page script reads it synchronously. Settings changed mid-video rename the track only from the next video on.
2. **Add the track to every player response** (`patchPlayerResponse`): one more entry in `captions.playerCaptionsTracklistRenderer.captionTracks` with `vssId` `.<lang>.ytaisubs`, `name.simpleText` = the label, and a `baseUrl` `https://www.youtube.com/api/timedtext?v=<id>&lang=<lang>&ytaisubs=1`; its index is appended to every `audioTracks[].captionTrackIndices`. A video without captions gets the whole `captions` block, which makes the CC button appear. Where the responses come from:
   - first load: `var ytInitialPlayerResponse = {…}` in an inline script → an accessor on `window` installed at `document_start` patches it in the setter;
   - SPA navigation: `fetch` of `/youtubei/v1/get_watch` (an array of parts; one is `{playerResponse}`) and prefetches through `/youtubei/v1/player` → the `fetch` wrapper patches the JSON and returns a new `Response`.
3. **Serve the track.** The player loads caption tracks with `XMLHttpRequest` (`/api/timedtext?…&fmt=json3&potc=1&c=WEB…`, it appends its own parameters to our `baseUrl`). The XHR hook spots `ytaisubs=1`, never sends the request, and completes it itself with our json3 (`readyState`, `status`, `responseText`/`response` as own properties, then `readystatechange`, `load`, `loadend`). The `fetch` wrapper does the same in case YouTube moves to `fetch`. The content script sends the events with a `track-cues` window message (`PAGE_COMMAND_TAG`) whenever its cues change; the text is the translation, with the original on the line above when "翻譯上方顯示原文" is on.
4. **Select and refresh.** Once per video, when the track shows up in `movie_player.getOption("captions", "tracklist")` and no ad is playing, the page script selects it with `setOption("captions", "track", <that entry>)`. If the viewer picks another track or turns captions off afterwards, that is respected until the next video. When new cues arrive and our track is selected, `setOption("captions", "reload", true)` makes the player request it again; the reload waits for a gap between captions (or at most 3 s) so the line on screen does not blink.
5. **Health check** (`TrackHealth`, every 500 ms), posted to the content script as `caption-mode` (`pending` / `cc` / `overlay`):
   - the track is not in the track list 8 s after the video loaded (ad time excluded) → overlay;
   - it is selected but the player never requested it within 6 s → overlay;
   - 6 samples in a row (with no confirmed hit in between) in which a served event was active but its text was not in `.ytp-caption-segment` → overlay.
     A video that fell back stays on the overlay; the next video starts over. On fallback the page script deselects our track, so a false alarm never shows the captions twice. The content script also falls back on its own if the page script says nothing about the current video for 10 s.

## YouTube internals it depends on (what will break first)

| Internal                                                                                                    | Used for                      | Symptom when it changes                                                                                     |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ytInitialPlayerResponse` global, `captions.playerCaptionsTracklistRenderer` shape                          | first page load               | no `caption track added to the player response` log on a fresh load; overlay "字幕選單裡沒有出現 AI 字幕軌" |
| `/youtubei/v1/get_watch`, `/youtubei/v1/player` via `window.fetch`                                          | SPA navigation                | first load works, clicking to another video falls back                                                      |
| timedtext via `XMLHttpRequest`, json3 (`events[].tStartMs/dDurationMs/segs[].utf8`)                         | serving cues                  | no `caption track served` log after selecting the track; overlay "播放器沒有載入 AI 字幕軌"                 |
| `movie_player.getOption/setOption("captions", "tracklist" / "track" / "reload")`, `getVideoData().video_id` | selecting, refreshing, health | `caption track: player API failed` warnings; nothing selected; new cues never appear                        |
| `.ytp-caption-segment` elements                                                                             | render check                  | overlay "YouTube 沒有顯示 AI 字幕" although captions look fine (then fix the selector)                      |
| `#movie_player.ad-showing`                                                                                  | pausing the checks during ads | fallback right after an ad                                                                                  |

YouTube's own tracks need a proof-of-origin token (`pot`) these days; headless agent-browser gets empty bodies for real tracks. Ours never reaches the network, so that does not matter here.

## Debugging in agent-browser

Load the extension as in the `test-extension-in-browser` skill. No Groq key is needed: seed cues into the cache from the popup page, or post them straight to the page script.

```bash
# Every 10 s the page script logs what the health check saw:
agent-browser --session $S console | grep "yt-ai-subs" | grep -E "caption track|display mode|falling"
#   caption track {"videoId":…,"inTracklist":true,"selected":true,"served":2,"expected":1,"shown":"…","events":40,"version":2,"servedVersion":2,"mode":"cc"}
```

- `inTracklist:false` → step 2 (look for `caption track added to the player response <id>`; the ID must be the video that plays, not only prefetched ones).
- `selected:true, served:0` → step 3 (the player did not request our URL; trace XHR/fetch to `/api/timedtext`).
- `version` ≠ `servedVersion` for long → step 4 (reload not happening).
- `expected:1` with `shown:""` → step 5 (renderer or selector changed).

Probe the player from the page (eval runs in the MAIN world):

```js
(() => {
  const p = document.getElementById("movie_player");
  return JSON.stringify({
    list: (p.getOption("captions", "tracklist") || []).map((t) => t.vss_id),
    track: p.getOption("captions", "track")?.vss_id,
    shown: [...document.querySelectorAll(".ytp-caption-segment")].map((e) => e.textContent),
  });
})();
```

Seed cached cues (on `chrome-extension://<id>/popup.html`; the key must match the current settings, see `cacheKey` in `src/content/cache.ts`; the content script loads it once audio for the video arrives, so play the video):

```js
(async () => {
  const cues = Array.from({ length: 40 }, (_, i) => ({
    start: 20 + i * 2.5,
    end: 22.2 + i * 2.5,
    original: `原文 ${i}`,
    translation: `翻譯 ${i}`,
  }));
  const key = "cache:aqz-KE-bpKQ:whisper-large-v3:ja:openai/gpt-oss-120b:zh-TW";
  await chrome.storage.local.set({
    [key]: { chunks: [{ start: 20, end: 120 }], cues, savedAt: Date.now() },
    cacheIndex: { [key]: Date.now() },
  });
})();
```

Or post events directly to the page script (on the YouTube tab; tests the reload path):

```js
window.postMessage(
  {
    __ytAiSubsToPage: true,
    type: "track-cues",
    videoId: "<id>",
    events: [{ tStartMs: 31000, dDurationMs: 2000, segs: [{ utf8: "測試" }] }],
  },
  location.origin,
);
```

Open the CC menu for a screenshot: `document.querySelector(".ytp-settings-button").click()`, then click the `.ytp-menuitem` whose text is "Subtitles/CC" (or "字幕").

Simulate a broken renderer to check the fallback: a `MutationObserver` on `#movie_player` that renames the `ytp-caption-segment` class makes the health check fail within ~3 s of a caption; expect `falling back to the overlay: YouTube 沒有顯示 AI 字幕`, the overlay, and our track deselected.

Test videos: `jNQXAC9IVRw` (has English and German tracks), `aqz-KE-bpKQ` (Big Buck Bunny, no captions at all). Remember the 20–40 s playback limit from the `test-extension-in-browser` skill: one fresh load per check.
