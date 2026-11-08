#!/usr/bin/env python3
"""Collects the evaluation set (src/qa/dataset.ts) with agent-browser and the extension:
creator caption tracks as ground truth, dry-run captures (voice features), Whisper captures.
Runs on the VM host (agent-browser is a host tool). See the test-extension-in-browser skill,
section "Evaluation set", for when and how.

  QA_EXTENSION=<copy of dist/> QA_AD_SKIP=<test/ad-skip> \
  python3 -I eval-collect.py dry <session> <qa-dir> <id>...       ground truth + dry run 0-480 s at 2x
  python3 -I eval-collect.py gt <session> <qa-dir> <id>...        ground truth only (retries)
  python3 -I eval-collect.py whisper <session> <qa-dir> <plan.json>  Whisper runs (eval-plan.py)

Writes <qa-dir>/gt/<id>.json, dry/<id>.json, whisper/<id>.json (other people's captions:
.qa/ is gitignored). Never prints the Groq key: it goes from the key file into the popup
page through stdin, and only its length comes back. Pacing: one page load per video.
"""
import json, os, subprocess, sys, time

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36"
# A copy of dist/, so a rebuild during a long run cannot change the extension under it.
EXT_DIR = os.environ.get("QA_EXTENSION", "")
AD_SKIP_DIR = os.environ.get("QA_AD_SKIP", "")
KEY_FILE = "/home/dev/.local/state/yt-ai-subs/groq-key"
DRY_SECONDS = 480
DRY_RATE = 2
# Seconds before a Whisper window's end at which playback stops (the scheduler's lead).
LOOKAHEAD = 80


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


