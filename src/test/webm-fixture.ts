// Builds tiny synthetic WebM byte streams for unit tests (no audio payload of note).

function sizeVint(size: number): number[] {
  if (size < 0x7f) return [0x80 | size];
  if (size < 0x3fff) return [0x40 | (size >> 8), size & 0xff];
  throw new Error("fixture element too large");
}

function uintBytes(value: number): number[] {
  const out: number[] = [];
  do {
    out.unshift(value & 0xff);
    value = Math.floor(value / 256);
  } while (value > 0);
  return out;
}

export function element(id: number[], data: number[]): number[] {
  return [...id, ...sizeVint(data.length), ...data];
}

/** Unknown-size element (size vint all ones), as live streams use for Segment/Cluster. */
export function unknownSizeElement(id: number[], data: number[]): number[] {
  return [...id, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...data];
}

export function simpleBlock(relativeTimecode: number, payload = [0, 0, 0]): number[] {
  const rel = relativeTimecode < 0 ? relativeTimecode + 65536 : relativeTimecode;
  return element([0xa3], [0x81, rel >> 8, rel & 0xff, 0x80, ...payload]);
}

/** A Cluster with a Timecode and SimpleBlocks at the given relative timecodes. */
export function cluster(timecode: number, blockTimecodes: number[]): number[] {
  const children = [
    ...element([0xe7], uintBytes(timecode)),
    ...blockTimecodes.flatMap((rel) => simpleBlock(rel)),
  ];
  return element([0x1f, 0x43, 0xb6, 0x75], children);
}

/** EBML header + Segment (unknown size) + Info with a TimecodeScale (ns). */
export function initSegment(timecodeScaleNs = 1_000_000): number[] {
  const ebml = element(
    [0x1a, 0x45, 0xdf, 0xa3],
    element([0x42, 0x82], [...new TextEncoder().encode("webm")]),
  );
  const info = element(
    [0x15, 0x49, 0xa9, 0x66],
    element([0x2a, 0xd7, 0xb1], uintBytes(timecodeScaleNs)),
  );
  return [...ebml, ...unknownSizeElement([0x18, 0x53, 0x80, 0x67], info)];
}

export const bytes = (...parts: number[][]) => new Uint8Array(parts.flat());
