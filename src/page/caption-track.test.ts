import { describe, expect, it } from "vitest";
import type { Json3Event } from "@/shared/captions";
import { DEFAULT_TRACK_CONFIG } from "@/shared/track-config";
import {
  TrackHealth,
  activeEvents,
  isPlayerEndpoint,
  liveStatus,
  ourTrackVideoId,
  patchPlayerResponse,
  playerResponsesIn,
  shouldReloadNow,
  showsAnyOf,
  trackBaseUrl,
  type HealthSample,
} from "./caption-track";

interface TracklistForTest {
  captionTracks: Record<string, unknown>[];
  audioTracks: { captionTrackIndices: number[] }[];
  translationLanguages: unknown[];
  defaultAudioTrackIndex: number;
}

const playable = <T extends Record<string, unknown>>(extra: T = {} as T) => ({
  playabilityStatus: { status: "OK" },
  videoDetails: { videoId: "abc123" },
  ...extra,
});

describe("live streams", () => {
  it("are recognised from videoDetails.isLive and get no track", () => {
    const live = playable({
      videoDetails: { videoId: "live1", isLive: true, isLiveContent: true },
    });
    expect(liveStatus(live)).toEqual({ videoId: "live1", live: true });
    expect(patchPlayerResponse(live, DEFAULT_TRACK_CONFIG)).toBeNull();
    expect(live).not.toHaveProperty("captions");
    // A finished stream (isLiveContent only) is an ordinary video.
    const vod = playable({ videoDetails: { videoId: "vod1", isLiveContent: true } });
    expect(liveStatus(vod)).toEqual({ videoId: "vod1", live: false });
    expect(patchPlayerResponse(vod, DEFAULT_TRACK_CONFIG)).toBe("vod1");
    expect(liveStatus(null)).toBeNull();
    expect(liveStatus({ videoDetails: {} })).toBeNull();
  });
});

describe("patchPlayerResponse", () => {
  it("appends our track and lists it under every audio track", () => {
    const response = playable({
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ vssId: ".en", languageCode: "en", baseUrl: "x" }],
          audioTracks: [{ captionTrackIndices: [0] }, { captionTrackIndices: [0] }],
          translationLanguages: [{ languageCode: "fr" }],
          defaultAudioTrackIndex: 1,
        },
      },
    });
    expect(patchPlayerResponse(response, DEFAULT_TRACK_CONFIG)).toBe("abc123");
    const list = response.captions.playerCaptionsTracklistRenderer as TracklistForTest;
    expect(list.captionTracks).toHaveLength(2);
    expect(list.captionTracks[1]).toMatchObject({
      name: { simpleText: "AI 繁中" },
      vssId: ".zh-TW.ytaisubs",
      languageCode: "zh-TW",
      isTranslatable: false,
    });
    expect(ourTrackVideoId(String(list.captionTracks[1]!.baseUrl))).toBe("abc123");
    expect(list.audioTracks.map((audio) => audio.captionTrackIndices)).toEqual([
      [0, 1],
      [0, 1],
    ]);
    expect(list.defaultAudioTrackIndex).toBe(1);
    expect(list.translationLanguages).toHaveLength(1);
  });

  it("creates the captions block for a video without captions", () => {
    const response: Record<string, unknown> = playable();
    expect(patchPlayerResponse(response, DEFAULT_TRACK_CONFIG)).toBe("abc123");
    expect(response.captions).toEqual({
      playerCaptionsTracklistRenderer: {
        captionTracks: [expect.objectContaining({ vssId: ".zh-TW.ytaisubs" })],
        audioTracks: [{ captionTrackIndices: [0] }],
        translationLanguages: [],
        defaultAudioTrackIndex: 0,
      },
    });
  });

  it("adds the track only once", () => {
    const response = playable();
    patchPlayerResponse(response, DEFAULT_TRACK_CONFIG);
    expect(patchPlayerResponse(response, DEFAULT_TRACK_CONFIG)).toBeNull();
  });

  it("leaves unplayable responses, non-videos and a disabled extension alone", () => {
    const unplayable = { ...playable(), playabilityStatus: { status: "LOGIN_REQUIRED" } };
    expect(patchPlayerResponse(unplayable, DEFAULT_TRACK_CONFIG)).toBeNull();
    expect(unplayable).not.toHaveProperty("captions");
    expect(patchPlayerResponse({ responseContext: {} }, DEFAULT_TRACK_CONFIG)).toBeNull();
    expect(patchPlayerResponse(null, DEFAULT_TRACK_CONFIG)).toBeNull();
    const disabled = playable();
    expect(patchPlayerResponse(disabled, { ...DEFAULT_TRACK_CONFIG, enabled: false })).toBeNull();
    expect(disabled).not.toHaveProperty("captions");
  });
});