class Browser:
    def __init__(self, session):
        self.s = session
        self.ext_id = None
        self.audio = {}

    def ab(self, *args, stdin=None, timeout=120):
        r = subprocess.run(["agent-browser", "--session", self.s, *args], input=stdin,
                           capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip(), r.returncode, r.stderr.strip()

    def eval(self, js, timeout=120):
        out, code, err = self.ab("eval", "--stdin", stdin=js, timeout=timeout)
        if code != 0:
            raise RuntimeError(f"eval failed: {err[:300]} {out[:300]}")
        try:
            v = json.loads(out)
        except json.JSONDecodeError:
            return out
        if isinstance(v, str):
            try:
                return json.loads(v)
            except json.JSONDecodeError:
                return v
        return v

    def start(self):
        self.ab("close")
        # The dev VM is shared: open a browser only while fewer than 3 agent-browser
        # Chromes run and at least 3 GB is free.
        while True:
            n = subprocess.run(["pgrep", "-c", "-f", "^/home/dev/.agent-browser/browsers/[^ ]*/chrome --remote-debugging-port"],
                               capture_output=True, text=True).stdout.strip() or "0"
            if int(n) < 3 and mem_available_mb() >= 3000:
                break
            log("waiting for room: browsers", n, "memory", mem_available_mb())
            time.sleep(60)
        out, code, err = self.ab("--extension", EXT_DIR, "--extension", AD_SKIP_DIR, "--user-agent", UA, "--args",
                                 "--no-sandbox,--disable-blink-features=AutomationControlled",
                                 "open", "chrome://extensions", timeout=180)
        time.sleep(2)
        items = self.eval("JSON.stringify([...document.querySelector('extensions-manager').shadowRoot"
                          ".querySelector('extensions-item-list').shadowRoot"
                          ".querySelectorAll('extensions-item')].map(e => [e.id, e.shadowRoot.querySelector('#name')?.textContent]))")
        self.ext_id = next(i for i, name in items if (name or "").strip() == "YT AI Subs")
        self.ab("open", f"chrome-extension://{self.ext_id}/popup.html")
        self.ab("tab", "new", "about:blank")
        log("browser up", self.s, self.ext_id)

    def popup(self):
        self.ab("tab", "t1")

    def page(self):
        self.ab("tab", "t2")

    def set_settings(self, settings, with_key=False):
        self.popup()
        js = ("chrome.storage.local.get('settings').then(s => chrome.storage.local.set({settings: "
              "{...(s.settings||{}), ...%s}})).then(() => 'ok')" % json.dumps(settings))
        self.eval(js)
        if with_key:
            # The key goes straight from the file into the page; it is never printed.
            p = subprocess.run(
                ["python3", "-I", "-c",
                 "import json,sys; k=open(sys.argv[1]).read().strip(); "
                 "print(\"chrome.storage.local.get('settings').then(s => chrome.storage.local.set("
                 "{settings: {...s.settings, groqApiKey: %s}})).then(() => chrome.storage.local.get('settings')).then(s => 'key length ' + s.settings.groqApiKey.length)\" % json.dumps(k))",
                 KEY_FILE], capture_output=True, text=True)
            out, code, err = self.ab("eval", "--stdin", stdin=p.stdout)
            log("key:", out if out.startswith('"key length') else "FAILED")
        self.page()

    def export(self, video_id, prefix="debug:"):
        self.popup()
        js = ("chrome.storage.local.get(null).then(async all => { const e = Object.entries(all)"
              ".filter(([k]) => k.startsWith(%s)); await chrome.storage.local.remove(e.map(([k]) => k));"
              " return JSON.stringify(Object.fromEntries(e)); })" % json.dumps(f"{prefix}{video_id}:"))
        data = self.eval(js, timeout=180)
        self.page()
        return data

    def clear_cache(self, video_id):
        self.popup()
        self.eval("chrome.storage.local.get(null).then(all => chrome.storage.local.remove(Object.keys(all)"
                  ".filter(k => k.startsWith('cache:%s:') || k.startsWith('cachemeta:%s:')))).then(() => 'ok')"
                  % (video_id, video_id))
        self.page()

    def rate_limits(self):
        self.popup()
        v = self.eval("chrome.storage.session.get('rateLimiter').then(s => JSON.stringify(s.rateLimiter?.server ?? null))")
        self.page()
        return v


PLAYER_STATE = """(() => { const p = document.getElementById('movie_player'); const v = document.querySelector('video');
 if (!p || !v) return JSON.stringify({ready: false});
 const ad = p.classList.contains('ad-showing');
 if (ad) { const b = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, button[id^=skip-button]'); if (b) b.click(); v.muted = true; if (v.paused) v.play(); }
 const err = document.querySelector('.ytp-error')?.innerText ?? '';
 return JSON.stringify({ready: true, ad, t: v.currentTime, paused: v.paused, ended: v.ended, rate: v.playbackRate, err, vis: document.visibilityState,
   sorry: location.href.includes('google.com/sorry')}); })()"""

GT_JS = r"""(() => { window.__gt = null; (async () => {
 const sleep = ms => new Promise(r => setTimeout(r, ms));
 const p = document.getElementById('movie_player'); const r = p.getPlayerResponse();
 const all = (r.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []).filter(t => !String(t.vssId).includes('ytaisubs'));
 const vd = r.videoDetails ?? {};
 const meta = {videoId: vd.videoId, title: vd.title, author: vd.author, channelId: vd.channelId, lengthSeconds: Number(vd.lengthSeconds),
   publishDate: r.microformat?.playerMicroformatRenderer?.publishDate, fetchedAt: new Date().toISOString(),
   trackList: all.map(t => ({languageCode: t.languageCode, kind: t.kind ?? null, vssId: t.vssId, name: t.name?.simpleText ?? t.name?.runs?.[0]?.text}))};
 try { performance.setResourceTimingBufferSize(20000); } catch {}
 // The extension answers some timedtext requests itself, so they never reach the network:
 // record the URLs the player opens, too.
 if (!window.__ttUrls) {
   window.__ttUrls = [];
   const open = XMLHttpRequest.prototype.open;
   XMLHttpRequest.prototype.open = function (method, u, ...rest) {
     try { const s = String(u); if (s.includes('/api/timedtext')) window.__ttUrls.push(new URL(s, location.origin).href); } catch {}
     return open.call(this, method, u, ...rest);
   };
 }
 const find = () => [...window.__ttUrls, ...performance.getEntriesByType('resource').map(e => e.name)]
   .find(n => n.includes('/api/timedtext') && /[?&]pot=/.test(n));
 let url = find();
 if (!url && all.length) {
   try { p.loadModule('captions'); } catch {}
   const real = all.filter(t => !t.kind);
   for (let k = 0; k < 4 && !url; k++) {
     const tl = p.getOption('captions', 'tracklist') ?? [];
     const cur = p.getOption('captions', 'track')?.vss_id;
     // switch to a real track other than the current one, so the player sends a request
     const want = real.map(t => t.vssId).find(v => v !== cur) ?? all[0].vssId;
     const opt = tl.find(x => x.vss_id === want) ?? tl.find(x => !String(x.vss_id).includes('ytaisubs'));
     if (opt) p.setOption('captions', 'track', opt);
     for (let i = 0; i < 20 && !url; i++) { await sleep(250); url = find(); }
     if (!url) { try { p.setOption('captions', 'reload', true); } catch {} for (let i = 0; i < 20 && !url; i++) { await sleep(250); url = find(); } }
   }
 }
 if (!url) return JSON.stringify({...meta, error: all.length ? 'no timedtext url' : 'no tracks', tracks: []});
 const pot = new URL(url).searchParams.get('pot');
 const wanted = /^(ja|ko|zh|zh-Hant|zh-TW|zh-HK|zh-Hans|zh-CN|en|en-US|en-GB)$/;
 const tracks = [];
 for (const t of all) {
   if (!t.kind && !wanted.test(t.languageCode)) continue;
   if (t.kind && !/^(ja|ko)$/.test(t.languageCode)) continue;
   const u = new URL(t.baseUrl, location.origin);
   u.searchParams.set('fmt', 'json3'); u.searchParams.set('pot', pot); u.searchParams.set('potc', '1'); u.searchParams.set('c', 'WEB');
   let text = '';
   try { text = await (await fetch(u)).text(); } catch (e) { text = ''; }
   if (!text) { // fall back to the player's own URL with lang/kind changed
     const v = new URL(url); v.searchParams.delete('variant'); v.searchParams.set('lang', t.languageCode);
     if (t.kind) v.searchParams.set('kind', t.kind); else v.searchParams.delete('kind');
     v.searchParams.delete('name'); if (t.name?.simpleText && String(t.vssId).split('.').length > 2) v.searchParams.set('name', String(t.vssId).split('.').slice(2).join('.'));
     try { text = await (await fetch(v)).text(); } catch (e) { text = ''; }
   }
   let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
   tracks.push({languageCode: t.languageCode, kind: t.kind ?? null, vssId: t.vssId, name: t.name?.simpleText, bytes: text.length, json});
   await sleep(1500);
 }
 return JSON.stringify({...meta, tracks});
})().then(v => { window.__gt = v; }, e => { window.__gt = JSON.stringify({error: String(e), tracks: []}); }); return "started"; })()"""


AUDIO_JS = """(() => { const p = document.getElementById('movie_player');
 // The track objects are minified: find the part with isAutoDubbed by shape, not by name.
 const info = t => { const o = t && Object.values(t).find(v => v && typeof v === 'object' && 'isAutoDubbed' in v) || {};
   return {name: o.name ?? null, isDefault: !!o.isDefault, isAutoDubbed: !!o.isAutoDubbed}; };
 const list = p?.getAvailableAudioTracks?.() ?? [];
 const cur = p?.getAudioTrack?.();
 const out = {tracks: list.map(info), current: cur ? info(cur) : null, switched: false};
 if (%s && out.current?.isAutoDubbed) {
   const orig = list.find(t => /original/i.test(info(t).name ?? '')) ?? list.find(t => !info(t).isAutoDubbed);
   if (orig) { p.setAudioTrack(orig); out.switched = true; }
 }
 return JSON.stringify(out); })()"""


def audio_state(b, switch):
    """YouTube auto-dubs some videos (an English AI voice for an English browser): the
    extension would hear the dub. Reports the audio tracks; with `switch`, selects the
    original when the current track is auto-dubbed."""
    try:
        return b.eval(AUDIO_JS % ("true" if switch else "false"))
    except Exception as e:
        return {"error": str(e)[:200]}


def wait_ready(b, tries=40):
    for _ in range(tries):
        try:
            st = b.eval(PLAYER_STATE)
            if isinstance(st, dict) and st.get("ready"):
                return st
        except Exception as e:
            log("state error", e)
        time.sleep(1)
    return None


def clear_ads(b, limit=150):
    """Waits (muted) until no ad shows; clicks skip when it appears."""
    t0 = time.time()
    while time.time() - t0 < limit:
        st = b.eval(PLAYER_STATE)
        if not st.get("ad"):
            return True
        time.sleep(2)
    return False


def play_range(b, start, end, rate, wall_limit):
    """Plays [start, end] muted at `rate`; returns the last state."""
    b.eval("(() => { const p = document.getElementById('movie_player'); const v = document.querySelector('video');"
           " v.muted = true; p.seekTo(%f, true); v.playbackRate = %f; v.play(); return 1; })()" % (start, rate))
    t0 = time.time()
    last_t, last_move = -1, time.time()
    st = {}
    while time.time() - t0 < wall_limit:
        time.sleep(4)
        st = b.eval(PLAYER_STATE)
        if st.get("sorry"):
            return st
        if st.get("ad"):
            continue
        if st.get("rate") != rate or st.get("paused"):
            b.eval("(() => { const v = document.querySelector('video'); v.muted = true; v.playbackRate = %f; v.play(); return 1; })()" % rate)
        t = st.get("t", 0)
        if t >= end or st.get("ended"):
            break
        if abs(t - last_t) > 0.5:
            last_t, last_move = t, time.time()
        elif time.time() - last_move > 40:
            log("stalled at", t, st.get("err"), st.get("vis"))
            b.eval("(() => { const p = document.getElementById('movie_player'); const v = document.querySelector('video'); p.seekTo(%f, true); v.play(); return 1; })()" % (t + 1))
            last_move = time.time()
    b.eval("(() => { const v = document.querySelector('video'); v.pause(); return 1; })()")
    return st


def mem_available_mb():
    for line in open("/proc/meminfo"):
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) // 1024
    return 0


