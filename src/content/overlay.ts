// Caption overlay on top of YouTube's player, plus a small status badge. Built with DOM
// APIs only: YouTube enforces Trusted Types, so assigning innerHTML would throw.
// (A later stage moves captions into YouTube's own CC menu; this stays as the fallback.)

import type { Cue } from "@/shared/captions";

const FONT_FAMILY = '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif';
/** At most this many lines are shown at once. */
const MAX_LINES = 2;

export class Overlay {
  private box: HTMLDivElement | null = null;
  private status: HTMLDivElement | null = null;
  private lastKey = "";

  /** Re-attaches the elements if YouTube replaced the player. Returns the player or null. */
  private attach(): HTMLElement | null {
    const player = document.getElementById("movie_player");
    if (!player) return null;
    if (!this.box || !player.contains(this.box)) {
      this.box = document.createElement("div");
      this.box.id = "yt-ai-subs-captions";
      Object.assign(this.box.style, {
        position: "absolute",
        left: "50%",
        bottom: "11%",
        transform: "translateX(-50%)",
        maxWidth: "86%",
        textAlign: "center",
        pointerEvents: "none",
        zIndex: "60",
        fontFamily: FONT_FAMILY,
      } satisfies Partial<CSSStyleDeclaration>);
      this.status = document.createElement("div");
      this.status.id = "yt-ai-subs-status";
      Object.assign(this.status.style, {
        position: "absolute",
        top: "10px",
        right: "10px",
        zIndex: "61",
        pointerEvents: "none",
        font: "12px sans-serif",
        color: "#fff",
        background: "rgba(0,0,0,.55)",
        padding: "3px 8px",
        borderRadius: "10px",
        transition: "opacity .3s",
        opacity: "0",
      } satisfies Partial<CSSStyleDeclaration>);
      player.append(this.box, this.status);
      this.lastKey = "";
    }
    return player;
  }

  /** Shows the cues active at `t` (all of them if fewer than MAX_LINES). */
  render(cues: readonly Cue[], t: number, showOriginal: boolean): void {
    const player = this.attach();
    if (!player || !this.box) return;
    const active = cues.filter((cue) => cue.start <= t && cue.end > t).slice(-MAX_LINES);
    const fontSize = Math.max(16, (player.clientHeight || 400) * 0.045);
    const key = JSON.stringify([
      active.map((cue) => [cue.start, cue.original, cue.translation]),
      fontSize,
      showOriginal,
    ]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.box.replaceChildren(
      ...active.map((cue) => {
        const wrap = document.createElement("div");
        Object.assign(wrap.style, {
          display: "table",
          margin: "3px auto",
          padding: "2px 10px",
          background: "rgba(0,0,0,.72)",
          color: "#fff",
          borderRadius: "4px",
          lineHeight: "1.35",
        } satisfies Partial<CSSStyleDeclaration>);
        if (showOriginal && cue.translation && cue.translation !== cue.original) {
          const original = document.createElement("div");
          original.style.fontSize = `${Math.max(12, fontSize * 0.72)}px`;
          original.style.opacity = ".85";
          original.textContent = cue.original;
          wrap.append(original);
        }
        const main = document.createElement("div");
        main.style.fontSize = `${fontSize}px`;
        main.textContent = cue.translation ?? cue.original;
        wrap.append(main);
        return wrap;
      }),
    );
  }

  /** Shows a status message in the corner; an empty string hides it. */
  setStatus(message: string): void {
    if (!this.attach() || !this.status) return;
    if (this.status.textContent !== message) this.status.textContent = message;
    this.status.style.opacity = message ? "1" : "0";
  }

  clear(): void {
    this.box?.replaceChildren();
    this.lastKey = "";
  }
}
