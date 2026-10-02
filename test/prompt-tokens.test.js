import { test } from "node:test";
import assert from "node:assert/strict";
import { splitTop, parsePrompt, formatPrompt, tagKey, tagToPrompt, currentSegment, parseToken } from "../public/js/prompt-tokens.js";

test("쉼표로 나누되 괄호 안 쉼표는 지킨다", () => {
  assert.deepEqual(splitTop("a, (b, c:1.2), d\\(x\\), "), ["a", "(b, c:1.2)", "d\\(x\\)"]);
  assert.deepEqual(splitTop("a\nb,,c"), ["a", "b", "c"]);
});

test("가중치 읽기 · 쓰기", () => {
  assert.deepEqual(parseToken("(smile:1.2)"), { tag: "smile", weight: 1.2 });
  assert.deepEqual(parseToken("smile"), { tag: "smile", weight: 1 });
  assert.deepEqual(parseToken("fate \\(series\\)"), { tag: "fate \\(series\\)", weight: 1 });
  const toks = parsePrompt("1girl, (smile:1.25), blue sky");
  toks[0].weight = 0.8;
  assert.equal(formatPrompt(toks), "(1girl:0.8), (smile:1.25), blue sky");
  toks[1].weight = 1;
  assert.equal(formatPrompt(toks), "(1girl:0.8), smile, blue sky");
});

test("같은 태그 판정과 프롬프트 모양", () => {
  assert.equal(tagKey("Long Hair"), "long_hair");
  assert.equal(tagKey("(long_hair:1.3)"), "long_hair");
  assert.equal(tagKey("fate \\(series\\)"), "fate_(series)");
  assert.equal(tagToPrompt("fate_(series)"), "fate \\(series\\)");
});

test("입력 중인 조각 찾기", () => {
  const text = "1girl, long ha";
  assert.deepEqual(currentSegment(text, text.length), { start: 7, end: 14, query: "long ha" });
  assert.deepEqual(currentSegment("긴 머", 4), { start: 0, end: 4, query: "긴 머" });
});
