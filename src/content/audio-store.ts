// Collects the audio segments the page script copies, indexed by media time, and answers
// "which bytes cover [start, end]?". WebM gets exact times from its Cluster timecodes;
// MP4 falls back to the time span the append added to the buffered ranges.

import { findClusters, isWebmInit, maxBlockTimecode, timecodeScaleSeconds } from "./webm";

interface Stream {
  initKey: string;
  format: "webm" | "mp4";
  /** Seconds per timecode tick (WebM). */
  scale: number;
  /** The last WebM cluster seen, which may continue in the next append. */
  open: Cluster | null;
}

export interface Cluster {
  initKey: string;
  start: number;
  /** Bytes of the cluster, possibly split across appends. */
  parts: Uint8Array[];
  scale: number;
  /** MP4 fragments: end from the buffered ranges, never recomputed. */
  fixedEnd: boolean;
  end: number;
  /** Total byte length when `end` was last computed (-1: never). */
  endLength: number;
}

export interface Run {
  start: number;
  end: number;
  clusters: Cluster[];
}

export interface Coverage {
  runs: Run[];
  /** Seconds of [start, end] that have audio. */
  covered: number;
  /** Furthest buffered time of the chosen stream. */
  frontier: number;
  initKey: string | undefined;
}

export type Readiness = "ready" | "wait" | "never";

