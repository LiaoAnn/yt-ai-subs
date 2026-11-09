// Test only, not part of yt-ai-subs: answers the extension's Groq requests with fake
// replies, so the real background code (rate limiter, quota levels, pause, scheduling)
// runs in agent-browser without calling Groq. How to use it: the "Quota levels without
// Groq" section of .claude/skills/test-extension-in-browser/SKILL.md.
//
//   node test/fake-groq/fake-groq.mjs <browser CDP ws url> <control.json> <log.jsonl> [<body dir>]
//
// With <body dir>, each Whisper request body (multipart: the chunk's WAV, the prompt, the
// model) is also saved there as <ms>-<n>.multipart, and logged as a "saved" line, so the
// same audio can be sent to Groq again later (chunk-replay.py in the skill folder).
//
// It is a CDP client (it listens on nothing): it attaches to every extension service worker,
// also ones that start later (they wait until interception is on), enables Fetch for
// https://api.groq.com/* and fulfills those requests. Start the browser with
// --host-resolver-rules=MAP api.groq.com ~NOTFOUND as well, so a request it misses fails
// instead of reaching Groq.
//
// control.json is re-read for every request, so a test can change it mid-run:
//   {"delayMs": 0,
//    "whisper": {"remaining": 1900, "limit": 2000},
//    "chat": {"remaining": 900, "limit": 1000}}
// Optional, to model dense talk (e.g. a talk show) instead of two short lines per chunk:
//   "whisperLineEvery": 2.5   one line every 2.5 s over the whole chunk (from the WAV length)
//   "chatTokens": 1500        usage.total_tokens reported for every translation (default 500)
//   "chatDelayMs": 3000       extra delay for translations only
//   "chatFailEvery": 4        every 4th translation answers 500 (a failed translation)
// remaining/limit become x-ratelimit-{remaining,limit}-requests (the daily request budget,
// reset in 2 h). Each request is logged to log.jsonl (one JSON object per line).
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const [wsUrl, controlPath, logPath, bodyDir] = process.argv.slice(2);
if (!wsUrl || !controlPath || !logPath) {
  console.error(
    "usage: node fake-groq.mjs <browser CDP ws url> <control.json> <log.jsonl> [<body dir>]",
  );
  process.exit(2);
}

const ws = new WebSocket(wsUrl);
let nextId = 1;
const pending = new Map();
let whisperCount = 0;
let chatCount = 0;
/** Service workers already intercepted (getTargets and auto-attach can both report one). */
const attached = new Set();

function send(method, params = {}, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((resolve) => pending.set(id, resolve));
}
const log = (entry) => appendFileSync(logPath, JSON.stringify({ at: Date.now(), ...entry }) + "\n");
const control = () => JSON.parse(readFileSync(controlPath, "utf8"));

function headersFor(kind) {
  const budget = control()[kind];
  return Object.entries({
    "content-type": "application/json",
    "x-ratelimit-limit-requests": String(budget.limit),
    "x-ratelimit-remaining-requests": String(budget.remaining),
    "x-ratelimit-reset-requests": "2h0m0s",
  }).map(([name, value]) => ({ name, value }));
}

/** Seconds of 16 kHz 16-bit mono audio in a multipart body (0 if unknown). */
function wavSeconds(request) {
  const entries = request.postDataEntries ?? [];
  const bytes = entries.reduce((sum, e) => sum + Buffer.from(e.bytes ?? "", "base64").length, 0);
  return bytes > 2000 ? (bytes - 1000) / 32000 : 0;
}

/**
 * Two short Japanese lines at 1–3 s and 4–6 s of the chunk, numbered so none repeats; with
 * `lineEvery`, one line every that many seconds over the chunk.
 */
function whisperBody(seconds = 0, lineEvery = 0) {
  const n = ++whisperCount;
  let plan = [
    [1.0, 3.0, ["偽の字幕", `その${n}番`, "です。"]],
    [4.0, 6.0, ["テスト", `${n}回目の`, "二行目。"]],
  ];
  if (lineEvery > 0 && seconds > lineEvery) {
    plan = [];
    for (let i = 0, at = 0.3; at + lineEvery - 0.3 <= seconds - 0.5; i++, at += lineEvery) {
      plan.push([
        at,
        at + lineEvery - 0.4,
        ["偽の会話", `第${n}組の`, `${i + 1}行目`, "ですよね。"],
      ]);
    }
  }
  const words = [];
  const segments = plan.map(([start, end, parts]) => {
    const step = (end - start) / parts.length;
    parts.forEach((word, i) =>
      words.push({ word, start: start + i * step, end: start + (i + 1) * step }),
    );
    return {
      start,
      end,
      text: parts.join(""),
      avg_logprob: -0.2,
      temperature: 0,
      compression_ratio: 1.2,
      no_speech_prob: 0.01,
    };
  });
  return {
    text: segments.map((s) => s.text).join(""),
    language: "japanese",
    duration: seconds || 10,
    segments,
    words,
  };
}

