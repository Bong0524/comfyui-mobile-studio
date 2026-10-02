/**
 * 프롬프트 칩 (원본 앱 49-prompt-chips 를 옮김).
 *
 * 입력칸 아래에 프롬프트를 태그 단위 칩으로 보여 준다. 사전에 있는 태그는 한국어 이름이 함께 보인다.
 * 칩을 누르면 편집 창이 열려 가중치 조절 · 순서 이동 · 삭제를 할 수 있고, 바뀐 내용은 곧바로
 * 입력칸 글자에 반영된다(입력칸이 원본, 칩은 그 글자를 보여 주는 또 하나의 화면).
 */
import { el } from "./ui.js";
import { t, getLang } from "./i18n.js";
import { loadTagDict, nodePath } from "./tag-dict.js";
import { parsePrompt, formatPrompt, tagKey } from "./prompt-tokens.js";

const W_MIN = 0.1, W_MAX = 2, W_STEP = 0.05;
const clampW = (w) => Math.min(W_MAX, Math.max(W_MIN, Math.round(w / W_STEP) * W_STEP));
const fmtW = (w) => (Math.round(w * 100) / 100).toFixed(2).replace(/0$/, "");

/**
 * @param textarea  원본 입력칸
 * @param container 칩을 그릴 자리
 * @param openDict  (opts) => void — 편집 창의 "사전에서 보기"
 */
export function attachChips(textarea, container, { openDict } = {}) {
  let index = null;
  loadTagDict().then((ix) => { index = ix; render(); }).catch(() => { /* 사전 없이도 칩은 동작 */ });

  const tokens = () => parsePrompt(textarea.value);
  function write(list) {
    textarea.value = list.length ? `${formatPrompt(list)}, ` : "";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function labelOf(tok) {
    const entry = index && index.byKey.get(tagKey(tok.tag));
    const plain = tok.tag.replace(/\\([()])/g, "$1");
    if (!entry) return { main: plain, sub: "" };
    const ko = entry.aliases[0];
    return getLang() === "en" ? { main: plain, sub: ko } : { main: ko, sub: plain };
  }

  function render() {
    const list = tokens();
    container.hidden = !list.length;
    container.replaceChildren(...list.map((tok, i) => {
      const { main, sub } = labelOf(tok);
      const known = !!(index && index.byKey.get(tagKey(tok.tag)));
      return el("button", {
        type: "button",
        class: `pchip${known ? " known" : ""}${tok.weight > 1 ? " up" : tok.weight < 1 ? " down" : ""}`,
        title: tok.tag,
        "aria-label": t("chip.edit", { tag: tok.tag }),
        onclick: () => openEditor(i),
      },
      el("span", { class: "pchip-main" }, main),
      sub ? el("small", {}, sub) : null,
      tok.weight !== 1 ? el("b", { class: "pchip-w" }, `×${fmtW(tok.weight)}`) : null);
    }));
  }

  let timer = null;
  textarea.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(render, 80); });

  /* ── 편집 창 ── */
  const dialog = el("dialog", { class: "modal chip-modal", "aria-label": t("chip.title") });
  document.body.append(dialog);
  let cur = -1;

  function openEditor(i) {
    cur = i;
    paintEditor();
    if (!dialog.open) dialog.showModal();
  }

  /** 칩 목록을 고치고 입력칸에 반영한다. repaint=false 는 슬라이더를 끄는 동안(창을 다시 그리면 끌기가 끊긴다). */
  function update(fn, repaint = true) {
    const list = tokens();
    if (!list[cur]) return dialog.close();
    fn(list);
    write(list);
    render();
    if (repaint) paintEditor();
    return list;
  }

  function paintEditor() {
    const list = tokens();
    const tok = list[cur];
    if (!tok) { dialog.close(); return; }
    const entry = index && index.byKey.get(tagKey(tok.tag));
    const en = getLang() === "en";
    const weight = el("input", { type: "range", min: W_MIN, max: W_MAX, step: W_STEP, value: tok.weight, "aria-label": t("chip.weight") });
    const out = el("output", {}, `×${fmtW(tok.weight)}`);
    weight.addEventListener("input", () => {
      const l = update((x) => { x[cur].weight = clampW(Number(weight.value)); }, false);
      if (l) out.textContent = `×${fmtW(l[cur].weight)}`;
    });
    weight.addEventListener("change", () => paintEditor());
    const stepBtn = (d, label) => el("button", { type: "button", class: "btn ghost small", onclick: () => update((l) => { l[cur].weight = clampW(l[cur].weight + d); }) }, label);
    const quick = [0.8, 1, 1.2, 1.4].map((w) => el("button", {
      type: "button", class: `chip${Math.abs(tok.weight - w) < 0.001 ? " on" : ""}`,
      onclick: () => update((l) => { l[cur].weight = w; }),
    }, fmtW(w)));

    const info = entry
      ? [
        el("p", { class: "chip-ko" }, entry.aliases.join(" · ")),
        el("p", { class: "muted small chip-desc" }, entry.desc),
        el("p", { class: "chip-path small" }, nodePath(index, entry.node).map((n) => (en ? n.en : n.ko)).join(" › ")),
      ]
      : [el("p", { class: "muted small" }, t("chip.notInDict"))];

    dialog.replaceChildren(el("div", { class: "modal-body column" },
      el("div", { class: "chip-head" },
        el("strong", { class: "chip-tag" }, tok.tag.replace(/\\([()])/g, "$1")),
        el("span", { class: "muted small" }, `${cur + 1} / ${list.length}`)),
      ...info,
      el("div", { class: "chip-weight" },
        el("span", { class: "label" }, t("chip.weight")),
        stepBtn(-0.1, "−"), out, stepBtn(0.1, "+")),
      weight,
      el("div", { class: "chip-wrap" }, quick),
      el("div", { class: "viewer-actions" },
        el("button", { type: "button", class: "btn ghost small", disabled: cur === 0, onclick: () => update((l) => { [l[cur - 1], l[cur]] = [l[cur], l[cur - 1]]; cur--; }) }, t("chip.left")),
        el("button", { type: "button", class: "btn ghost small", disabled: cur === list.length - 1, onclick: () => update((l) => { [l[cur + 1], l[cur]] = [l[cur], l[cur + 1]]; cur++; }) }, t("chip.right")),
        entry && openDict ? el("button", { type: "button", class: "btn ghost small", onclick: () => { dialog.close(); openDict({ node: entry.node, tag: entry.tag, target: textarea }); } }, t("chip.inDict")) : null,
        el("button", { type: "button", class: "btn danger small", onclick: () => { const l = tokens(); l.splice(cur, 1); write(l); render(); dialog.close(); } }, t("chip.delete")),
        el("button", { type: "button", class: "btn primary small", onclick: () => dialog.close() }, t("chip.done"))),
    ));
  }

  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });   // 바깥을 누르면 닫기
  render();
  return { render };
}
