import { useEffect, useState } from "react";
import type { DisplayModeReply, GetDisplayModeMessage } from "@/shared/messages";

const WATCH_URLS = ["https://www.youtube.com/watch*"];

/** The YouTube tab the popup is about: the active tab, else the last used YouTube tab. */
async function youTubeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.url?.startsWith("https://www.youtube.com/")) return active;
  const tabs = await chrome.tabs.query({ url: WATCH_URLS });
  return tabs.toSorted((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
}

type State = { kind: "loading" } | { kind: "none" } | { kind: "reply"; reply: DisplayModeReply };

function describe(state: State): string {
  if (state.kind === "loading") return "讀取中…";
  if (state.kind === "none") return "沒有開著的 YouTube 影片";
  const { mode, reason } = state.reply;
  if (!state.reply.videoId) return "這個分頁沒有在看影片";
  if (mode === "cc") return "YouTube 字幕選單（CC）";
  if (mode === "overlay") return `備用疊加字幕${reason ? `（${reason}）` : ""}`;
  return "確認中…";
}

/** Which way the current YouTube tab shows captions: the CC menu or the overlay. */
export function DisplayModeStatus() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      try {
        const tab = await youTubeTab();
        if (!tab?.id) {
          if (!stopped) setState({ kind: "none" });
          return;
        }
        const reply = (await chrome.tabs.sendMessage(tab.id, {
          type: "get-display-mode",
        } satisfies GetDisplayModeMessage)) as DisplayModeReply | undefined;
        if (!stopped) setState(reply ? { kind: "reply", reply } : { kind: "none" });
      } catch {
        // No content script in that tab (e.g. opened before the extension was loaded).
        if (!stopped) setState({ kind: "none" });
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <p className="text-sm text-muted-foreground" data-testid="display-mode">
      字幕顯示：{describe(state)}
    </p>
  );
}
