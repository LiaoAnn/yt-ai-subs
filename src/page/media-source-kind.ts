// Which MediaSource holds the main video's audio, and which an ad's. Pure logic; the page
// script (index.ts) feeds it what it sees.
//
// An ad gets its own MediaSource (and audio SourceBuffer) on the same <video> element.
// `#movie_player.ad-showing` alone is not enough: it can be set after the ad's first
// appends, and it is still set when the main video's MediaSource is created again after a
// pre-roll (cleared 100 ms later in one capture). So each MediaSource is classified, and
// its segments are held back until it is:
// - "main" once its duration matches the length of the video in the URL (YouTube sets the
//   duration before the first append; an ad's duration is its own length); if it was seen
//   during an ad, only once `ad-showing` clears while it is still attached (an ad exactly
//   as long as the video is held until it is detached, and then counts as an ad);
// - "ad" once its duration is known and does not match, and `ad-showing` was seen while it
//   was attached to the player's <video>;
// - after `HOLD_MS` without either (a live stream has an infinite duration, a length may be
//   missing), "fallback": each append is kept unless `ad-showing` is set at that moment, as
//   before this check existed.
// "main" and "ad" are final; "fallback" too, but it still drops appends during an ad.

export type MediaSourceKind = "pending" | "main" | "ad" | "fallback";

/** How long segments of an unclassified MediaSource are held back. */
export const HOLD_MS = 5000;
/** Seconds a main MediaSource's duration may differ from the video's `lengthSeconds`. */
export const LENGTH_TOLERANCE = 2;

export interface MediaSourceFacts {
  /** `MediaSource.duration` now (NaN before it is set, Infinity for a live stream). */
  duration: number;
  /** `videoDetails.lengthSeconds` of the video in the URL, if a player response had it. */
  mainLength: number | null;
  /** `ad-showing` was seen while this MediaSource was attached to the player's <video>. */
  adSeen: boolean;
  /** The player's <video> plays from it now. */
  attached: boolean;
  /** `ad-showing` is set on the player now. */
  adShowing: boolean;
  /** Milliseconds since the MediaSource got its first SourceBuffer. */
  ageMs: number;
}

export function classifyMediaSource(facts: MediaSourceFacts): MediaSourceKind {
  const comparable =
    facts.mainLength !== null && facts.mainLength > 0 && Number.isFinite(facts.duration);
  const matches = comparable && Math.abs(facts.duration - facts.mainLength!) <= LENGTH_TOLERANCE;
  if (matches && facts.adSeen) {
    // Either the main video, created while ad-showing was still set after an ad, or an ad
    // as long as the video. The first is still attached when the class clears; the second
    // is detached when the main video takes over the <video>. No time limit: nothing is
    // lost by holding the segments until one of them happens.
    if (!facts.attached) return "ad";
    return facts.adShowing ? "pending" : "main";
  }
  if (matches) return "main";
  if (comparable && !matches && facts.adSeen) return "ad";
  return facts.ageMs >= HOLD_MS ? "fallback" : "pending";
}

/** Whether one append's segment is passed on to the content script. */
export function keepSegment(kind: MediaSourceKind, adShowingAtAppend: boolean): boolean {
  if (kind === "main") return true;
  if (kind === "fallback") return !adShowingAtAppend;
  return false;
}

/** What the page script sees of one MediaSource at one moment. */
export interface MediaSourceObservation {
  duration: number;
  mainLength: number | null;
  attached: boolean;
  adShowing: boolean;
  /** Milliseconds since epoch. */
  now: number;
}

/**
 * One MediaSource's classification and the segments held back until it is known. The page
 * script observes (`update`, on every append and on a timer while pending) and offers each
 * append's segment (`offer`); both return the segments to pass on now, in append order.
 */
export class MediaSourceGate<T> {
  kind: MediaSourceKind = "pending";
  private adSeen = false;
  private held: { item: T; adShowing: boolean }[] = [];
  /** How many held segments the last settling kept and dropped (for the log). */
  settled = { kept: 0, dropped: 0 };

  constructor(private readonly createdAt: number) {}

  update(observation: MediaSourceObservation): T[] {
    if (this.kind !== "pending") return [];
    if (observation.adShowing && observation.attached) this.adSeen = true;
    this.kind = classifyMediaSource({
      duration: observation.duration,
      mainLength: observation.mainLength,
      adSeen: this.adSeen,
      attached: observation.attached,
      adShowing: observation.adShowing,
      ageMs: observation.now - this.createdAt,
    });
    if (this.kind === "pending") return [];
    const kind = this.kind;
    const kept = this.held.filter((held) => keepSegment(kind, held.adShowing));
    this.settled = { kept: kept.length, dropped: this.held.length - kept.length };
    this.held = [];
    return kept.map((held) => held.item);
  }

  /** One append's segment, with whether `ad-showing` was set when it was appended. */
  offer(item: T, adShowingAtAppend: boolean): T[] {
    if (this.kind === "pending") {
      this.held.push({ item, adShowing: adShowingAtAppend });
      return [];
    }
    return keepSegment(this.kind, adShowingAtAppend) ? [item] : [];
  }
}

/** `videoDetails.lengthSeconds` of a player response, if it has a positive one. */
export function lengthSecondsOf(response: unknown): { videoId: string; seconds: number } | null {
  if (typeof response !== "object" || response === null) return null;
  const details = (response as { videoDetails?: unknown }).videoDetails;
  if (typeof details !== "object" || details === null) return null;
  const { videoId, lengthSeconds } = details as { videoId?: unknown; lengthSeconds?: unknown };
  const seconds = Number(lengthSeconds);
  if (typeof videoId !== "string" || !Number.isFinite(seconds) || seconds <= 0) return null;
  return { videoId, seconds };
}
