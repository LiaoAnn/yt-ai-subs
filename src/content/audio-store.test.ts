import { describe, expect, it } from "vitest";
import { bytes, cluster, initSegment, simpleBlock, unknownSizeElement } from "@/test/webm-fixture";
import { AudioStore, concatBytes } from "./audio-store";

/** Cluster at `startMs` with blocks every 20 ms for `lengthMs`. */
const audioCluster = (startMs: number, lengthMs: number) =>
  cluster(
    startMs,
    Array.from({ length: lengthMs / 20 }, (_, i) => i * 20),
  );

/**
 * A live-style cluster: an 8-byte unknown size and a CRC-32 before the Timecode make a
 * 21-byte header, the longest kind findClusters reads in practice.
 */
const liveCluster = (startMs: number) =>
  unknownSizeElement(
    [0x1f, 0x43, 0xb6, 0x75],
    [
      0xbf,
      0x84,
      0x12,
      0x34,
      0x56,
      0x78, // CRC-32
      0xe7,
      0x82,
      startMs >> 8,
      startMs & 0xff, // Timecode
      ...Array.from({ length: 50 }, (_, i) => simpleBlock(i * 20)).flat(),
    ],
  );

/** Appends `stream` to a new store, cut at the given byte offsets (the first part is the init). */
function appendAll(stream: Uint8Array, points: number[]): AudioStore {
  const store = new AudioStore();
  const cuts = [0, ...points, stream.length];
  for (let i = 0; i + 1 < cuts.length; i++) {
    store.append(1, stream.slice(cuts[i], cuts[i + 1]), i === 0, null, null);
  }
  return store;
}

/** Each cluster's start, end and bytes, plus the init bytes, for comparing two stores. */
function snapshot(store: AudioStore) {
  const init = [...store.inits.values()].map((b) => [...b]);
  return [...store.clusters.values()]
    .toSorted((a, b) => a.start - b.start)
    .map((c) => ({
      start: c.start,
      end: store.clusterEnd(c),
      bytes: [...concatBytes(c.parts)],
      init,
    }));
}

