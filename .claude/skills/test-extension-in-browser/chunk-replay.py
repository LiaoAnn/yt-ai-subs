#!/usr/bin/env python3
"""Sends the same audio chunks to Whisper again, to tell run-to-run variation from the
effect of a change (a prompt, a model). Runs on the VM host next to eval-collect.py; see the
test-extension-in-browser skill, section 8, "Replaying the same audio".

  QA_EXTENSION=<copy of dist/> QA_AD_SKIP=<test/ad-skip> \
  python3 -I chunk-replay.py record <session> <qa-dir> <out-dir> <id>...
      plays each video's capture range (<qa-dir>/whisper/<id>.json and, if present, every
      <qa-dir>/*/whisper/<id>.json) at 2x with fake Groq replies (no Groq call) and saves
      the WAV of every chunk the extension sends, with the fake run's chunk times
  python3 -I chunk-replay.py cut <qa-dir> <out-dir> <id>...
      cuts the chunks of every capture of <id> out of the recorded audio, checks each cut
      against the capture's loudness envelope, writes <out-dir>/chunks/<id>/index.json and
      copies the WAVs into $QA_EXTENSION/replay/<id>/ (the popup page fetches them there)
  QA_EXTENSION=... QA_AD_SKIP=... \
  python3 -I chunk-replay.py send <session> <jobs.json> <results.jsonl> <max requests> <max audio s>
      sends each job through the extension's background (popup page, real key, the real
      limiter); jobs: [{"id", "vid", "lang", "file": "<id>/<run>-<start>.wav", "seconds",
      "context"}]; a job already in results.jsonl is skipped. Stops at the caps, at an
      error, or when Groq reports under 30% of the daily Whisper requests left. The caps
      count jobs: the background retries a 429 up to twice, so keep them a little under
      the budget.

Holds other people's audio and text: keep <out-dir> in .qa/ or a scratchpad, never in git.
"""
import array, glob, importlib.util, json, math, os, re, shutil, struct, subprocess, sys, time

sys.dont_write_bytecode = True  # importing eval-collect.py must not leave __pycache__ in the repo
HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("eval_collect", os.path.join(HERE, "eval-collect.py"))
ec = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ec)
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
SR = 16000


class RecordingBrowser(ec.Browser):
    """eval-collect's browser with Groq unresolvable and fake-groq.mjs saving request bodies."""

    def __init__(self, session, out):
        super().__init__(session)
        self.out = out
        self.fake = None

    def start(self):
        self.ab("close")
        while True:
            n = subprocess.run(["pgrep", "-c", "-f", "^/home/dev/.agent-browser/browsers/[^ ]*/chrome --remote-debugging-port"],
                               capture_output=True, text=True).stdout.strip() or "0"
            if int(n) < 3 and ec.mem_available_mb() >= 3000:
                break
            ec.log("waiting for room: browsers", n, "memory", ec.mem_available_mb())
            time.sleep(60)
        self.ab("--extension", ec.EXT_DIR, "--extension", ec.AD_SKIP_DIR, "--user-agent", ec.UA, "--args",
                "--no-sandbox,--disable-blink-features=AutomationControlled,--host-resolver-rules=MAP api.groq.com ~NOTFOUND",
                "open", "chrome://extensions", timeout=180)
        time.sleep(2)
        items = self.eval("JSON.stringify([...document.querySelector('extensions-manager').shadowRoot"
                          ".querySelector('extensions-item-list').shadowRoot"
                          ".querySelectorAll('extensions-item')].map(e => [e.id, e.shadowRoot.querySelector('#name')?.textContent]))")
        self.ext_id = next(i for i, name in items if (name or "").strip() == "YT AI Subs")
        cdp, _, _ = self.ab("get", "cdp-url")
        os.makedirs(f"{self.out}/bodies", exist_ok=True)
        with open(f"{self.out}/control.json", "w") as f:
            json.dump({"delayMs": 0, "whisper": {"remaining": 1900, "limit": 2000}, "chat": {"remaining": 900, "limit": 1000}}, f)
        self.fake = subprocess.Popen(["node", f"{REPO}/test/fake-groq/fake-groq.mjs", cdp, f"{self.out}/control.json",
                                      f"{self.out}/fake-log.jsonl", f"{self.out}/bodies"])
        time.sleep(3)
        self.ab("open", f"chrome-extension://{self.ext_id}/popup.html")
        self.ab("tab", "new", "about:blank")
        ec.log("browser up", self.s, self.ext_id)

    def stop(self):
        if self.fake:
            self.fake.terminate()
            time.sleep(1)
        self.ab("close")


