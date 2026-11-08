// The evaluation set: video IDs with their spoken language, content type and voice type.
// Only IDs and labels live here; caption text and captures stay in .qa/ (gitignored).
// Sources and their traps: the research-youtube-captions skill. How to collect and score:
// the test-extension-in-browser skill (section "Evaluation set").

export type Category =
  | "reality"
  | "variety"
  | "interview"
  | "game"
  | "vlog"
  | "news"
  | "mixed"
  | "control";

export type Voice =
  | "low male"
  | "male"
  | "high female"
  | "female"
  | "multi male"
  | "multi female"
  | "multi mixed"
  | "synthetic"
  | "bgm only";

export interface DatasetVideo {
  videoId: string;
  language: "ja" | "ko";
  category: Category;
  voice: Voice;
  channel: string;
  /** Translate in the Whisper run (a Traditional Chinese reference exists). */
  translate?: boolean;
  note?: string;
}

export const DATASET: readonly DatasetVideo[] = [];
