---
name: debug-missing-captions
description: Use when captions are missing, late or stop for part of a video although the AI track is in the CC menu (or the overlay shows a status message); maps each status message and log line to the stage where a chunk stopped and says how to tell the causes apart.
---

# Debug captions that are missing for part of a video

If the AI track itself is missing from the CC menu or the overlay fallback is on, use `debug-caption-track` first. This skill is for the case where the track is there but a stretch of the video gets no lines.

## Reproduce both ways

A chunk's audio, and so every decision about it, depends on where the chunk starts. Always try **from the start** and **after a seek** into the gap (for example `&t=40s`). A problem that shows in only one of them points at chunk boundaries (voice detection, quiet cuts), not at the video.

Use a dry run first (`debugDryRun: true`, no key; see `test-extension-in-browser`): it shows every scheduling decision without calling Groq. Call Groq only with the user's OK.

## Status messages (overlay, top right)

Checked in this order (`src/content/index.ts`); nothing shows while an ad plays or before the settings load, and the "waiting" kinds only after 6 s of playback.

- `AI 字幕：請點擴充圖示填 Groq API key`: no key in the settings.
- `AI 字幕：<error>`: the video's last chunk or translation failed; the text is the error.
- `AI 字幕：今天的語音辨識額度用完了`: the Whisper daily budget is out; nothing is scheduled.
- `AI 字幕：沒掛上播放器，請重新整理頁面`: the page script did not report `page-ready`.
- `AI 字幕：找不到音訊，請重新整理頁面` / `有找到音訊但沒收到資料`: no audio `SourceBuffer`, or one that never got data.
- `AI 字幕：聽寫中…`: a chunk covering the playhead is in flight.
- `AI 字幕：這段沒有辨識到台詞`: the chunk under the playhead finished with no lines (skipped as no voice, or every line was filtered out).
- `AI 字幕：等待音訊…`: the playhead is in a stretch with no finished chunk yet (audio not buffered, or the chunk is still waiting to be scheduled).

## Log lines (`[yt-ai-subs]` in the tab's console)

- `no voice, skipped <start>–<end> s (voiced <n>%)`: voice detection (`src/content/voice.ts`) skipped the chunk; the threshold is 45%. A real talk chunk near 45% means the features do not fit this voice: measure them (`voiceFeatures`) against the speech times Whisper finds when the chunk is sent.
- `dry run <start>–<end> s (voiced <n>%)`: the same decision in a dry run; nothing is sent.
- `whisper <start>–<end> s (<n> s audio, cut at <dB> dB (pause))`: the chunk was sent; compare its lines with the gap. A chunk with audio but no lines was emptied by the hallucination filters (`src/background/segmentation.ts`); a debug capture shows Whisper's raw segments and why each was dropped.
- `translation <label>: <n> lines, <tokens> tokens, <ms> ms, waited <ms> ms for the rate limit`: long waits mean the limiter is the delay, not Whisper.
- `cancel <start>–<end> s (playhead <t> s)`: a seek made the chunk irrelevant.
- `chunk <label> failed:` / `translation <label> failed:`: the error that stopped it.
- `first caption <ms> ms after play/seek`: start-up latency.

## Cause by symptom

- Gap only after a seek, or only from the start: voice detection or the quiet cut at a chunk boundary.
- Gap with `whisper …` logged but no lines: hallucination filters dropped real speech (check `avg_logprob`, aligned words, repetition).
- Captions arrive late everywhere: the limiter (`waited … for the rate limit`), the quota (one chunk at a time when Whisper is low), or the chunk before (a chunk waits up to 5 s for it).
- Last line of a chunk missing: `trimCutSentence` dropped a line that ran into a cut outside a pause; the next chunk should start where it began.

## Fix and prove it

Add a unit test that fails on the old behaviour, and check the fix on the regression captures (the `test-extension-in-browser` skill, `.qa/`): no talk line may fall into a skipped chunk, and the BGM-only captures must stay free of made-up lines.
