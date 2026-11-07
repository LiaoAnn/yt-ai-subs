import { useEffect, useState } from "react";
import type { Dimension, LimiterState, RequestKind } from "@/background/rate-limiter";
import { cn } from "@/lib/utils";
import {
  LIMITER_STORAGE_KEY,
  TRANSLATION_PAUSED_MESSAGE,
  USAGE_STORAGE_KEY,
  levelOf,
  parseLedger,
  quotaFor,
  type DailyBudget,
  type QuotaLevel,
  type UsageLedger,
  type VideoUsage,
} from "@/shared/quota";
import { videoIdFromUrl } from "@/shared/youtube";
import { youTubeTab } from "./DisplayModeStatus";

const KIND_LABELS: Record<RequestKind, string> = { whisper: "語音辨識", chat: "翻譯" };
const DIMENSION_LABELS: Record<Dimension, string> = {
  requests: "請求",
  audioSeconds: "音訊秒數",
  tokens: "tokens",
};

const number = (value: number) => Math.round(value).toLocaleString("zh-TW");

function resetIn(resetAt: number, now: number): string {
  const minutes = Math.max(1, Math.round((resetAt - now) / 60_000));
  if (minutes < 60) return `${minutes} 分後重設`;
  return `${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分後重設`;
}

function warning(kind: RequestKind, level: QuotaLevel): string | null {
  if (level === "ok") return null;
  if (kind === "chat") return TRANSLATION_PAUSED_MESSAGE;
  return level === "out"
    ? "今天的語音辨識額度用完了，暫停產生字幕"
    : "語音辨識額度剩不到 10%，放慢預讀（一次一段）";
}

function BudgetRow({ budget, now }: { budget: DailyBudget; now: number }) {
  const share = budget.limit > 0 ? budget.remaining / budget.limit : 0;
  const level = levelOf(budget);
  return (
    <li className="grid gap-0.5">
      <div className="flex justify-between gap-2">
        <span className="shrink-0">{DIMENSION_LABELS[budget.dimension]}</span>
        <span className="tabular-nums">
          剩 {number(budget.remaining)} / {number(budget.limit)}
          {budget.source === "estimate" ? "（估）" : ""}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded bg-muted" aria-hidden="true">
        <div
          className={cn(
            "h-full",
            level === "ok" ? "bg-primary" : level === "low" ? "bg-amber-500" : "bg-destructive",
          )}
          style={{ width: `${Math.min(100, share * 100)}%` }}
        />
      </div>
      {budget.resetAt !== null && (
        <span className="text-xs text-muted-foreground">
          Groq 回報，{resetIn(budget.resetAt, now)}
        </span>
      )}
    </li>
  );
}

function videoSummary(usage: VideoUsage | undefined): string {
  if (!usage) return "還沒用到額度";
  const parts = [
    `語音辨識 ${number(usage.whisper.requests)} 次、${number(usage.whisper.audioSeconds)} 秒`,
  ];
  if (usage.chat.requests) {
    parts.push(`翻譯 ${number(usage.chat.requests)} 次、${number(usage.chat.tokens)} tokens`);
  }
  return parts.join("；");
}

interface Data {
  limiter: LimiterState | undefined;
  ledger: UsageLedger;
  videoId: string | null;
  /** When it was read; budgets are computed for this time. */
  now: number;
}

/** What is left of today's Groq budget, and what the current video used. */
export function QuotaStatus() {
  const [data, setData] = useState<Data | null>(null);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const [session, local, tab] = await Promise.all([
          chrome.storage.session.get(LIMITER_STORAGE_KEY),
          chrome.storage.local.get(USAGE_STORAGE_KEY),
          youTubeTab().catch(() => undefined),
        ]);
        if (stopped) return;
        setData({
          limiter: session[LIMITER_STORAGE_KEY] as LimiterState | undefined,
          ledger: parseLedger(local[USAGE_STORAGE_KEY]),
          videoId: tab?.url ? videoIdFromUrl(tab.url) : null,
          now: Date.now(),
        });
      } catch {
        // Storage unavailable: keep what is shown.
      }
    };
    void load();
    const onChanged = (changes: Record<string, unknown>) => {
      if (LIMITER_STORAGE_KEY in changes || USAGE_STORAGE_KEY in changes) void load();
    };
    chrome.storage.onChanged.addListener(onChanged);
    const timer = setInterval(() => void load(), 5000);
    return () => {
      stopped = true;
      chrome.storage.onChanged.removeListener(onChanged);
      clearInterval(timer);
    };
  }, []);

  if (!data) return null;
  const { now } = data;
  const kinds: RequestKind[] = ["whisper", "chat"];
  const quotas = kinds.map((kind) => ({
    kind,
    quota: quotaFor(kind, data.limiter, data.ledger, now),
  }));
  const warnings = quotas
    .map(({ kind, quota }) => warning(kind, quota.level))
    .filter((text): text is string => text !== null);

  return (
    <section className="grid gap-2 text-sm" data-testid="quota" aria-label="Groq 今日額度">
      <h2 className="font-medium">Groq 今日額度</h2>
      {warnings.map((text) => (
        <p
          key={text}
          className="rounded-md border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-xs"
        >
          {text}
        </p>
      ))}
      <div className="grid gap-3">
        {quotas.map(({ kind, quota }) => (
          <div key={kind} className="grid gap-1">
            <h3 className="text-xs font-medium text-muted-foreground">{KIND_LABELS[kind]}</h3>
            <ul className="grid gap-1.5 text-xs">
              {quota.daily.map((budget) => (
                <BudgetRow key={budget.dimension} budget={budget} now={now} />
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground" data-testid="video-usage">
        這支影片：{data.videoId ? videoSummary(data.ledger.videos[data.videoId]) : "沒有開著的影片"}
      </p>
      <p className="text-xs text-muted-foreground">（估）＝用本機近 24 小時的用量估計</p>
    </section>
  );
}
