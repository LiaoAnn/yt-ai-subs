#!/usr/bin/env python3
"""Picks a Whisper window per video from its ground truth: the 180 s stretch (inside the
dry-run range) with the most speech, preferring one that also holds a pause of 8 s or more.

  python3 -I eval-plan.py <qa-dir> <ids-file> <translate-ids,comma-separated> > plan.json
"""
import json, os, sys

WINDOW = 180
LIMIT = 480


def lines_of(track):
    out = []
    for e in (track.get("json") or {}).get("events", []):
        text = "".join(s.get("utf8", "") for s in e.get("segs", []))
        if not text.strip() or "tStartMs" not in e or e.get("aAppend"):
            continue
        s = e["tStartMs"] / 1000
        out.append((s, s + e.get("dDurationMs", 0) / 1000, text))
    return out


def dataset_languages(root):
    """videoId -> spoken language, from src/qa/dataset.ts (next to the .qa folder)."""
    import re
    text = open(os.path.join(os.path.dirname(os.path.abspath(root)), "src/qa/dataset.ts")).read()
    return dict(re.findall(r'videoId: "([^"]+)",\s*language: "(ja|ko)"', text))


def main():
    root, ids_file, translate = sys.argv[1], sys.argv[2], set(sys.argv[3].split(","))
    languages = dataset_languages(root)
    plan = []
    for vid in open(ids_file).read().split():
        path = f"{root}/gt/{vid}.json"
        if not os.path.exists(path):
            print("no gt", vid, file=sys.stderr)
            continue
        gt = json.load(open(path))
        tracks = gt.get("tracks", [])
        asr = next((t for t in tracks if t.get("kind") == "asr"), None)
        language = languages.get(vid)
        if not language:
            print("not in src/qa/dataset.ts", vid, file=sys.stderr)
            continue
        creator = next((t for t in tracks if not t.get("kind") and t["languageCode"].split("-")[0] == language), None)
        creator = creator or next((t for t in tracks if not t.get("kind")), None) or asr
        spans = [(s, e) for s, e, text in lines_of(creator)] if creator else []
        if asr:
            spans += [(s, min(e, s + 4)) for s, e, text in lines_of(asr) if "[" not in text]
        length = min(LIMIT, gt.get("lengthSeconds") or LIMIT)
        best = None
        for start in range(0, int(max(0, length - WINDOW)) + 1, 10):
            end = start + WINDOW
            inside = sorted((max(s, start), min(e, end)) for s, e in spans if e > start and s < end)
            talk, last, pause = 0.0, start, 0.0
            for s, e in inside:
                if s > last:
                    pause = max(pause, s - last)
                talk += max(0, e - max(s, last))
                last = max(last, e)
            pause = max(pause, end - last)
            score = talk + (20 if pause >= 8 else 0)
            if best is None or score > best[0]:
                best = (score, start, end)
        if not best:
            best = (0, 0, min(WINDOW, length))
        plan.append({"videoId": vid, "language": language, "start": best[1], "end": best[2],
                     "translate": vid in translate, "score": round(best[0])})
    json.dump(plan, sys.stdout, indent=1)


main()
