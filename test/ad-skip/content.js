// Test-only helper, not part of yt-ai-subs: load it next to dist/ in agent-browser so YouTube
// ads do not eat test time. While #movie_player shows an ad it mutes the <video>, plays it at
// 16x, seeks to its end and clicks any skip or overlay-close button; when the ad is over it
// restores the main video's playbackRate (and muted, for an ad in the middle of the video).
// Every action logs one `[ad-skip]` line.

const SKIP_SELECTORS = [
  ".ytp-skip-ad-button",
  ".ytp-ad-skip-button",
  ".ytp-ad-skip-button-modern",
  ".ytp-ad-skip-button-container button",
  "button[id^='skip-button']",
];
const OVERLAY_CLOSE_SELECTORS = [".ytp-ad-overlay-close-button", ".ytp-ad-overlay-close-container"];
const MAX_RATE = 16; // Chrome's upper limit for HTMLMediaElement.playbackRate
const TICK_MS = 250;
const CLICK_EVERY_MS = 1000;

/**
 * The ad being handled. `restore` is the main video's state from the last tick outside an ad,
 * or null for an ad before the video (YouTube sets up the main video itself afterwards).
 * @type {{ since: number, restore: { rate: number, muted: boolean } | null, jumps: number,
 *   clicked: Set<string>, lastClick: number, stuckLogged: boolean } | null}
 */
let ad = null;
/** @type {{ rate: number, muted: boolean } | null} */
let mainState = null;
/** @type {Element | null} */
let observed = null;
let lastPath = "";

function log(...args) {
  console.log("[ad-skip]", ...args);
}

/**
 * Clicks the first visible element matching one of the selectors.
 * @param {string[]} selectors
 * @returns {string | null} the selector that matched
 */
function clickVisible(selectors) {
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      if (!(el instanceof HTMLElement) || el.offsetParent === null) continue;
      el.click();
      return selector;
    }
  }
  return null;
}

/** @param {HTMLVideoElement} video */
function describe(video) {
  const ranges = [];
  for (let i = 0; i < video.buffered.length; i++) {
    ranges.push(`${video.buffered.start(i).toFixed(1)}-${video.buffered.end(i).toFixed(1)}`);
  }
  return (
    `t ${video.currentTime.toFixed(1)}/${video.duration.toFixed(1)} s, paused ${video.paused}, ` +
    `readyState ${video.readyState}, buffered [${ranges.join(" ")}]`
  );
}

function tick() {
  const overlay = clickVisible(OVERLAY_CLOSE_SELECTORS);
  if (overlay) log(`closed overlay ad (${overlay})`);

  const player = document.querySelector("#movie_player");
  if (player && observed !== player) {
    observed = player;
    new MutationObserver(tick).observe(player, { attributes: true, attributeFilter: ["class"] });
  }
  const video = player?.querySelector("video");
  if (!player || !(video instanceof HTMLVideoElement)) return;

  const path = location.pathname + location.search;
  if (path !== lastPath) {
    // A new video (YouTube navigates without reloading): its pre-roll restores nothing.
    // An ad running across the navigation must not restore the old video's state either.
    lastPath = path;
    mainState = null;
    if (ad) ad.restore = null;
  }

  const showing =
    player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting");

  if (!showing) {
    if (ad) {
      const done = `ad over after ${Math.round(performance.now() - ad.since)} ms, ${ad.jumps} seeks`;
      if (ad.restore) {
        video.playbackRate = ad.restore.rate;
        video.muted = ad.restore.muted;
        log(`${done}; restored playbackRate ${ad.restore.rate}, muted ${ad.restore.muted}`);
      } else {
        // Unmuting here would also pause a headless (muted) autoplay, so muted stays as it is.
        video.playbackRate = 1;
        log(`${done}; playbackRate 1, muted ${video.muted}`);
      }
      ad = null;
    }
    // Only a main video that is playing counts: before a pre-roll the element is still idle.
    if (!video.paused && video.currentTime > 0 && video.playbackRate !== MAX_RATE) {
      mainState = { rate: video.playbackRate, muted: video.muted };
    }
    return;
  }

  const now = performance.now();
  if (!ad) {
    ad = {
      since: now,
      restore: mainState,
      jumps: 0,
      clicked: new Set(),
      lastClick: 0,
      stuckLogged: false,
    };
    log(`ad started at ${path}`);
  }
  if (!video.muted) video.muted = true;
  if (video.playbackRate !== MAX_RATE) video.playbackRate = MAX_RATE;
  // Muted, so autoplay rules allow it; a paused ad would never end.
  if (video.paused) video.play().catch(() => {});

  // Seeking past what is buffered stalls the ad (readyState 1) until YouTube fetches the end,
  // about 10 s for a 54 s ad buffered to 4 s; so jump to the end of the buffered data and let
  // 16x eat it, and seek to the very end only once it is buffered.
  const duration = video.duration;
  const n = video.buffered.length;
  const bufferedEnd = n > 0 ? video.buffered.end(n - 1) : 0;
  if (Number.isFinite(duration) && duration > 0) {
    const to = bufferedEnd >= duration - 0.5 ? duration : bufferedEnd - 0.1;
    if (to - video.currentTime > 0.5) {
      if (ad.jumps === 0) log(`fast-forward ad (${describe(video)})`);
      ad.jumps++;
      video.currentTime = to;
    }
  }

  if (now - ad.lastClick >= CLICK_EVERY_MS) {
    ad.lastClick = now;
    const skip = clickVisible(SKIP_SELECTORS);
    if (skip && !ad.clicked.has(skip)) {
      ad.clicked.add(skip);
      log(`clicked skip (${skip})`);
    }
  }

  if (!ad.stuckLogged && now - ad.since > 10_000) {
    ad.stuckLogged = true;
    log(`ad still showing after 10 s: ${describe(video)}`);
  }
}

log("loaded");
setInterval(tick, TICK_MS);
