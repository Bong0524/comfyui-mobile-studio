/**
 * 한/영 태그 사전: 불러오기, 검색(영어 · 한국어 · 초성), 분류 트리.
 *
 * 데이터(public/data/tag-dict.json)는 원본 앱의 한/영 태그 사전에서 분류·한국어 별칭·설명이
 * 모두 갖춰진 일반 태그를 골라 담은 것이다. 처음 필요할 때 한 번만 받는다.
 * 검색 함수는 DOM 을 쓰지 않아 node 테스트에서도 그대로 쓴다.
 */
import { tagKey } from "./prompt-tokens.js";

const CHO = ["ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];

/** 한글 음절을 초성으로: "긴 머리" → "ㄱ ㅁㄹ". 한글이 아닌 글자는 그대로. */
export function choseong(text) {
  let out = "";
  for (const ch of String(text)) {
    const code = ch.charCodeAt(0) - 0xac00;
    out += code >= 0 && code < 11172 ? CHO[Math.floor(code / 588)] : ch;
  }
  return out;
}

const HANGUL = /[ㄱ-ㆎ가-힣]/;
const ONLY_CHO = /^[ㄱ-ㅎ]+$/;

/** 사전 JSON → 검색하기 쉬운 모양. */
export function buildIndex(data) {
  const nodes = data.nodes.map(([key, parent, ko, en, count], i) => ({ i, key, parent, ko, en, count, children: [], tags: [] }));
  for (const n of nodes) if (n.parent >= 0) nodes[n.parent].children.push(n);
  const tags = data.tags.map(([tag, aliases, desc, node, count], i) => {
    const t = {
      i, tag, aliases, desc, node, count,
      key: tagKey(tag),
      aliasLower: aliases.map((a) => a.toLowerCase()),
      aliasText: aliases.join("\n").toLowerCase(),
      aliasCho: aliases.map((a) => choseong(a).replace(/\s+/g, "")),
    };
    nodes[node].tags.push(t);
    return t;
  });
  const byKey = new Map(tags.map((t) => [t.key, t]));
  return { meta: { count: data.count, built: data.built }, nodes, roots: nodes.filter((n) => n.parent < 0), tags, byKey };
}

/** 노드의 경로(뿌리부터). */
export function nodePath(index, nodeIdx) {
  const out = [];
  for (let n = nodeIdx; n >= 0; n = index.nodes[n].parent) out.unshift(index.nodes[n]);
  return out;
}

/**
 * 검색. 점수가 낮을수록 앞, 같으면 많이 쓰이는 태그가 앞.
 *  - 영어: 태그 이름과 같음(0) > 그대로 시작(1) > 단어 첫머리에서 시작(2) > 중간에 포함(3)
 *  - 한국어: 대표 별칭과 같음(0) > 다른 별칭과 같음(1) > 대표 별칭이 시작(2) > 다른 별칭이 시작(3)
 *           > 별칭에 포함(4) > 설명에만 있음(5, 두 글자 이상일 때)
 *  - 초성만(예: "ㄱㅁㄹ"): 별칭의 초성에 같은 규칙
 */
function aliasScore(list, q) {
  let best = 9;
  for (let j = 0; j < list.length && best > 0; j++) {
    const a = list[j];
    if (a === q) best = Math.min(best, j === 0 ? 0 : 1);
    else if (a.startsWith(q)) best = Math.min(best, j === 0 ? 2 : 3);
    else if (a.includes(q)) best = Math.min(best, 4);
  }
  return best;
}

export function search(index, query, limit = 12) {
  const q = String(query || "").trim();
  if (!q) return [];
  const hits = [];
  if (HANGUL.test(q)) {
    const compact = q.replace(/\s+/g, "");
    const cho = ONLY_CHO.test(compact);
    const ql = q.toLowerCase();
    for (const t of index.tags) {
      let score;
      if (cho) score = aliasScore(t.aliasCho, compact);
      else if (t.aliasText.includes(ql)) score = aliasScore(t.aliasLower, ql);
      else score = compact.length >= 2 && t.desc.includes(q) ? 5 : 9;
      if (score < 9) hits.push([score, t]);
    }
  } else {
    const qk = tagKey(q);
    if (!qk) return [];
    for (const t of index.tags) {
      const p = t.key.indexOf(qk);
      if (p < 0) continue;
      hits.push([t.key === qk ? 0 : p === 0 ? 1 : t.key[p - 1] === "_" ? 2 : 3, t]);
    }
  }
  hits.sort((a, b) => a[0] - b[0] || b[1].count - a[1].count);
  return hits.slice(0, limit).map((h) => h[1]);
}

/** 사용 횟수를 짧게: 1234567 → "1.2M" */
export function formatCount(n) {
  if (!n || n < 0) return "";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

let loading = null;
/** 사전을 한 번만 받아 색인을 만든다. 실패하면 다음 호출 때 다시 시도한다. */
export function loadTagDict(url = "data/tag-dict.json") {
  if (!loading) {
    loading = fetch(url, { credentials: "same-origin" })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(buildIndex)
      .catch((err) => { loading = null; throw err; });
  }
  return loading;
}