def open_video(b, vid, start=0):
    # Shared VM: wait while memory is short.
    while mem_available_mb() < 2500:
        log("low memory, waiting", mem_available_mb())
        time.sleep(60)
    b.page()
    url = f"https://www.youtube.com/watch?v={vid}" + (f"&t={int(start)}s" if start else "")
    out, code, err = b.ab("open", url, timeout=120)
    if "google.com/sorry" in out:
        return "sorry"
    b.ab("wait", "--load", "load", timeout=60)
    st = wait_ready(b)
    if not st:
        return "no player"
    if st.get("sorry"):
        return "sorry"
    b.eval("(() => { const v = document.querySelector('video'); v.muted = true; v.play(); return 1; })()")
    if not clear_ads(b):
        return "ad did not end"
    b.audio = audio_state(b, switch=True)
    if b.audio.get("switched"):
        # The extension has already stored some dubbed audio: load the page again. YouTube
        # keeps the choice for the session (1 of 1 checked); check, and switch again if not.
        log(vid, "auto-dubbed audio", b.audio.get("current"), "-> original, reloading")
        b.ab("reload", timeout=120)
        b.ab("wait", "--load", "load", timeout=60)
        if not wait_ready(b):
            return "no player after reload"
        b.eval("(() => { const v = document.querySelector('video'); v.muted = true; v.play(); return 1; })()")
        if not clear_ads(b):
            return "ad did not end"
        again = audio_state(b, switch=True)
        again["reloaded"] = True
        b.audio = again
        if again.get("switched"):
            log(vid, "still dubbed after reload; switched again without reload")
    if (b.audio.get("current") or {}).get("isAutoDubbed") and not b.audio.get("switched"):
        return "dubbed audio, no original track"
    return None


