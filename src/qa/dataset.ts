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
  /**
   * Nobody talks in the stretches we capture (a silent vlog whose track describes the
   * pictures): every chunk is a no-speech chunk and every line Whisper keeps is made up.
   */
  noSpeech?: boolean;
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
  // Reality, Japanese, translation tracks only (zh-TW reference, no Japanese text)
  {
    videoId: "vgCZDibHYYo",
    language: "ja",
    category: "reality",
    voice: "multi male",
    channel: "THE ROLAND SHOW",
    translate: true,
  },
  {
    videoId: "4gJgP1i6DAA",
    language: "ja",
    category: "reality",
    voice: "multi male",
    channel: "THE ROLAND SHOW",
    translate: true,
  },
  // Interviews and lectures, Japanese
  {
    videoId: "dZgXCAWnz2c",
    language: "ja",
    category: "interview",
    voice: "low male",
    channel: "中田敦彦のYouTube大学 (× 山田孝之)",
  },
  {
    videoId: "p2Qkl30HiL4",
    language: "ja",
    category: "interview",
    voice: "low male",
    channel: "中田敦彦のYouTube大学 (lecture)",
  },
  {
    videoId: "qh5t4WMroyU",
    language: "ja",
    category: "interview",
    voice: "low male",
    channel: "中田敦彦のYouTube大学 (lecture)",
  },
  {
    videoId: "r9FKdxYS3B4",
    language: "ja",
    category: "interview",
    voice: "multi mixed",
    channel: "いがらし朝青 × 小松成美 (2021)",
  },
  {
    videoId: "D5G05hBO8GY",
    language: "ja",
    category: "interview",
    voice: "multi mixed",
    channel: "いがらし朝青 × 小松成美 (2021)",
  },
  {
    videoId: "AORyhKprcFY",
    language: "ja",
    category: "interview",
    voice: "multi male",
    channel: "米津玄師 × 吉田直樹",
  },
  {
    videoId: "tQBd744CXBM",
    language: "ja",
    category: "interview",
    voice: "female",
    channel: "日テレNEWSカルチャー (伊藤沙莉)",
  },
  {
    videoId: "LKTOWTc9l1E",
    language: "ja",
    category: "variety",
    voice: "high female",
    channel: "ホロライブ切り抜きまとめ (VTuber clips)",
  },
  // Games, Japanese
  {
    videoId: "0Fk2MSLtrs0",
    language: "ja",
    category: "game",
    voice: "synthetic",
    channel: "モーのゲーム実況 (ゆっくり実況)",
    note: "title says ゆっくり (synthesised voices)",
  },
  {
    videoId: "1lARuuPFsQ4",
    language: "ja",
    category: "game",
    voice: "synthetic",
    channel: "モーのゲーム実況 (ゆっくり実況)",
    note: "title says ゆっくり (synthesised voices)",
  },
  {
    videoId: "sV0yiaJUR4U",
    language: "ja",
    category: "game",
    voice: "synthetic",
    channel: "モーのゲーム実況 (ゆっくり実況)",
    note: "title says ゆっくり (synthesised voices)",
  },
  {
    videoId: "CnWnr8O2nMY",
    language: "ja",
    category: "game",
    voice: "male",
    channel: "ゲーミングボーイ",
    note: "game sound and English game voices",
  },
  {
    videoId: "i4rKSX8afd8",
    language: "ja",
    category: "game",
    voice: "male",
    channel: "ゲーミングボーイ (鬼武者)",
    note: "game sound and English game voices",
  },
  {
    videoId: "6HEWeWEl4hs",
    language: "ja",
    category: "control",
    voice: "synthetic",
    channel: "asdfgame (ゆっくり実況, horror game)",
  },
  // Vlogs
  {
    videoId: "JZwQr8UrEcc",
    language: "ko",
    category: "vlog",
    voice: "multi mixed",
    channel: "이호정 HOLLYDAY (talk with 김성철)",
  },
  {
    videoId: "kxVk735LST8",
    language: "ko",
    category: "vlog",
    voice: "female",
    channel: "찬 chan (Tokyo vlog, little talk)",
  },
  {
    videoId: "cth3M1iavGM",
    language: "ja",
    category: "vlog",
    voice: "low male",
    channel: "徳川の天下統一ch",
    note: "the low voice of PR #1; automatic track only",
  },
  {
    videoId: "LHZgl2pbY7Q",
    language: "ja",
    category: "control",
    voice: "bgm only",
    channel: "mitsuba vlog (#142)",
    noSpeech: true,
    note: "silent vlog: the track describes the pictures (inferred, not listened to: no automatic track, Whisper gave 3 s loops)",
  },
  {
    videoId: "5Ma5inm_Dac",
    language: "ja",
    category: "control",
    voice: "bgm only",
    channel: "mitsuba vlog (#85)",
    noSpeech: true,
    note: "silent vlog: the track describes the pictures (inferred, not listened to: no automatic track, Whisper gave 3 s loops)",
  },
  // News and documentaries
  {
    videoId: "ZcItk5mKVwE",
    language: "ja",
    category: "news",
    voice: "male",
    channel: "日テレNEWS (NNNドキュメント)",
  },
  {
    videoId: "BsY7fhYfr8s",
    language: "ja",
    category: "news",
    voice: "male",
    channel: "テレ東BIZ (documentary)",
  },
  {
    videoId: "QXzN05rrY4E",
    language: "ko",
    category: "news",
    voice: "multi mixed",
    channel: "KBS News",
  },
  {
    videoId: "FFe1ZJOyli0",
    language: "ko",
    category: "news",
    voice: "multi mixed",
    channel: "KBS News (51 s)",
  },
  {
    videoId: "lmH7BFW-pP0",
    language: "ko",
    category: "news",
    voice: "multi mixed",
    channel: "SBS 뉴스",
  },
  // Mixed languages
  {
    videoId: "1vu-uMez03U",
    language: "ja",
    category: "mixed",
    voice: "multi male",
    channel: "&TEAM (Japanese and Korean)",
  },
];