def capture_files(qa, vid):
    return [p for p in [f"{qa}/whisper/{vid}.json", *sorted(glob.glob(f"{qa}/*/whisper/{vid}.json"))] if os.path.exists(p)]


def record(session, qa, out, ids):
    b = RecordingBrowser(session, out)
    b.start()
    try:
        for vid in ids:
            if os.path.exists(f"{out}/{vid}.recorded.json"):
                continue
            caps = [c for p in capture_files(qa, vid) for c in json.load(open(p))["captures"].values() if c.get("sentSeconds")]
            lo = min(c["start"] for c in caps)
            hi = max(c["start"] + c["sentSeconds"] for c in caps)
            # A fake key: every Groq request goes to fake-groq.mjs (and Groq does not resolve).
            b.set_settings({"enabled": True, "groqApiKey": "fake-key-for-chunk-replay", "sourceLanguage": caps[0]["sourceLanguage"],
                            "whisperModel": caps[0]["whisperModel"], "translate": False,
                            "debugCapture": True, "debugDryRun": False, "debugForceWhisper": True})
            b.clear_cache(vid)
            with open(f"{out}/fake-log.jsonl", "a") as f:
                f.write(json.dumps({"event": "video", "videoId": vid}) + "\n")
            ec.log(vid, "open", round(lo, 1), round(hi, 1))
            problem = ec.open_video(b, vid, max(0, lo - 1))
            if problem:
                ec.log(vid, "FAILED:", problem)
                if problem == "sorry":
                    break
                continue
            # Fake replies cost nothing: play past the end, so chunks cover the whole range.
            ec.play_range(b, max(0, lo - 1), hi + 3, 2, wall_limit=(hi - lo) + 120)
            b.popup()
            last, stable = -1, 0
            for _ in range(60):
                time.sleep(5)
                n = b.eval("chrome.storage.local.get(null).then(all => Object.keys(all).filter(k => k.startsWith(%s)).length)"
                           % json.dumps(f"debug:{vid}:"))
                stable = stable + 1 if n == last else 0
                last = n
                if stable >= 3:
                    break
            b.eval("chrome.storage.local.get('settings').then(s => chrome.storage.local.set({settings: {...s.settings, enabled: false}})).then(() => 'off')")
            b.page()
            data = b.export(vid)
            chunks = {k: {f: v[f] for f in ("start", "sentSeconds", "envelope")} for k, v in data.items()}
            spans = sorted((c["start"], c["start"] + c["sentSeconds"]) for c in chunks.values())
            ec.log(vid, "chunks", len(chunks), "from", spans[0][0] if spans else None, "to", round(spans[-1][1], 2) if spans else None)
            ec.save(f"{out}/{vid}.recorded.json", chunks)
            b.ab("console", "--clear")
            b.ab("open", "about:blank")
            time.sleep(5)
    finally:
        b.set_settings({"groqApiKey": ""})
        b.stop()


def multipart_file(path):
    data = open(path, "rb").read()
    boundary = data.split(b"\r\n", 1)[0]
    for part in data.split(boundary)[1:]:
        head, _, body = part.partition(b"\r\n\r\n")
        if b'name="file"' in head:
            return body[:-2]
    raise ValueError(f"no file part in {path}")


def pcm(wav):
    i = wav.find(b"data")
    n = struct.unpack("<I", wav[i + 4:i + 8])[0]
    a = array.array("h")
    a.frombytes(wav[i + 8:i + 8 + n])
    return a