def save(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, ensure_ascii=False)


def audio_check(session, root, ids):
    """Lists each video's audio tracks (auto-dubbed or not) into <root>/audio.json; no capture."""
    b = Browser(session)
    b.start()
    path = f"{root}/audio.json"
    out = json.load(open(path)) if os.path.exists(path) else {}
    for vid in ids:
        if vid in out:
            continue
        b.page()
        b.ab("open", f"https://www.youtube.com/watch?v={vid}", timeout=120)
        b.ab("wait", "--load", "load", timeout=60)
        st = wait_ready(b)
        if not st or st.get("sorry"):
            log(vid, "FAILED:", "sorry" if st else "no player")
            if st and st.get("sorry"):
                break
            continue
        clear_ads(b)
        out[vid] = audio_state(b, switch=False)
        log(vid, json.dumps(out[vid], ensure_ascii=False))
        save(path, out)
        time.sleep(25)  # pace page loads: YouTube shows a CAPTCHA after a few dozen quickly
    b.ab("close")


def dry(session, root, ids, gt_only=False):
    b = Browser(session)
    b.start()
    b.set_settings({"enabled": True, "groqApiKey": "", "translate": False, "debugCapture": True, "debugDryRun": True, "debugForceWhisper": True})
    failed = []
    for vid in ids:
        gt_path = f"{root}/gt/{vid}.json"
        dry_path = f"{root}/dry/{vid}.json"
        if os.path.exists(gt_path) and (gt_only or os.path.exists(dry_path)):
            log(vid, "done already")
            continue
        log(vid, "open")
        problem = open_video(b, vid)
        if problem:
            log(vid, "FAILED:", problem)
            failed.append((vid, problem))
            if problem == "sorry":
                break
            continue
        if not os.path.exists(gt_path):
            b.eval(GT_JS)
            gt = None
            for _ in range(120):
                time.sleep(2)
                gt = b.eval("window.__gt ?? 'pending'", timeout=120)
                if gt != "pending":
                    break
            if not isinstance(gt, dict):
                log(vid, "GT FAILED", str(gt)[:200])
                failed.append((vid, "gt eval"))
            else:
                empty = [t["vssId"] for t in gt["tracks"] if not t.get("json")]
                log(vid, gt.get("author"), gt.get("lengthSeconds"), "tracks", [t["vssId"] for t in gt["tracks"]],
                    "empty", empty, gt.get("error", ""))
                save(gt_path, gt)
                if empty or gt.get("error"):
                    failed.append((vid, f"gt empty {empty} {gt.get('error', '')}"))
        if not gt_only and not os.path.exists(dry_path):
            length = b.eval("document.querySelector('video').duration") or DRY_SECONDS
            end = min(DRY_SECONDS, float(length) - 1)
            st = play_range(b, 0, end, DRY_RATE, wall_limit=end / DRY_RATE * 2 + 90)
            if st.get("sorry"):
                failed.append((vid, "sorry during play"))
                break
            time.sleep(10)
            data = b.export(vid)
            log(vid, "dry chunks", len(data), "last t", st.get("t"))
            save(dry_path, {"videoId": vid, "end": end, "audio": b.audio, "captures": data})
        time.sleep(5)
    log("FAILED LIST", json.dumps(failed))
    b.ab("close")


