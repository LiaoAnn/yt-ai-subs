import { afterEach, describe, expect, it, vi } from "vitest";
import type { Cue } from "@/shared/captions";
import { DEFAULT_SETTINGS } from "@/shared/settings";
import { CaptionTrackBridge } from "./caption-track";

describe("CaptionTrackBridge.sync", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts the cues only when their version or the text settings change", () => {
    const postMessage = vi.fn();
    vi.stubGlobal("window", { postMessage });
    vi.stubGlobal("location", { origin: "https://www.youtube.com" });
    const bridge = new CaptionTrackBridge();
    const cues: Cue[] = [{ start: 1, end: 2, original: "原文", translation: "翻譯" }];

    bridge.sync("vid", 1, cues, DEFAULT_SETTINGS);
    bridge.sync("vid", 1, cues, DEFAULT_SETTINGS); // unchanged: nothing sent
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0]![0].events[0].segs[0].utf8).toBe("原文\n翻譯");

    cues[0]!.translation = "新的翻譯"; // the caller bumps the version on every change
    bridge.sync("vid", 2, cues, DEFAULT_SETTINGS);
    expect(postMessage.mock.calls[1]![0].events[0].segs[0].utf8).toBe("原文\n新的翻譯");

    bridge.sync("vid", 2, cues, { ...DEFAULT_SETTINGS, showOriginal: false });
    expect(postMessage.mock.calls[2]![0].events[0].segs[0].utf8).toBe("新的翻譯");

    bridge.sync("vid", 2, cues, { ...DEFAULT_SETTINGS, showOriginal: false, enabled: false });
    expect(postMessage.mock.calls[3]![0].events).toEqual([]);

    bridge.sync("other", 2, cues, { ...DEFAULT_SETTINGS, showOriginal: false, enabled: false });
    expect(postMessage).toHaveBeenCalledTimes(5);
    expect(postMessage.mock.calls[4]![0].videoId).toBe("other");
  });
});