def envelope(a):
    """dBFS per 20 ms, as energyEnvelope (src/content/energy.ts)."""
    out = []
    for i in range(0, len(a) - 319, 320):
        rms = math.sqrt(sum(x * x for x in a[i:i + 320]) / 320) / 32768
        out.append(max(-100, round(20 * math.log10(rms or 1e-10))))
    return out


def wav_bytes(a):
    raw = a.tobytes()
    return (b"RIFF" + struct.pack("<I", 36 + len(raw)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, SR, SR * 2, 2, 16)
            + b"data" + struct.pack("<I", len(raw)) + raw)


def cut(qa, out, ids):
    groups, cur = {}, None
    for line in open(f"{out}/fake-log.jsonl"):
        e = json.loads(line)
        if e["event"] == "video":
            cur = e["videoId"]
            groups[cur] = []
        elif e["event"] == "saved" and cur:
            groups[cur].append(e["name"])
    for vid in ids:
        recorded = sorted(json.load(open(f"{out}/{vid}.recorded.json")).values(), key=lambda c: c["start"])
        bodies = [pcm(multipart_file(f"{out}/bodies/{n}")) for n in groups.get(vid, [])]
        # Concurrent requests can arrive out of order: match recorded chunks to bodies by
        # length, and among equal lengths by the recorded envelope.
        timeline, used = [], set()
        envelopes = [envelope(a) for a in bodies]

        def distance(j, ref):
            return sum(abs(x - y) for x, y in zip(envelopes[j], ref)) / max(1, len(ref))

        for c in recorded:
            if not c.get("sentSeconds"):
                continue  # skipped by voice detection in the fake run: no audio was sent
            n = round(c["sentSeconds"] * SR)
            fits = [j for j, a in enumerate(bodies) if j not in used and abs(len(a) - n) <= 2]
            j = min(fits, key=lambda j: distance(j, c["envelope"])) if fits else None
            if j is None:
                print(vid, "no recorded audio for the chunk at", c["start"])
                continue
            used.add(j)
            timeline.append((c["start"], bodies[j]))
        timeline.sort(key=lambda t: t[0])

        def take(start, seconds):
            got, t, need = array.array("h"), start, round(seconds * SR)
            while len(got) < need:
                seg = next(((s, a) for s, a in timeline if s <= t + 1e-6 and t < s + len(a) / SR - 1e-6), None)
                if not seg:
                    return None
                s, a = seg
                off = round((t - s) * SR)
                part = a[off:off + need - len(got)]
                got.extend(part)
                t = s + (off + len(part)) / SR
            return got

        dest = f"{ec.EXT_DIR}/replay/{vid}" if ec.EXT_DIR else None
        os.makedirs(f"{out}/chunks/{vid}", exist_ok=True)
        if dest:
            os.makedirs(dest, exist_ok=True)
        index = []
        for path in capture_files(qa, vid):
            run = "cur" if path == f"{qa}/whisper/{vid}.json" else os.path.basename(os.path.dirname(os.path.dirname(path)))
            for c in sorted(json.load(open(path))["captures"].values(), key=lambda c: c["start"]):
                if not c.get("sentSeconds"):
                    continue
                a = take(c["start"], c["sentSeconds"])
                if a is None:
                    # Voice detection skips a stretch without voice, so the fake run sent no audio there.
                    print(f"  {vid} {run} {c['start']:.2f}: not in the recorded audio (a stretch the fake run skipped?), skipped")
                    continue
                mine, theirs = envelope(a), c.get("envelope") or []
                if not theirs or abs(len(mine) - len(theirs)) > 1:
                    print(f"  {vid} {run} {c['start']:.2f}: envelope of {len(theirs)} frames, cut has {len(mine)}: not compared, skipped")
                    continue
                diffs = [abs(x - y) for x, y in zip(mine, theirs) if x > -90 or y > -90]
                if not diffs:
                    print(f"  {vid} {run} {c['start']:.2f}: silent throughout, cannot be checked, skipped")
                    continue
                mean = sum(diffs) / len(diffs)
                name = f"{run}-{c['start']:.2f}.wav"
                with open(f"{out}/chunks/{vid}/{name}", "wb") as f:
                    f.write(wav_bytes(a))
                if dest:
                    shutil.copy(f"{out}/chunks/{vid}/{name}", f"{dest}/{name}")
                index.append({"run": run, "start": c["start"], "sentSeconds": c["sentSeconds"], "file": f"{vid}/{name}",
                              "lang": c["sourceLanguage"], "context": c["context"], "envelopeDiffDb": round(mean, 2), "raw": c["raw"]})
                flag = "" if mean < 0.5 else "  <- NOT the same audio"
                print(f"  {vid} {run:8} {c['start']:7.2f} {c['sentSeconds']:6.2f} s  envelope |diff| {mean:.2f} dB{flag}")
        ec.save(f"{out}/chunks/{vid}/index.json", index)


