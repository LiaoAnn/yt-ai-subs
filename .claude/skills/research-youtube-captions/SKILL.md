---
name: research-youtube-captions
description: Use when you check whether YouTube videos or channels have captions good enough to serve as ground truth for this project's evaluation (speech timing, Whisper error rate, translation reference); says how to list caption tracks, fetch them, compare them with YouTube's automatic captions, and what to report.
---

# Research YouTube captions as evaluation ground truth

Read-only work: no Groq, no sign-in, no download of audio or video. Start the browser as the `test-extension-in-browser` skill says (normal user agent and `--disable-blink-features=AutomationControlled`, or YouTube stops playback); the extension itself is not needed.

## Never assume, open the video

Do not say a channel "has Japanese captions" from memory or from what a viewer saw: burned-in text (テロップ) and the CC menu's "日本語（自動生成）" look like captions but are not uploaded tracks. Every claim about a channel comes from tracks you listed, with a count (k of n videos).

## List the tracks

- `ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks` on the watch page: `languageCode`, `name`, `vssId`, `kind`, `baseUrl`.
- `kind: "asr"` is YouTube's automatic captions; a track without `kind` was uploaded by the creator.
- A video can have `zh` and `zh-TW` with the same text and times; check before counting them as two sources.

## Fetch a track

- The player loads tracks with an XHR to `/api/timedtext?…&fmt=json3…` that carries a `pot` token; a bare `baseUrl` may come back empty. Select a track in the player, take the URL of the request it sends, then change `lang=` and `kind=` to fetch the other tracks.
- During an ad the player sends no timedtext request: skip the ad first.
- json3: `events[].tStartMs`, `dDurationMs`, `segs[].utf8`; automatic tracks also have `segs[].tOffsetMs` (word times).

## Measure

- **Verbatim or not** (needed for Whisper's character error rate): compare the creator's track with the automatic track of the same language. Report a rough CER (punctuation and spaces removed) and the kinds of difference in a sample of about 10 lines: dropped fillers, rewording, merged sentences, `[音楽]`-style notes, narration cards in （） or 【】.
- **Timing**: for each creator line, the nearest automatic word start and end (within ±2 s); report the median and p90 of the absolute difference, the share over 0.5 s, and the median signed difference (some creators show lines early on purpose).
- **Gaps**: the distribution of gaps between consecutive lines. Lines that butt against each other (gap 0) say nothing about when speech ends, so they can measure speech recall but not precision.
- Recent videos (2026) often have automatic tracks where a whole sentence is one seg without `tOffsetMs` and a fixed 3 s length; flag every number that depends on them. Older automatic tracks are word-level and more trustworthy.

## What each kind of source can measure

- Creator track in the spoken language, close to verbatim: Whisper CER, speech recall, and precision if lines leave gaps.
- Creator translation track (for example the zh / ko / en tracks of @therolandshow1960): speech recall from line starts (allow about ±1 s) and a reference translation; no CER.
- Automatic tracks only: not ground truth.

## Data handling

Caption text is other people's work. Keep it only in your scratch folder while you compute, delete it afterwards, and keep only numbers, video IDs and at most 10 quoted lines as examples. Nothing of it goes into git.

## Report

A table per source: channel, content type, language, creator tracks (k of n videos), verbatim estimate, timing (median, p90), gaps, translation tracks, and which measurements it supports. List the candidates that turned out to have no usable track, too, so nobody checks them again. Keep measured results and inferences apart.
