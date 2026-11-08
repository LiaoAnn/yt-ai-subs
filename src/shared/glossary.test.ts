import { describe, expect, it } from "vitest";
import {
  MAX_GLOSSARY_ENTRIES,
  mergeTerms,
  parseGlossary,
  parseReplyTerms,
  relevantTerms,
  type Glossary,
} from "./glossary";

describe("mergeTerms", () => {
  it("keeps the first rendering of a term", () => {
    const glossary: Glossary = {};
    expect(mergeTerms(glossary, { 유재석: "劉在錫" }, ["유재석이 왔어요"])).toEqual([
      ["유재석", "劉在錫"],
    ]);
    expect(
      mergeTerms(glossary, { 유재석: "柳在石", 지석진: "池石鎮" }, ["유재석, 지석진"]),
    ).toEqual([["지석진", "池石鎮"]]);
    expect(glossary).toEqual({ 유재석: "劉在錫", 지석진: "池石鎮" });
  });

  it("ignores terms that are not in the lines, too short, too long or not strings", () => {
    const glossary: Glossary = {};
    const added = mergeTerms(
      glossary,
      { 송강호: "宋康昊", 가: "嘉", 유재석: 3, ["아".repeat(40)]: "x", 핑계고: "" },
      ["가 유재석 아아 핑계고"],
    );
    expect(added).toEqual([]);
    expect(mergeTerms(glossary, ["not", "an object"], ["not"])).toEqual([]);
    expect(mergeTerms(glossary, null, [""])).toEqual([]);
  });

  it("matches terms regardless of spaces and case", () => {
    const glossary: Glossary = { "Running Man": "Running Man" };
    expect(mergeTerms(glossary, { runningman: "跑男" }, ["running man 봤어"])).toEqual([]);
  });

  it("stops at the maximum size", () => {
    const glossary: Glossary = Object.fromEntries(
      Array.from({ length: MAX_GLOSSARY_ENTRIES }, (_, i) => [`term${i}`, `t${i}`]),
    );
    expect(mergeTerms(glossary, { 유재석: "劉在錫" }, ["유재석"])).toEqual([]);
  });
});

describe("relevantTerms", () => {
  it("sends only entries whose term occurs in the lines or context, in order", () => {
    const glossary: Glossary = { 유재석: "劉在錫", 지석진: "池石鎮", 양세찬: "梁世燦" };
    expect(relevantTerms(glossary, ["양세찬이랑", "유 재석 형"])).toEqual([
      ["유재석", "劉在錫"],
      ["양세찬", "梁世燦"],
    ]);
    expect(relevantTerms(glossary, ["아무도 없어"])).toEqual([]);
    expect(relevantTerms(glossary, ["유재석 지석진 양세찬"], 2)).toHaveLength(2);
  });
});

describe("parseGlossary", () => {
  it("reads a stored glossary and rejects anything else", () => {
    expect(parseGlossary({ 유재석: "劉在錫", bad: 3, "": "x" })).toEqual({ 유재석: "劉在錫" });
    expect(parseGlossary(undefined)).toEqual({});
    expect(parseGlossary([["a", "b"]])).toEqual({});
  });
});

describe("parseReplyTerms", () => {
  it("reads the terms object from the translator's reply", () => {
    expect(parseReplyTerms('{"1": "嗨", "terms": {"유재석": "劉在錫"}}')).toEqual({
      유재석: "劉在錫",
    });
    expect(parseReplyTerms('{"1": "嗨"}')).toBeNull();
    expect(parseReplyTerms('{"terms": ["x"]}')).toBeNull();
    expect(parseReplyTerms("nope")).toBeNull();
  });
});