def send(session, jobs_path, results_path, max_requests, max_audio):
    jobs = json.load(open(jobs_path))
    done = set()
    if os.path.exists(results_path):
        done = {json.loads(l)["id"] for l in open(results_path)}
    b = ec.Browser(session)
    b.start()
    b.set_settings({"enabled": False, "translate": False, "debugCapture": True}, with_key=True)
    b.popup()
    requests, audio = 0, 0.0
    try:
        for j in jobs:
            if j["id"] in done:
                continue
            cost = max(10.0, j["seconds"])  # Groq bills at least 10 s
            if requests + 1 > max_requests or audio + cost > max_audio:
                ec.log("cap reached", requests, round(audio))
                break
            b.eval("chrome.storage.local.get('settings').then(s => chrome.storage.local.set({settings: {...s.settings, "
                   "sourceLanguage: %s, whisperModel: %s}})).then(() => 'ok')" % (json.dumps(j["lang"]), json.dumps(j.get("model", "whisper-large-v3"))))
            # The background's own transcribe path: the key never leaves it, the limiter applies.
            js = """(async () => { const r = await fetch(chrome.runtime.getURL(%s)); const buf = new Uint8Array(await r.arrayBuffer());
 let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
 const reply = await chrome.runtime.sendMessage({type: 'transcribe', requestId: %s, videoId: %s, wavBase64: btoa(s), durationSeconds: %f, context: %s});
 const server = (await chrome.storage.session.get('rateLimiter')).rateLimiter?.server ?? null;
 return JSON.stringify({reply, server}); })()""" % (json.dumps("replay/" + j["file"]), json.dumps(j["id"]), json.dumps(j["vid"]),
                                                    j["seconds"], json.dumps(j["context"]))
            result = b.eval(js, timeout=180)
            requests += 1
            audio += cost
            reply, server = result["reply"], result["server"] or {}
            with open(results_path, "a") as f:
                f.write(json.dumps({"id": j["id"], "ok": reply.get("ok"), "error": reply.get("error"), "raw": reply.get("raw")},
                                   ensure_ascii=False) + "\n")
            daily = (server.get("whisper") or {}).get("requests") or {}
            ec.log(j["id"], "ok" if reply.get("ok") else reply.get("error"), "requests", requests, "audio", round(audio), "daily", daily)
            if not reply.get("ok"):
                break
            if daily.get("limit") and daily["remaining"] < 0.3 * daily["limit"]:
                ec.log("daily Whisper requests under 30%, stopping")
                break
            time.sleep(2)
    finally:
        ec.log("USED", requests, "requests", round(audio), "s audio")
        b.set_settings({"groqApiKey": ""})
        b.ab("close")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "record" and len(sys.argv) >= 6 and ec.EXT_DIR and ec.AD_SKIP_DIR:
        record(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:])
    elif mode == "cut" and len(sys.argv) >= 5:
        cut(sys.argv[2], sys.argv[3], sys.argv[4:])
    elif mode == "send" and len(sys.argv) == 7 and ec.EXT_DIR and ec.AD_SKIP_DIR:
        send(sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5]), float(sys.argv[6]))
    else:
        sys.exit(__doc__)
