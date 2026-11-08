import { describe, expect, it } from "vitest";
import { bytes, cluster, initSegment } from "@/test/webm-fixture";
import { AudioStore } from "./audio-store";

/** Cluster at `startMs` with blocks every 20 ms for `lengthMs`. */
const audioCluster = (startMs: number, lengthMs: number) =>
  cluster(
    startMs,
    Array.from({ length: lengthMs / 20 }, (_, i) => i * 20),
  );

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
