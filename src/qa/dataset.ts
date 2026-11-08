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

export const DATASET: readonly DatasetVideo[] = [
  // Reality, Japanese
  {
    videoId: "Il3rOIG-6pg",
    language: "ja",
    category: "reality",
    voice: "multi male",
    channel: "ナイモンチャンネル (Howling Love #1)",
    translate: true,
  },
  {
    videoId: "GOwhmdNRpok",
    language: "ja",
    category: "reality",
    voice: "multi male",
    channel: "ナイモンチャンネル (Howling Love #2)",
  },
  {
    videoId: "aM1OkS_O6-k",
    language: "ja",
    category: "reality",
    voice: "multi male",
    channel: "ナイモンチャンネル (Howling Love #5)",
    translate: true,
  },
  {
    videoId: "fkKmhniOimA",
    language: "ja",
    category: "reality",
    voice: "multi female",
    channel: "Netflix Japan (ラヴ上等 女子会)",
  },
  // Reality, Korean
  {
    videoId: "wGri81E7g_E",
    language: "ko",
    category: "reality",
    voice: "multi female",
    channel: "스탠바이미 (너의 연애 EP2)",
  },
  {
    videoId: "bQ1-VvITMvY",
    language: "ko",
    category: "reality",
    voice: "multi mixed",
    channel: "스탠바이미 (photoshoot, BGM)",
  },
  {
    videoId: "EvPQYnWQ6xQ",
    language: "ko",
    category: "reality",
    voice: "multi mixed",
    channel: "스탠바이미",
  },
  {
    videoId: "LJmbmrWKoEs",
    language: "ko",
    category: "reality",
    voice: "multi mixed",
    channel: "스탠바이미",
  },
  {
    videoId: "4pTFJtnmmXE",
    language: "ko",
    category: "reality",
    voice: "multi female",
    channel: "라잌댓 (너의 연애 6화)",
  },
  {
    videoId: "GDAGq2v2mdw",
    language: "ko",
    category: "reality",
    voice: "multi female",
    channel: "라잌댓 (너의 연애 13화)",
  },
  {
    videoId: "P_uQuBx8Sw0",
    language: "ko",
    category: "reality",
    voice: "multi mixed",
    channel: "romancecode (로맨스 코드 S2 1화)",
  },
  // Variety and talk, Korean
  {
    videoId: "cF5pOf5RYyU",
    language: "ko",
    category: "variety",
    voice: "multi mixed",
    channel: "뜬뜬 (핑계고 EP.120)",
  },
  {
    videoId: "XH_RhjO5d5c",
    language: "ko",
    category: "variety",
    voice: "multi male",
    channel: "뜬뜬 (풍향고2 EP.1)",
  },
  {
    videoId: "aNe9JTBf8Tw",
    language: "ko",
    category: "variety",
    voice: "multi male",
    channel: "짠한형 신동엽 (EP.134)",
  },
  {
    videoId: "nOSYk1M9KBo",
    language: "ko",
    category: "variety",
    voice: "multi male",
    channel: "짠한형 신동엽 (EP.168)",
  },
  {
    videoId: "9ZDTl4fgfqs",
    language: "ko",
    category: "variety",
    voice: "multi male",
    channel: "아이돌 인간극장 (NCT 127)",
  },
  {
    videoId: "jHoBqAugyhM",
    language: "ko",
    category: "variety",
    voice: "multi male",
    channel: "KBS Kpop (ATEEZ)",
  },
  {
    videoId: "_xhw8bUhWOk",
    language: "ko",
    category: "variety",
    voice: "multi mixed",
    channel: "JTBC Voyage (아는 형님, BLACKPINK)",
    note: "BGM under talk",
  },
  {
    videoId: "oYUwZrf43mc",
    language: "ko",
    category: "variety",
    voice: "multi mixed",
    channel: "SBS (미운 우리 새끼, 2020)",
  },
  // Variety, Japanese
  {
    videoId: "qtqEsIDUoXY",
    language: "ja",
    category: "variety",
    voice: "multi female",
    channel: "乃木坂配信中 (乃木坂工事中 #411)",
  },
  {
    videoId: "ByUh5ZUTMw4",
    language: "ja",
    category: "variety",
    voice: "multi male",
    channel: "Snow Man",
  },
];
