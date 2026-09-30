/** 여러 모듈이 같이 쓰는 작은 DOM 도우미. */
import { t } from "./i18n.js";

export const $ = (id) => document.getElementById(id);

/** 요소 만들기: el("button", { class: "chip", onclick }, "글자", 자식요소…) */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c != null) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

/** 화면 아래에 잠깐 뜨는 알림. 오류는 조금 더 오래 보여 준다. */
export function toast(message, { error = false, ms = 3200 } = {}) {
  const box = $("toasts");
  const node = el("div", { class: `toast${error ? " error" : ""}`, role: error ? "alert" : "status" }, message);
  box.append(node);
  setTimeout(() => node.remove(), error ? ms + 2000 : ms);
  while (box.children.length > 3) box.firstChild.remove();
}

/** 절대 예외를 던지지 않는 localStorage (사생활 보호 모드·용량 초과·저장소 차단 대비). */
export const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 무시 */ }
  },
};

/** 밀리초 → "12초" / "1분 05초" */
export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? t("time.sec", { s }) : t("time.min", { m: Math.floor(s / 60), s: String(s % 60).padStart(2, "0") });
}

/** 슬라이더 값을 옆의 <output> 에 표시한다. */
export function bindRange(input, output, fmt = (v) => v) {
  const paint = () => { output.textContent = fmt(input.value); };
  input.addEventListener("input", paint);
  paint();
  return paint;
}
