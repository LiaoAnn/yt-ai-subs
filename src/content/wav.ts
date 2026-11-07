// Decodes buffered audio for [start, end] and re-encodes it as 16 kHz mono 16-bit WAV,
// the smallest input Whisper takes without loss that matters for speech.

import { LOG_PREFIX } from "@/shared/log";
import { concatBytes, type AudioStore } from "./audio-store";

export const WAV_SAMPLE_RATE = 16_000;

/** PCM WAV (mono, 16-bit) from float samples in [-1, 1]. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Renders [start, end] from the store's buffered audio as 16 kHz mono samples (silence
 * where nothing is buffered). Returns null if nothing is buffered there yet; throws if the
 * audio could not be decoded.
 */
export async function renderAudio(
  store: AudioStore,
  start: number,
  end: number,
  signal: AbortSignal,
): Promise<{ duration: number; samples: Float32Array } | null> {
  const { runs, initKey } = store.coverage(start, end);
  const init = initKey === undefined ? undefined : store.inits.get(initKey);
  if (!runs.length || !init) return null;
  const duration = end - start;
  const context = new OfflineAudioContext(
    1,
    Math.ceil(duration * WAV_SAMPLE_RATE),
    WAV_SAMPLE_RATE,
  );
  let placed = 0;
  for (const run of runs) {
    signal.throwIfAborted();
    try {
      const bytes = concatBytes([init, ...run.clusters.flatMap((cluster) => cluster.parts)]);
      const decoded = await new OfflineAudioContext(1, 1, 48_000).decodeAudioData(bytes.buffer);
      const when = Math.max(0, run.start - start);
      const offset = Math.max(0, start - run.start);
      const length = Math.min(decoded.duration - offset, duration - when);
      if (length <= 0.05) continue;
      const source = context.createBufferSource();
      source.buffer = decoded;
      source.connect(context.destination);
      source.start(when, offset, length);
      placed += length;
    } catch (error) {
      console.warn(LOG_PREFIX, "could not decode one run", error);
    }
  }
  signal.throwIfAborted();
  if (placed < 0.5) throw new Error("音訊解碼失敗");
  const rendered = await context.startRendering();
  signal.throwIfAborted();
  return { duration, samples: rendered.getChannelData(0) };
}