/** Clusters closer than this (seconds) count as contiguous. */
const JOIN_GAP = 0.25;

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export class AudioStore {
  readonly inits = new Map<string, Uint8Array>();
  private readonly streams = new Map<number, Stream>();
  readonly clusters = new Map<string, Cluster>();
  private initCounter = 0;
  /** Segments dropped because no init segment had been seen for their buffer. */
  droppedWithoutInit = 0;

  /** Adds one append's bytes. */
  append(
    bufferId: number,
    bytes: Uint8Array,
    isInit: boolean,
    spanStart: number | null,
    spanEnd: number | null,
  ): void {
    let stream = this.streams.get(bufferId);
    let media: Uint8Array | null = bytes;
    if (isInit) {
      const initKey = `${bufferId}:${++this.initCounter}`;
      const webm = isWebmInit(bytes);
      let initBytes = bytes;
      if (webm) {
        const first = findClusters(bytes)[0];
        if (first) {
          initBytes = bytes.slice(0, first.pos);
          media = bytes.subarray(first.pos);
        } else {
          media = null;
        }
      } else {
        media = null; // MP4 init: kept whole (rarely includes a first fragment)
      }
      this.inits.set(initKey, initBytes);
      stream = {
        initKey,
        format: webm ? "webm" : "mp4",
        scale: webm ? timecodeScaleSeconds(bytes) : 0,
        open: null,
      };
      this.streams.set(bufferId, stream);
    }
    if (!stream) {
      this.droppedWithoutInit++;
      return;
    }
    if (!media || !media.length) return;

    if (stream.format === "webm") {
      const found = findClusters(media);
      const firstPos = found[0]?.pos ?? media.length;
      if (firstPos > 0 && stream.open) {
        stream.open.parts.push(media.slice(0, firstPos));
        stream.open.endLength = -1;
      }
      for (let i = 0; i < found.length; i++) {
        const header = found[i]!;
        const next = found[i + 1];
        const cluster: Cluster = {
          initKey: stream.initKey,
          start: header.timecode * stream.scale,
          parts: [media.slice(header.pos, next ? next.pos : media.length)],
          scale: stream.scale,
          fixedEnd: false,
          end: header.timecode * stream.scale,
          endLength: -1,
        };
        // A re-sent cluster replaces the old copy.
        this.clusters.set(`${stream.initKey}@${header.timecode}`, cluster);
        stream.open = cluster;
      }
    } else {
      if (spanStart === null || spanEnd === null) return;
      this.clusters.set(`${stream.initKey}@${spanStart.toFixed(3)}`, {
        initKey: stream.initKey,
        start: spanStart,
        end: spanEnd,
        parts: [media.slice()],
        scale: 0,
        fixedEnd: true,
        endLength: media.length,
      });
    }
  }

  clusterEnd(cluster: Cluster): number {
    if (cluster.fixedEnd) return cluster.end;
    const length = cluster.parts.reduce((sum, part) => sum + part.length, 0);
    if (cluster.endLength !== length) {
      const bytes = cluster.parts.length === 1 ? cluster.parts[0]! : concatBytes(cluster.parts);
      cluster.end = cluster.start + maxBlockTimecode(bytes) * cluster.scale + 0.02;
      cluster.endLength = length;
    }
    return cluster.end;
  }

  /** Contiguous runs of audio for [start, end], from the most recent stream that has any. */
  coverage(start: number, end: number): Coverage {
    const all = [...this.clusters.values()];
    const candidates = all
      .filter((c) => this.clusterEnd(c) > start + 0.01 && c.start < end - 0.01)
      .toSorted((a, b) => a.start - b.start);
    // Quality switches create new init segments; stick to one.
    const initKey = candidates.at(-1)?.initKey ?? [...this.streams.values()].at(-1)?.initKey;
    const runs: Run[] = [];
    for (const cluster of candidates.filter((c) => c.initKey === initKey)) {
      const last = runs.at(-1);
      const clusterEnd = this.clusterEnd(cluster);
      if (last && cluster.start <= last.end + JOIN_GAP) {
        if (clusterEnd > last.end) {
          last.clusters.push(cluster);
          last.end = clusterEnd;
        }
      } else {
        runs.push({ start: cluster.start, end: clusterEnd, clusters: [cluster] });
      }
    }
    let covered = 0;
    for (const run of runs)
      covered += Math.max(0, Math.min(end, run.end) - Math.max(start, run.start));
    let frontier = 0;
    for (const cluster of all) {
      if (cluster.initKey === initKey) frontier = Math.max(frontier, this.clusterEnd(cluster));
    }
    return { runs, covered, frontier, initKey };
  }

  /** "ready": the audio is there; "wait": more is coming; "never": the gap won't be filled. */
  readiness(start: number, end: number): Readiness {
    const { covered, frontier } = this.coverage(start, end);
    if (covered >= end - start - 0.5) return "ready";
    if (frontier >= end + 3) return covered >= 1.5 ? "ready" : "never";
    return "wait";
  }

  /** Drops clusters that ended well before `t` and for which `isDone` says we are finished. */
  prune(t: number, isDone: (time: number) => boolean, keepSeconds = 120): void {
    for (const [key, cluster] of this.clusters) {
      const end = this.clusterEnd(cluster);
      if (
        end < t - keepSeconds &&
        isDone(cluster.start) &&
        isDone(Math.max(cluster.start, end - 0.1))
      ) {
        this.clusters.delete(key);
      }
    }
  }

  /** Bytes held (init segments and clusters), for diagnostics. */
  byteLength(): number {
    let total = 0;
    for (const init of this.inits.values()) total += init.length;
    for (const cluster of this.clusters.values()) {
      for (const part of cluster.parts) total += part.length;
    }
    return total;
  }

  /** Time ranges held, merged per stream, for diagnostics. */
  describe(limit = 4): string[] {
    const merged: { start: number; end: number; initKey: string }[] = [];
    for (const cluster of [...this.clusters.values()].toSorted((a, b) => a.start - b.start)) {
      const last = merged.at(-1);
      const end = this.clusterEnd(cluster);
      if (last && last.initKey === cluster.initKey && cluster.start <= last.end + 0.3) {
        last.end = Math.max(last.end, end);
      } else {
        merged.push({ start: cluster.start, end, initKey: cluster.initKey });
      }
    }
    return merged
      .slice(0, limit)
      .map((r) => `${r.start.toFixed(1)}-${r.end.toFixed(1)}(${r.initKey})`);
  }
}
