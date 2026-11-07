// Minimal WebM (EBML) reading: find Clusters and their timestamps in the bytes YouTube
// appends, so chunk times come from the media itself rather than from buffered ranges.

const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75] as const;
const TIMECODE_ID = 0xe7;
const CRC32_ID = 0xbf;
const SIMPLE_BLOCK_ID = 0xa3;
const BLOCK_GROUP_ID = 0xa0;
const BLOCK_ID = 0xa1;
/** Matroska's default TimecodeScale: 1 ms per tick. */
const DEFAULT_TIMECODE_SCALE_NS = 1_000_000;

export interface Vint {
  value: number;
  length: number;
  /** All value bits set: an element of unknown size (only meaningful for sizes). */
  unknown: boolean;
}

/**
 * Reads an EBML variable-length integer at `pos`. `keepMarker` keeps the length marker bit,
 * which is how element IDs are written. Returns null when the bytes are cut off or invalid.
 */
export function readVint(bytes: Uint8Array, pos: number, keepMarker: boolean): Vint | null {
  const first = bytes[pos];
  if (first === undefined || first === 0) return null;
  let length = 1;
  let mask = 0x80;
  while (!(first & mask)) {
    length++;
    mask >>= 1;
  }
  if (pos + length > bytes.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < length; i++) {
    const byte = bytes[pos + i]!;
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

function readUint(bytes: Uint8Array, pos: number, length: number): number {
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + bytes[pos + i]!;
  return value;
}

export function isWebmInit(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  );
}

/** Seconds per Cluster/Block timecode tick, from an init segment (default 1 ms). */
export function timecodeScaleSeconds(init: Uint8Array): number {
  const limit = Math.min(init.length - 4, 4096);
  for (let i = 0; i < limit; i++) {
    if (init[i] === 0x2a && init[i + 1] === 0xd7 && init[i + 2] === 0xb1) {
      const size = readVint(init, i + 3, false);
      if (
        size &&
        size.value >= 1 &&
        size.value <= 8 &&
        i + 3 + size.length + size.value <= init.length
      ) {
        return readUint(init, i + 3 + size.length, size.value) / 1e9;
      }
    }
  }
  return DEFAULT_TIMECODE_SCALE_NS / 1e9;
}

export interface ClusterHeader {
  /** Byte offset of the Cluster ID. */
  pos: number;
  /** Cluster Timecode, in ticks. */
  timecode: number;
}

/** Finds every Cluster header in `bytes`, with its Timecode. */
export function findClusters(bytes: Uint8Array): ClusterHeader[] {
  const found: ClusterHeader[] = [];
  for (let i = 0; i + 8 < bytes.length; i++) {
    if (
      bytes[i] !== CLUSTER_ID[0] ||
      bytes[i + 1] !== CLUSTER_ID[1] ||
      bytes[i + 2] !== CLUSTER_ID[2] ||
      bytes[i + 3] !== CLUSTER_ID[3]
    ) {
      continue;
    }
    const size = readVint(bytes, i + 4, false);
    if (!size) continue;
    let p = i + 4 + size.length;
    // Timecode is normally the first child; allow a CRC-32 before it.
    if (bytes[p] === CRC32_ID) {
      const crcSize = readVint(bytes, p + 1, false);
      if (!crcSize) continue;
      p += 1 + crcSize.length + crcSize.value;
    }
    if (bytes[p] !== TIMECODE_ID) continue;
    const tcSize = readVint(bytes, p + 1, false);
    if (!tcSize || tcSize.value < 1 || tcSize.value > 8) continue;
    if (p + 1 + tcSize.length + tcSize.value > bytes.length) continue;
    found.push({ pos: i, timecode: readUint(bytes, p + 1 + tcSize.length, tcSize.value) });
    i = p;
  }
  return found;
}

/** Relative timecode (signed 16-bit) of a Block or SimpleBlock whose payload starts at `data`. */
function blockTimecode(bytes: Uint8Array, data: number): number | null {
  const track = readVint(bytes, data, false);
  if (!track || data + track.length + 2 > bytes.length) return null;
  let rel = (bytes[data + track.length]! << 8) | bytes[data + track.length + 1]!;
  if (rel > 32767) rel -= 65536;
  return rel;
}

/**
 * Largest block timecode (ticks, relative to the cluster) found in a cluster's bytes, which
 * start with the Cluster ID. The bytes may be incomplete; whatever is present is scanned.
 */
export function maxBlockTimecode(cluster: Uint8Array): number {
  const size = readVint(cluster, 4, false);
  if (!size) return 0;
  let p = 4 + size.length;
  const end = size.unknown ? cluster.length : Math.min(cluster.length, p + size.value);
  let max = 0;
  while (p < end) {
    const id = readVint(cluster, p, true);
    if (!id) break;
    const elSize = readVint(cluster, p + id.length, false);
    if (!elSize) break;
    const data = p + id.length + elSize.length;
    if (id.value === SIMPLE_BLOCK_ID || id.value === BLOCK_ID) {
      const rel = blockTimecode(cluster, data);
      if (rel !== null && rel > max) max = rel;
    } else if (id.value === BLOCK_GROUP_ID) {
      const inner = cluster.subarray(data, Math.min(cluster.length, data + elSize.value));
      let q = 0;
      while (q < inner.length) {
        const innerId = readVint(inner, q, true);
        if (!innerId) break;
        const innerSize = readVint(inner, q + innerId.length, false);
        if (!innerSize) break;
        const innerData = q + innerId.length + innerSize.length;
        if (innerId.value === BLOCK_ID) {
          const rel = blockTimecode(inner, innerData);
          if (rel !== null && rel > max) max = rel;
        }
        q = innerData + innerSize.value;
      }
    }
    if (elSize.unknown) break;
    p = data + elSize.value;
  }
  return max;
}