/** Translates each numbered line as "【假譯】<line>". */
function chatBody(postData, tokens = 500) {
  let lines = {};
  try {
    const user = JSON.parse(postData).messages[1].content;
    lines = JSON.parse(user.slice(user.lastIndexOf("\n{") + 1));
  } catch {
    // unexpected request shape: an empty object makes the extension report a format error
  }
  const out = Object.fromEntries(Object.entries(lines).map(([k, v]) => [k, `【假譯】${v}`]));
  return {
    body: {
      choices: [{ message: { content: JSON.stringify(out) } }],
      usage: { total_tokens: tokens },
    },
    lines: Object.keys(out).length,
  };
}

async function onPaused({ requestId, request }, sessionId) {
  const kind = request.url.includes("/audio/transcriptions")
    ? "whisper"
    : request.url.includes("/chat/completions")
      ? "chat"
      : null;
  if (!kind) {
    log({ event: "blocked", url: request.url });
    await send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, sessionId);
    return;
  }
  const { delayMs = 0, chatDelayMs = 0, whisperLineEvery = 0, chatTokens = 500 } = control();
  const { chatFailEvery = 0 } = control();
  log({ event: `${kind}-start`, remaining: control()[kind].remaining });
  const delay = delayMs + (kind === "chat" ? chatDelayMs : 0);
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  let body;
  let status = 200;
  if (kind === "whisper") {
    body = whisperBody(wavSeconds(request), whisperLineEvery);
    if (bodyDir) {
      // postDataEntries carry the bytes as base64; postData would mangle the binary WAV.
      const entries = request.postDataEntries ?? [];
      const bytes = Buffer.concat(entries.map((e) => Buffer.from(e.bytes ?? "", "base64")));
      const name = `${Date.now()}-${whisperCount}.multipart`;
      writeFileSync(`${bodyDir}/${name}`, bytes);
      log({ event: "saved", name, bytes: bytes.length });
    }
  } else {
    chatCount++;
    const chat = chatBody(request.postData ?? "", chatTokens);
    body = chat.body;
    if (chatFailEvery > 0 && chatCount % chatFailEvery === 0) {
      status = 500;
      body = { error: { message: "fake failure" } };
    }
  }
  await send(
    "Fetch.fulfillRequest",
    {
      requestId,
      responseCode: status,
      responseHeaders: headersFor(kind),
      body: Buffer.from(JSON.stringify(body)).toString("base64"),
    },
    sessionId,
  );
  log({ event: `${kind}-done`, status });
}

ws.addEventListener("open", async () => {
  await send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type: "service_worker", exclude: false }, { exclude: true }],
  });
  const { result } = await send("Target.getTargets");
  for (const target of result.targetInfos) {
    if (target.type === "service_worker") {
      await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    }
  }
  log({ event: "ready" });
});

ws.addEventListener("message", async (message) => {
  const data = JSON.parse(message.data);
  if (data.id && pending.has(data.id)) {
    pending.get(data.id)(data);
    pending.delete(data.id);
    return;
  }
  if (data.method === "Target.attachedToTarget") {
    const { sessionId, targetInfo } = data.params;
    if (!targetInfo.url.startsWith("chrome-extension://") || attached.has(targetInfo.targetId)) {
      await send("Runtime.runIfWaitingForDebugger", {}, sessionId);
      await send("Target.detachFromTarget", { sessionId });
      return;
    }
    attached.add(targetInfo.targetId);
    const enabled = await send(
      "Fetch.enable",
      { patterns: [{ urlPattern: "https://api.groq.com/*" }] },
      sessionId,
    );
    log({ event: "attached", url: targetInfo.url, fetchEnabled: !enabled.error });
    await send("Runtime.runIfWaitingForDebugger", {}, sessionId);
  } else if (data.method === "Target.detachedFromTarget" && data.params.targetId) {
    attached.delete(data.params.targetId);
  } else if (data.method === "Fetch.requestPaused") {
    await onPaused(data.params, data.sessionId);
  }
});

ws.addEventListener("close", () => {
  log({ event: "closed" });
  process.exit(0);
});