describe("timedtext URLs", () => {
  it("recognises only our track, with the parameters the player appends", () => {
    const base = trackBaseUrl("abc123", "zh-TW");
    expect(ourTrackVideoId(`${base}&potc=1&fmt=json3&xorb=2&c=WEB`)).toBe("abc123");
    expect(ourTrackVideoId(base.replace("https://www.youtube.com", ""))).toBe("abc123");
    expect(ourTrackVideoId("https://www.youtube.com/api/timedtext?v=abc123&lang=en")).toBeNull();
    expect(ourTrackVideoId("https://evil.example/api/timedtext?v=x&ytaisubs=1")).toBeNull();
    expect(ourTrackVideoId("not a url ::")).toBeNull();
  });

  it("copies a real track's parameters, so the player adds its pot token to ours", () => {
    const real =
      "https://www.youtube.com/api/timedtext?v=abc123&ei=x&caps=asr&opi=1&exp=xpe&expire=9&sparams=ip,ipbits,expire,v,caps,opi,exp&signature=s&key=yt8&kind=asr&lang=ja&name=n&fmt=srv3";
    const url = new URL(trackBaseUrl("abc123", "zh-TW", real));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      v: "abc123",
      lang: "zh-TW",
      ytaisubs: "1",
      exp: "xpe",
      signature: "s",
      sparams: "ip,ipbits,expire,v,caps,opi,exp",
    });
    for (const name of ["kind", "name", "fmt"]) expect(url.searchParams.has(name)).toBe(false);
    expect(ourTrackVideoId(url.href)).toBe("abc123");
    // A template from anywhere else is ignored.
    expect(trackBaseUrl("abc123", "zh-TW", "https://evil.example/api/timedtext?x=1")).toBe(
      trackBaseUrl("abc123", "zh-TW"),
    );
  });

  it("knows which youtubei endpoints carry a player response", () => {
    expect(isPlayerEndpoint("https://www.youtube.com/youtubei/v1/player?prettyPrint=false")).toBe(
      true,
    );
    expect(
      isPlayerEndpoint("https://www.youtube.com/youtubei/v1/get_watch?prettyPrint=false"),
    ).toBe(true);
    expect(isPlayerEndpoint("https://www.youtube.com/youtubei/v1/next?prettyPrint=false")).toBe(
      false,
    );
  });
});

describe("playerResponsesIn", () => {
  it("finds the player response in /player and /get_watch bodies", () => {
    const player = playable();
    expect(playerResponsesIn(player)).toEqual([player]);
    const getWatch = [{ playerResponse: player }, { watchNextResponse: {} }];
    expect(playerResponsesIn(getWatch)).toEqual([player]);
    expect(playerResponsesIn({ playerResponse: player })).toEqual([player]);
    expect(playerResponsesIn("nope")).toEqual([]);
  });
});

const event = (startMs: number, durationMs: number, text: string): Json3Event => ({
  tStartMs: startMs,
  dDurationMs: durationMs,
  segs: [{ utf8: text }],
});

describe("activeEvents and showsAnyOf", () => {
  const events = [event(1000, 2000, "一行目\n第一行"), event(5000, 400, "短い")];

  it("ignores the edges of an event and events too short to check", () => {
    expect(activeEvents(events, 1.1)).toEqual([]);
    expect(activeEvents(events, 2)).toEqual([events[0]]);
    expect(activeEvents(events, 5.2)).toEqual([]);
  });

  it("matches screen text regardless of line breaks and spacing", () => {
    expect(showsAnyOf("一行目\n第一行", [events[0]!])).toBe(true);
    expect(showsAnyOf(" 一行目 第一行 ", [events[0]!])).toBe(true);
    expect(showsAnyOf("", [events[0]!])).toBe(false);
    expect(showsAnyOf("something else", [events[0]!])).toBe(false);
  });
});

