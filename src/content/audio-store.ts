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
  /**
   * WebM: the last bytes of the stream so far (at most HEADER_CARRY), kept because a cluster
   * header can start in one append and end in the next; they are already stored in `open`
   * (or the init) and get moved to the new cluster when its header turns out to start there.
   */
  tail: Uint8Array;
  /** WebM: byte offset in the stream of the last cluster header found (-1: none yet). */
  lastHeader: number;
  /** WebM: bytes seen on this stream since its init segment, init included. */
  offset: number;
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

/**
 * Audio further than this from the playhead (seconds) is dropped. YouTube's own audio
 * buffer holds a few minutes; beyond it, coming back makes YouTube append the audio again.
 */
export const MAX_DISTANCE_SECONDS = 600;

/**
 * Longest Cluster header findClusters needs (ID 4 + size 8 + CRC-32 6 + Timecode 1 + 8 + 8),
 * rounded up: the bytes kept from one append in case a header continues in the next.
 */
const HEADER_CARRY = 40;

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
      stream = {
        initKey,
        format: webm ? "webm" : "mp4",
        scale: webm ? timecodeScaleSeconds(bytes) : 0,
        open: null,
        tail: new Uint8Array(0),
        lastHeader: -1,
        offset: 0,
      };
      this.streams.set(bufferId, stream);
      if (webm) {
        // The init and any clusters after it, in the same append, go through appendWebm.
        this.inits.set(initKey, new Uint8Array(0));
        this.appendWebm(stream, bytes);
        return;
      }
      this.inits.set(initKey, bytes); // MP4 init: kept whole (rarely includes a first fragment)
      media = null;
    }
    if (!stream) {
      this.droppedWithoutInit++;
      return;
    }
    if (!media || !media.length) return;

    if (stream.format === "webm") {
      this.appendWebm(stream, media);
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

  /**
   * Splits a WebM append into clusters. A cluster header may have started in the previous
   * append: the header search runs over the kept tail plus this append, and the bytes of a
   * header found in the tail move from where they were stored (the previous cluster or the
   * init) to the new cluster.
   */
  private appendWebm(stream: Stream, media: Uint8Array): void {
    const isFirst = stream.offset === 0;
    // An append that starts with a whole cluster header (a seek, or the usual cluster-aligned
    // append) starts there: the tail is not joined to it, so a header cut off by an aborted
    // append can't swallow the real one.
    const aligned = !isFirst && findClusters(media.subarray(0, HEADER_CARRY * 2))[0]?.pos === 0;
    const tail = aligned ? new Uint8Array(0) : stream.tail;
    const combined = tail.length ? concatBytes([tail, media]) : media;
    const base = stream.offset - tail.length; // stream offset of combined[0]
    const found = findClusters(combined).filter((h) => base + h.pos > stream.lastHeader);

    const firstPos = found[0]?.pos ?? combined.length;
    if (firstPos < tail.length) {
      this.trimOwner(stream, tail.length - firstPos);
    } else if (firstPos > tail.length) {
      this.extendOwner(stream, combined.slice(tail.length, firstPos));
    }
    for (let i = 0; i < found.length; i++) {
      const header = found[i]!;
      const next = found[i + 1];
      const cluster: Cluster = {
        initKey: stream.initKey,
        start: header.timecode * stream.scale,
        parts: [combined.slice(header.pos, next ? next.pos : combined.length)],
        scale: stream.scale,
        fixedEnd: false,
        end: header.timecode * stream.scale,
        endLength: -1,
      };
      // A re-sent cluster replaces the old copy.
      this.clusters.set(`${stream.initKey}@${header.timecode}`, cluster);
      stream.open = cluster;
      stream.lastHeader = base + header.pos;
    }
    stream.offset += media.length;
    stream.tail = combined.slice(Math.max(0, combined.length - HEADER_CARRY));
  }

  /** Stores bytes that continue the open cluster, or the init before the first cluster. */
  private extendOwner(stream: Stream, bytes: Uint8Array): void {
    if (stream.open) {
      stream.open.parts.push(bytes);
      stream.open.endLength = -1;
    } else {
      const init = this.inits.get(stream.initKey) ?? new Uint8Array(0);
      this.inits.set(stream.initKey, concatBytes([init, bytes]));
    }
  }

  /** Removes the last `count` bytes stored for the open cluster (or the init). */
  private trimOwner(stream: Stream, count: number): void {
    if (stream.open) {
      const parts = stream.open.parts;
      while (count > 0 && parts.length) {
        const last = parts.at(-1)!;
        if (last.length <= count) {
          count -= last.length;
          parts.pop();
        } else {
          parts[parts.length - 1] = last.subarray(0, last.length - count);
          count = 0;
        }
      }
      stream.open.endLength = -1;
    } else {
      const init = this.inits.get(stream.initKey);
      if (init) this.inits.set(stream.initKey, init.subarray(0, Math.max(0, init.length - count)));
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

  /**
   * Drops audio no chunk will need: clusters that ended more than `keepSeconds` before `t`
   * and that `isDone` says are transcribed, and any cluster more than `maxDistance` away
   * from `t`, done or not (left behind by seeks, or never sent: extension off, no key, out
   * of budget). YouTube keeps less than that in its own buffer and appends it again when
   * the viewer comes back, so this bounds memory on long videos without losing audio.
   */
  prune(
    t: number,
    isDone: (time: number) => boolean,
    keepSeconds = 120,
    maxDistance = MAX_DISTANCE_SECONDS,
  ): void {
    for (const [key, cluster] of this.clusters) {
      const end = this.clusterEnd(cluster);
      const behindAndDone =
        end < t - keepSeconds &&
        isDone(cluster.start) &&
        isDone(Math.max(cluster.start, end - 0.1));
      if (behindAndDone || end < t - maxDistance || cluster.start > t + maxDistance) {
        this.clusters.delete(key);
      }
    }
    // Init segments of streams that have no clusters left and are not current.
    const current = new Set([...this.streams.values()].map((stream) => stream.initKey));
    const used = new Set([...this.clusters.values()].map((cluster) => cluster.initKey));
    for (const key of this.inits.keys()) {
      if (!current.has(key) && !used.has(key)) this.inits.delete(key);
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
