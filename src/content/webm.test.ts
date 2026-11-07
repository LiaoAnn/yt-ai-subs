import { describe, expect, it } from "vitest";
import { bytes, cluster, initSegment, unknownSizeElement, simpleBlock } from "@/test/webm-fixture";
import { findClusters, isWebmInit, maxBlockTimecode, readVint, timecodeScaleSeconds } from "./webm";

describe("readVint", () => {
  it("reads sizes without the marker and IDs with it", () => {
    expect(readVint(new Uint8Array([0x81]), 0, false)).toEqual({
      value: 1,
      length: 1,
      unknown: false,
    });
    expect(readVint(new Uint8Array([0x40, 0x02]), 0, false)).toEqual({
      value: 2,
      length: 2,
      unknown: false,
    });
    expect(readVint(new Uint8Array([0x1f, 0x43, 0xb6, 0x75]), 0, true)?.value).toBe(0x1f43b675);
  });

  it("flags unknown sizes and rejects cut-off or zero bytes", () => {
    expect(readVint(new Uint8Array([0xff]), 0, false)?.unknown).toBe(true);
    expect(readVint(new Uint8Array([0x40]), 0, false)).toBeNull();
    expect(readVint(new Uint8Array([0x00]), 0, false)).toBeNull();
  });
});

describe("init segments", () => {
  it("recognises the EBML header and reads TimecodeScale", () => {
    const init = bytes(initSegment(1_000_000));
    expect(isWebmInit(init)).toBe(true);
    expect(isWebmInit(bytes(cluster(0, [0])))).toBe(false);
    expect(timecodeScaleSeconds(init)).toBeCloseTo(0.001);
    expect(timecodeScaleSeconds(bytes(initSegment(500_000)))).toBeCloseTo(0.0005);
  });

  it("defaults to 1 ms when there is no TimecodeScale", () => {
    expect(timecodeScaleSeconds(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x80]))).toBe(0.001);
  });
});

describe("findClusters", () => {
  it("finds each cluster with its timecode, after an init segment", () => {
    const init = initSegment();
    const first = cluster(0, [0, 20, 40]);
    const second = cluster(10_000, [0, 20]);
    const found = findClusters(bytes(init, first, second));
    expect(found).toEqual([
      { pos: init.length, timecode: 0 },
      { pos: init.length + first.length, timecode: 10_000 },
    ]);
  });

  it("ignores a cluster ID whose timecode is cut off", () => {
    const whole = cluster(5000, [0]);
    expect(findClusters(bytes(whole.slice(0, 6)))).toEqual([]);
  });
});

describe("maxBlockTimecode", () => {
  it("returns the largest block timecode, including in unknown-size clusters", () => {
    expect(maxBlockTimecode(bytes(cluster(0, [0, 960, 40])))).toBe(960);
    const live = bytes(
      unknownSizeElement([0x1f, 0x43, 0xb6, 0x75], [0xe7, 0x81, 0x00, ...simpleBlock(500)]),
    );
    expect(maxBlockTimecode(live)).toBe(500);
  });

  it("handles a cluster cut off inside a block header", () => {
    const whole = cluster(0, [0, 100, 200]);
    expect(maxBlockTimecode(bytes(whole.slice(0, whole.length - 6)))).toBe(100);
  });

  it("reads negative relative timecodes as signed", () => {
    expect(maxBlockTimecode(bytes(cluster(1000, [-20])))).toBe(0);
  });
});
