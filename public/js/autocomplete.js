/**
 * 프롬프트 입력칸의 태그 자동완성 (원본 앱 39-autocomplete 를 옮김).
 *
 * - 쉼표 뒤에서 입력 중인 조각으로 사전을 찾는다: 영어 태그, 한국어 별칭("긴 머리"), 초성("ㄱㅁㄹ").
 * - 고르면 그 조각을 영어 태그로 바꾸고 ", " 를 붙인다. 이미 있는 태그면 넣지 않고 알려 준다.
 * - 키보드: ↑↓ 이동, Enter/Tab 선택, Esc 닫기. 한글 조합 중(IME)에는 키를 가로채지 않는다.
 * - 사전은 칸을 처음 누를 때 받는다(첫 화면을 느리게 만들지 않도록).
 */
import { el, toast } from "./ui.js";
import { t, getLang } from "./i18n.js";
import { loadTagDict, search, nodePath, formatCount } from "./tag-dict.js";
import { currentSegment, tagKey, tagToPrompt, parsePrompt } from "./prompt-tokens.js";

const MAX_ITEMS = 10;

export function attachAutocomplete(textarea) {
  const wrap = el("div", { class: "ac-wrap" });
  textarea.replaceWith(wrap);
  wrap.append(textarea);
  const listId = `${textarea.id}-ac`;
  const list = el("ul", { class: "ac-list", id: listId, role: "listbox", hidden: true });
  wrap.append(list);
  textarea.setAttribute("role", "combobox");
  textarea.setAttribute("aria-autocomplete", "list");
  textarea.setAttribute("aria-controls", listId);
  textarea.setAttribute("aria-expanded", "false");

  let index = null, items = [], active = -1, timer = null;

  function ensureDict() {
    if (index) return Promise.resolve(index);
    return loadTagDict().then((ix) => (index = ix)).catch(() => null);
  }

  function hide() {
    list.hidden = true;
    list.replaceChildren();
    items = []; active = -1;
    textarea.setAttribute("aria-expanded", "false");
    textarea.removeAttribute("aria-activedescendant");
  }

  function paintActive() {
    [...list.children].forEach((li, i) => li.setAttribute("aria-selected", String(i === active)));
    const li = list.children[active];
    if (li) { li.scrollIntoView({ block: "nearest" }); textarea.setAttribute("aria-activedescendant", li.id); }
  }

  function render(query) {
    const seg = currentSegment(textarea.value, textarea.selectionStart);
    if (!index || seg.query.length < 1 || seg.query !== query) return hide();
    items = search(index, seg.query, MAX_ITEMS);
    if (!items.length) return hide();
    const en = getLang() === "en";
    list.replaceChildren(...items.map((tag, i) => {
      const path = nodePath(index, tag.node);
      const where = path.slice(-2).map((n) => (en ? n.en : n.ko)).join(" › ");
      return el("li", {
        id: `${listId}-${i}`, role: "option", "aria-selected": "false",
        onmousedown: (e) => e.preventDefault(),   // 입력칸 포커스를 잃지 않도록
        onclick: () => pick(i),
      },
      el("span", { class: "ac-tag" }, tag.tag.replace(/_/g, " ")),
      el("span", { class: "ac-ko" }, tag.aliases.slice(0, 2).join(" · ")),
      el("small", { class: "ac-meta" }, `${where}${tag.count ? ` · ${formatCount(tag.count)}` : ""}`));
    }));
    active = 0;
    list.hidden = false;
    textarea.setAttribute("aria-expanded", "true");
    paintActive();
  }

  function pick(i) {
    const tag = items[i];
    if (!tag) return;
    const v = textarea.value;
    const seg = currentSegment(v, textarea.selectionStart);
    const before = v.slice(0, seg.start);
    const after = v.slice(seg.end).replace(/^\s*,?\s*/, "");
    const exists = parsePrompt(before + after).some((tok) => tagKey(tok.tag) === tag.key);
    if (exists) {
      textarea.value = before + after;
      textarea.setSelectionRange(before.length, before.length);
      toast(t("ac.duplicate", { tag: tag.tag.replace(/_/g, " ") }));
    } else {
      const insert = `${tagToPrompt(tag.tag)}, `;
      textarea.value = before + insert + after;
      const caret = before.length + insert.length;
      textarea.setSelectionRange(caret, caret);
    }
    textarea.focus();
    hide();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function schedule() {
    clearTimeout(timer);
    const query = currentSegment(textarea.value, textarea.selectionStart).query;
    if (!query) return hide();
    timer = setTimeout(() => ensureDict().then(() => render(query)), 70);
  }

  textarea.addEventListener("focus", () => { ensureDict(); });
  textarea.addEventListener("input", (e) => { if (e.isTrusted !== false) schedule(); });
  textarea.addEventListener("compositionend", schedule);   // 한글 조합이 끝났을 때도 다시 찾는다
  textarea.addEventListener("blur", () => setTimeout(hide, 120));
  textarea.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229 || list.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      paintActive();
    } else if ((e.key === "Enter" && !e.ctrlKey && !e.metaKey) || e.key === "Tab") {
      if (active >= 0) { e.preventDefault(); pick(active); }
    } else if (e.key === "Escape") {
      e.preventDefault(); hide();
    }
  });

  return { hide, ensureDict };
}