describe("AudioStore", () => {
  it("indexes WebM clusters by their timecodes, split across appends", () => {
    const store = new AudioStore();
    store.append(1, bytes(initSegment(), audioCluster(0, 1000)), true, null, null);
    const second = audioCluster(1000, 1000);
    // The second cluster arrives in two appends.
    store.append(1, bytes(second.slice(0, 20)), false, null, null);
    store.append(1, bytes(second.slice(20)), false, null, null);
    expect(store.clusters.size).toBe(2);
    const coverage = store.coverage(0, 2);
    expect(coverage.runs).toHaveLength(1);
    expect(coverage.runs[0]!.start).toBe(0);
    expect(coverage.runs[0]!.end).toBeCloseTo(2.0, 1);
    expect(coverage.covered).toBeCloseTo(2.0, 1);
    expect(store.readiness(0, 2)).toBe("ready");
  });

  it("keeps every cluster when an append boundary splits a cluster header", () => {
    const init = initSegment();
    const clusters = [audioCluster(0, 1000), audioCluster(1000, 1000), audioCluster(2000, 1000)];
    const stream = bytes(init, ...clusters);
    const expected = snapshot(appendAll(stream, []));
    expect(expected.map((c) => c.start)).toEqual([0, 1, 2]);
    // Every split point after the init (YouTube appends the init whole), and every pair of split points around the second cluster's header
    // (which also covers a header spread over three appends).
    const header = init.length + clusters[0]!.length;
    const splits: number[][] = [];
    for (let b = init.length + 1; b < init.length + 14; b++) splits.push([init.length, b]);
    for (let at = init.length; at < stream.length; at++) splits.push([at]);
    for (let a = header - 2; a < header + 12; a++) {
      for (let b = a + 1; b < header + 14; b++) splits.push([a, b]);
    }
    for (const points of splits) {
      expect(snapshot(appendAll(stream, points)), `split at ${points.join(",")}`).toEqual(expected);
    }
  });

  it("keeps clusters with long headers (unknown size, CRC-32) split at any byte", () => {
    const init = initSegment();
    const first = liveCluster(0);
    const stream = bytes(init, first, liveCluster(1000), liveCluster(2000));
    const expected = snapshot(appendAll(stream, []));
    expect(expected.map((c) => c.start)).toEqual([0, 1, 2]);
    const header = init.length + first.length;
    for (let at = header - 2; at < header + 24; at++) {
      expect(snapshot(appendAll(stream, [at])), `split at ${at}`).toEqual(expected);
    }
  });

  it("does not glue a cut-off header to a cluster from a seek", () => {
    const store = new AudioStore();
    store.append(1, bytes(initSegment(), audioCluster(0, 1000)), true, null, null);
    // An append that ends with the start of a cluster header (an aborted append)...
    store.append(1, bytes(audioCluster(1000, 1000).slice(0, 6)), false, null, null);
    // ...then a seek: a whole cluster from somewhere else.
    store.append(1, bytes(audioCluster(30_000, 1000)), false, null, null);
    expect([...store.clusters.values()].map((c) => c.start).toSorted((a, b) => a - b)).toEqual([
      0, 30,
    ]);
  });

  it("drops media that arrives before any init segment", () => {
    const store = new AudioStore();
    store.append(1, bytes(audioCluster(0, 1000)), false, null, null);
    expect(store.clusters.size).toBe(0);
    expect(store.droppedWithoutInit).toBe(1);
  });

  it("waits for audio not yet buffered, and gives up on a gap the buffer jumped over", () => {
    const store = new AudioStore();
    store.append(1, bytes(initSegment()), true, null, null);
    store.append(1, bytes(audioCluster(0, 5000)), false, null, null);
    expect(store.readiness(0, 10)).toBe("wait");
    // A seek: buffering resumes at 20 s, so 6–10 s will never arrive.
    store.append(1, bytes(audioCluster(20_000, 5000)), false, null, null);
    store.append(1, bytes(audioCluster(25_000, 5000)), false, null, null);
    expect(store.readiness(8, 12)).toBe("never");
  });

  it("prunes clusters far behind the playhead once they are done", () => {
    const store = new AudioStore();
    store.append(1, bytes(initSegment()), true, null, null);
    store.append(1, bytes(audioCluster(0, 1000), audioCluster(200_000, 1000)), false, null, null);
    store.prune(200, () => true);
    expect([...store.clusters.values()].map((c) => c.start)).toEqual([200]);
  });

  it("drops audio far from the playhead even when nothing was transcribed", () => {
    const store = new AudioStore();
    store.append(1, bytes(initSegment()), true, null, null);
    const starts = [0, 90_000, 650_000, 700_000, 1_400_000];
    store.append(1, bytes(...starts.map((ms) => audioCluster(ms, 1000))), false, null, null);
    // Playhead at 700 s, nothing done (extension off): only audio within 600 s stays.
    store.prune(700, () => false);
    expect([...store.clusters.values()].map((c) => c.start)).toEqual([650, 700]);
    // Done and only 50 s behind: kept, so a chunk being cut there still has it.
    store.prune(700, () => true);
    expect([...store.clusters.values()].map((c) => c.start)).toEqual([650, 700]);
    expect(store.byteLength()).toBeGreaterThan(0);
  });

  it("forgets init segments of old streams once their audio is gone", () => {
    const store = new AudioStore();
    store.append(1, bytes(initSegment(), audioCluster(0, 1000)), true, null, null);
    store.append(2, bytes(initSegment(), audioCluster(900_000, 1000)), true, null, null);
    store.append(1, bytes(initSegment()), true, null, null); // quality switch on buffer 1
    expect(store.inits.size).toBe(3);
    store.prune(900, () => false);
    // Buffer 1's first stream lost its only cluster; both current streams keep theirs.
    expect(store.inits.size).toBe(2);
    expect(store.clusters.size).toBe(1);
  });
});
