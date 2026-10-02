import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildIndex, search, choseong, nodePath } from "../public/js/tag-dict.js";

const data = JSON.parse(fs.readFileSync(new URL("../public/data/tag-dict.json", import.meta.url), "utf8"));
const index = buildIndex(data);
const HANGUL = /[가-힣]/;

test("사전: 모든 항목이 완전하다 (분류 · 한국어 별칭 · 한국어 설명)", () => {
  assert.ok(data.tags.length > 5000, `항목 수 ${data.tags.length}`);
  assert.equal(data.count, data.tags.length);
  const seen = new Set();
  for (const [tag, aliases, desc, node, count] of data.tags) {
    assert.match(tag, /^[\x21-\x7e]+$/, `태그 이름: ${tag}`);
    assert.ok(!seen.has(tag), `중복 태그: ${tag}`); seen.add(tag);
    assert.ok(aliases.length && aliases.every((a) => HANGUL.test(a)), `별칭: ${tag}`);
    assert.ok(HANGUL.test(desc), `설명: ${tag}`);
    assert.ok(Number.isInteger(node) && data.nodes[node], `분류: ${tag}`);
    assert.ok(Number.isInteger(count) && count >= 0, `사용 횟수: ${tag}`);
  }
});

test("공개 사전: 자주 쓰는 일반 태그가 들어 있다", () => {
  for (const tag of ["1girl", "smile", "long_hair", "school_uniform", "outdoors", "cherry_blossoms", "sword", "cat"]) {
    assert.ok(index.byKey.has(tag), `${tag} 가 빠짐`);
  }
});

test("검색: 영어 접두어 · 단어 첫머리 · 한국어 별칭 · 초성", () => {
  assert.equal(search(index, "long ha")[0].tag, "long_hair");
  assert.ok(search(index, "uniform", 20).some((t) => t.tag === "school_uniform"), "단어 첫머리 일치");
  assert.equal(search(index, "")[0], undefined);
  const ko = search(index, "긴 머리");
  assert.ok(ko.some((t) => t.tag === "long_hair"), ko.map((t) => t.tag).join());
  assert.equal(choseong("긴 머리"), "ㄱ ㅁㄹ");
  assert.ok(search(index, "ㄱㅁㄹ", 30).some((t) => t.tag === "long_hair"));
  assert.equal(search(index, "zzzz_no_such_tag").length, 0);
});

test("분류 트리: 뿌리부터 경로를 따라갈 수 있고 개수가 맞는다", () => {
  const total = index.roots.reduce((s, r) => s + r.count, 0);
  assert.equal(total, index.tags.length);
  const lh = index.byKey.get("long_hair");
  const path = nodePath(index, lh.node);
  assert.equal(path[0].parent, -1);
  assert.ok(path.at(-1).tags.includes(lh));
});

test("검색 순위: 별칭과 똑같으면 맨 앞", () => {
  assert.equal(search(index, "고양이")[0].tag, "cat");
  assert.ok(search(index, "벚나무", 10).some((t) => t.tag === "cherry_blossoms"), "설명으로도 찾는다");
  assert.equal(search(index, "긴 머리")[0].tag, "long_hair");
  assert.equal(search(index, "smile")[0].tag, "smile");
});