describe("shouldReloadNow", () => {
  it("waits for a gap between captions, but not forever", () => {
    const base = { now: 10_000, captionShowing: true, paused: false };
    expect(shouldReloadNow({ ...base, staleSince: 0 })).toBe(false);
    expect(shouldReloadNow({ ...base, staleSince: 9000 })).toBe(false);
    expect(shouldReloadNow({ ...base, staleSince: 7000 })).toBe(true);
    expect(shouldReloadNow({ ...base, staleSince: 9000, captionShowing: false })).toBe(true);
    expect(shouldReloadNow({ ...base, staleSince: 9000, paused: true })).toBe(true);
  });
});

const sample = (patch: Partial<HealthSample> = {}): HealthSample => ({
  videoId: "v1",
  adShowing: false,
  inTracklist: true,
  selected: true,
  served: 1,
  reloadWaitMs: 0,
  expected: [],
  shown: "",
  ...patch,
});

describe("TrackHealth", () => {
  const limits = { tracklistMs: 8000, requestMs: 6000, renderMisses: 3 };

  it("is pending until the track shows up, then cc", () => {
    const health = new TrackHealth(limits);
    expect(health.observe(sample({ inTracklist: false, selected: false }), 0).mode).toBe("pending");
    expect(health.observe(sample(), 1000).mode).toBe("cc");
  });

  it("falls back when the track never appears in the menu", () => {
    const health = new TrackHealth(limits);
    health.observe(sample({ inTracklist: false }), 0);
    expect(health.observe(sample({ inTracklist: false }), 7999).mode).toBe("pending");
    expect(health.observe(sample({ inTracklist: false }), 8000)).toEqual({
      mode: "overlay",
      reason: "字幕選單裡沒有出現 AI 字幕軌",
    });
  });

  it("does not count ad time against the track", () => {
    const health = new TrackHealth(limits);
    health.observe(sample({ inTracklist: false, adShowing: true }), 0);
    health.observe(sample({ inTracklist: false, adShowing: true }), 20_000);
    expect(health.observe(sample({ inTracklist: false }), 25_000).mode).toBe("pending");
  });

  it("falls back when the selected track is never requested", () => {
    const health = new TrackHealth(limits);
    health.observe(sample({ served: 0 }), 0);
    expect(health.observe(sample({ served: 0 }), 5999).mode).toBe("cc");
    expect(health.observe(sample({ served: 0 }), 6000).mode).toBe("overlay");
  });

  it("falls back when a reload never leads to a request", () => {
    const health = new TrackHealth(limits);
    expect(health.observe(sample({ reloadWaitMs: 5999 }), 0).mode).toBe("cc");
    expect(health.observe(sample({ reloadWaitMs: 6000 }), 500)).toEqual({
      mode: "overlay",
      reason: "播放器沒有重新載入 AI 字幕軌",
    });
    expect(health.modeFor("v1")).toBe("overlay");
    expect(health.modeFor("v2")).toBe("pending");
  });

  it("falls back when served captions stay off screen, and stays there", () => {
    const health = new TrackHealth(limits);
    const expected = [event(0, 10_000, "字幕")];
    const shown = (text: string, at: number) =>
      health.observe(sample({ expected, shown: text }), at).mode;
    expect(shown("字幕", 0)).toBe("cc");
    expect(shown("", 500)).toBe("cc");
    expect(shown("", 1000)).toBe("cc");
    expect(shown("字幕", 1500)).toBe("cc"); // a reload blanked it briefly: reset
    expect(shown("", 2000)).toBe("cc");
    // A gap between captions neither counts nor resets.
    expect(health.observe(sample({ expected: [], shown: "" }), 2500).mode).toBe("cc");
    expect(shown("", 3000)).toBe("cc");
    expect(health.observe(sample({ expected, shown: "" }), 3500)).toEqual({
      mode: "overlay",
      reason: "YouTube 沒有顯示 AI 字幕",
    });
    expect(shown("字幕", 4000)).toBe("overlay");
  });

  it("accepts a user who picks another track or turns captions off", () => {
    const health = new TrackHealth(limits);
    health.observe(sample(), 0);
    expect(health.observe(sample({ selected: false, served: 0 }), 60_000).mode).toBe("cc");
  });

  it("starts over on the next video", () => {
    const health = new TrackHealth(limits);
    health.observe(sample({ inTracklist: false }), 0);
    expect(health.observe(sample({ inTracklist: false }), 9000).mode).toBe("overlay");
    expect(health.observe(sample({ videoId: "v2", inTracklist: false }), 9500).mode).toBe(
      "pending",
    );
  });
});