# A 429 from Groq, as the extension logs it ("Groq 429 on whisper", "語音辨識失敗 429"), not
# a 429 in some number of a state line.
TOO_MANY = __import__("re").compile(r"Groq 429|失敗 429")
CAPS = {"requests": 500, "audio": 14400, "tokens": 50000}


def usage_of(lines, captures):
    """Whisper requests and billed audio from the captures (a log line can be missed),
    translation tokens from the log."""
    import re
    sent = [c for c in captures.values() if c.get("raw") is not None and c.get("sentSeconds", 0) > 0]
    req = len(sent)
    audio = sum(max(10.0, c["sentSeconds"]) for c in sent)
    tokens = 0
    for l in lines:
        m = re.search(r"translation [\d.]+–[\d.]+ s: \d+ lines, (\d+) tokens", l)
        if m:
            tokens += int(m.group(1))
    return req, audio, tokens


def whisper(session, root, plan_path):
    plan = json.load(open(plan_path))
    b = Browser(session)
    b.start()
    failed = []
    # What every earlier run used counts against the caps, planned now or not.
    used = {"requests": 0, "audio": 0.0, "tokens": 0}
    os.makedirs(f"{root}/whisper", exist_ok=True)
    # Runs set aside (e.g. .qa/old-dub/whisper/: captured while YouTube played an AI dub)
    # were billed too.
    files = [f"{root}/whisper/{n}" for n in os.listdir(f"{root}/whisper")]
    if os.path.isdir(f"{root}/old-dub/whisper"):
        files += [f"{root}/old-dub/whisper/{n}" for n in os.listdir(f"{root}/old-dub/whisper")]
    for path_ in files:
        prev = json.load(open(path_))
        r, a, t = usage_of(prev.get("log", []), prev.get("captures", {}))
        used["requests"] += r; used["audio"] += a; used["tokens"] += t
    log("used so far", used)
    for item in plan:
        vid = item["videoId"]
        path = f"{root}/whisper/{vid}.json"
        if os.path.exists(path):
            continue
        need_audio = (item["end"] - item["start"]) + 60
        if used["requests"] + 12 > CAPS["requests"] or used["audio"] + need_audio > CAPS["audio"]:
            log("cap reached", used)
            failed.append((vid, "cap"))
            break
        translate = bool(item.get("translate")) and used["tokens"] + 12000 <= CAPS["tokens"]
        settings = {"enabled": True, "sourceLanguage": item["language"], "translate": translate,
                    "targetLanguage": "zh-TW", "debugCapture": True, "debugDryRun": False, "debugForceWhisper": True}
        b.set_settings(settings, with_key=True)
        b.clear_cache(vid)
        log(vid, "open", item["start"], item["end"], "translate" if translate else "")
        problem = open_video(b, vid, item["start"])
        if problem:
            log(vid, "FAILED:", problem)
            failed.append((vid, problem))
            if problem == "sorry":
                break
            continue
        # The scheduler keeps 30-60 s of chunks ahead of the playhead: stop LOOKAHEAD
        # seconds before the window ends, then hide the tab (the popup comes to the front):
        # a hidden tab starts no new chunk, so the captures end near the window's end and no
        # request goes beyond it. Wait for the chunks in flight to arrive.
        st = play_range(b, item["start"], item["end"] - LOOKAHEAD, 1,
                        wall_limit=(item["end"] - item["start"]) * 2 + 60)
        b.popup()
        stable, last_n, t0 = 0, -1, time.time()
        while time.time() - t0 < 1200:
            time.sleep(10)
            n = b.eval("chrome.storage.local.get(null).then(all => Object.keys(all).filter(k => k.startsWith(%s)).length)"
                       % json.dumps(f"debug:{vid}:"))
            stable = stable + 1 if n == last_n else 0
            last_n = n
            if stable >= 3:
                break
        # Off before the YouTube tab is shown again, or it would schedule more chunks for
        # the paused playhead. The next video's settings turn it on again.
        b.eval("chrome.storage.local.get('settings').then(s => chrome.storage.local.set({settings: {...s.settings, enabled: false}})).then(() => 'off')")
        b.page()
        console, _, _ = b.ab("console")
        lines = [l for l in console.splitlines() if ("[yt-ai-subs]" in l or "[ad-skip]" in l) and (
            "whisper " in l or "translation " in l or TOO_MANY.search(l) or "failed" in l or "no voice" in l or "ad started" in l)]
        data = b.export(vid)
        limits = b.rate_limits()
        r, a, t = usage_of(lines, data)
        used["requests"] += r; used["audio"] += a; used["tokens"] += t
        log(vid, "chunks", len(data), "requests", r, "audio", round(a), "tokens", t, "total", used)
        save(path, {"videoId": vid, "start": item["start"], "end": item["end"], "translate": translate, "audio": b.audio,
                    "captures": data, "log": lines, "rateLimiter": limits})
        b.ab("console", "--clear")
        b.ab("open", "about:blank")  # leave the video before the extension is turned on again
        server = (limits or {}).get("whisper", {}).get("requests") if isinstance(limits, dict) else None
        if server and server.get("limit") and server["remaining"] < 0.3 * server["limit"]:
            log("daily Whisper requests under 30%", server)
            failed.append((vid, "budget"))
            break
        if any(TOO_MANY.search(l) for l in lines):
            log("429 seen, stopping")
            failed.append((vid, "429"))
            break
        time.sleep(5)
    log("FAILED LIST", json.dumps(failed), "USED", json.dumps(used))
    b.set_settings({"groqApiKey": ""})
    b.ab("close")


if __name__ == "__main__":
    if not EXT_DIR or not AD_SKIP_DIR or len(sys.argv) < 5:
        sys.exit(__doc__)
    mode, session, root = sys.argv[1:4]
    if mode == "dry":
        dry(session, root, sys.argv[4:])
    elif mode == "audio":
        audio_check(session, root, sys.argv[4:])
    elif mode == "gt":
        dry(session, root, sys.argv[4:], gt_only=True)
    elif mode == "whisper":
        whisper(session, root, sys.argv[4])
