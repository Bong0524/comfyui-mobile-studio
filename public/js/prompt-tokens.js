/**
 * 프롬프트 글자 ↔ 태그 목록 변환 (DOM 을 쓰지 않아 테스트에서도 그대로 불러 쓴다).
 *
 * 원본 앱(49-prompt-chips)의 규칙을 옮겼다.
 *  - 쉼표로 나누되, 괄호 안의 쉼표와 \( \) 처럼 이스케이프된 괄호는 건드리지 않는다.
 *  - "(태그:1.2)" 는 가중치가 있는 태그로 읽는다.
 *  - 같은 태그인지는 tagKey() 로 비교한다 — "long hair", "long_hair", "Long Hair" 는 모두 같다.
 */

/** 맨 바깥 쉼표로 나눈다. 괄호 안 쉼표는 그대로 둔다. */
export function splitTop(text) {
  const out = [];
  let depth = 0, cur = "";
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const escaped = i > 0 && s[i - 1] === "\\";
    if (c === "(" && !escaped) depth++;
    else if (c === ")" && !escaped) depth = Math.max(0, depth - 1);
    if ((c === "," || c === "\n") && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((t) => t.trim()).filter(Boolean);
}

/** "(태그:1.2)" → { tag: "태그", weight: 1.2 }, 그 밖은 가중치 1. */
export function parseToken(raw) {
  const t = String(raw).trim();
  const m = t.match(/^\((.+):\s*(-?\d+(?:\.\d+)?)\s*\)$/s);
  if (m && balanced(m[1])) return { tag: m[1].trim(), weight: Number(m[2]) };
  return { tag: t, weight: 1 };
}

function balanced(s) {
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    const esc = i > 0 && s[i - 1] === "\\";
    if (s[i] === "(" && !esc) d++;
    else if (s[i] === ")" && !esc && --d < 0) return false;
  }
  return d === 0;
}

const round2 = (w) => Math.round(w * 100) / 100;

/** { tag, weight } → 프롬프트 글자. 가중치 1 은 괄호 없이. */
export function formatToken({ tag, weight = 1 }) {
  const w = round2(weight);
  return w === 1 ? tag : `(${tag}:${w})`;
}

export function parsePrompt(text) {
  return splitTop(text).map(parseToken);
}

export function formatPrompt(tokens) {
  return tokens.map(formatToken).join(", ");
}

/** 같은 태그인지 비교할 때 쓰는 키: 가중치·이스케이프를 벗기고 소문자 + 공백→밑줄. */
export function tagKey(raw) {
  const { tag } = parseToken(raw);
  return tag.replace(/\\([()])/g, "$1").trim().toLowerCase().replace(/[\s_]+/g, "_").replace(/^_+|_+$/g, "");
}

/** 사전의 태그 이름을 프롬프트에 넣을 모양으로: 밑줄 → 공백, 괄호는 이스케이프(가중치 문법과 헷갈리지 않게). */
export function tagToPrompt(tag) {
  return String(tag).replace(/_/g, " ").replace(/([()])/g, "\\$1");
}

/** 커서 위치에서 지금 입력 중인 조각(마지막 쉼표·줄바꿈 뒤)의 범위. */
export function currentSegment(text, caret) {
  const before = text.slice(0, caret);
  const start = Math.max(before.lastIndexOf(","), before.lastIndexOf("\n")) + 1;
  const raw = before.slice(start);
  const lead = raw.length - raw.trimStart().length;
  return { start: start + lead, end: caret, query: raw.trim() };
}
