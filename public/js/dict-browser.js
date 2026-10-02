/**
 * 태그 사전 탐색 창 (원본 앱 35-dict 의 분류 트리를 옮김).
 *
 * 분류(예: 외형 › 머리카락 › 머리 길이)를 따라 내려가거나 검색해서 태그를 찾고,
 * 눌러서 프롬프트 또는 네거티브 프롬프트에 넣는다. 이미 들어 있는 태그는 ✓ 로 표시하고 다시 누르면 뺀다.
 */
import { el, toast } from "./ui.js";
import { t, getLang } from "./i18n.js";
import { loadTagDict, search, nodePath, formatCount } from "./tag-dict.js";
import { parsePrompt, formatPrompt, tagKey, tagToPrompt } from "./prompt-tokens.js";

const PAGE = 60;

export function createDictBrowser({ targets }) {
  const dialog = el("dialog", { class: "modal dict-modal", "aria-label": t("dict.title") });
  document.body.append(dialog);

  let index = null;
  let node = -1;            // -1 = 맨 위(분류 목록)
  let query = "";
  let shown = PAGE;
  let target = targets[0];  // { id, label, textarea }
  let focusTag = null;

  const searchInput = el("input", { type: "search", class: "dict-search", placeholder: t("dict.search"), "aria-label": t("dict.search"), autocomplete: "off", spellcheck: "false" });
  const targetSeg = el("div", { class: "seg dict-target", role: "radiogroup", "aria-label": t("dict.target") });
  const crumbs = el("nav", { class: "dict-crumbs", "aria-label": t("dict.path") });
  const body = el("div", { class: "dict-body" });
  const countText = el("span", { class: "muted small" });

  dialog.append(el("div", { class: "modal-body column dict-inner" },
    el("div", { class: "dict-head" },
      el("strong", {}, t("dict.title")), countText,
      el("button", { type: "button", class: "icon-btn", "aria-label": t("close"), title: t("close"), onclick: () => dialog.close() }, "×")),
    searchInput, targetSeg, crumbs, body));

  let searchTimer = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query = searchInput.value.trim(); shown = PAGE; paint(); }, 120);
  });
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });

  const en = () => getLang() === "en";
  const nodeName = (n) => (en() ? n.en : n.ko);

  function present(textarea) {
    return new Set(parsePrompt(textarea.value).map((tok) => tagKey(tok.tag)));
  }

  function toggleTag(entry) {
    const ta = target.textarea;
    const list = parsePrompt(ta.value);
    const at = list.findIndex((tok) => tagKey(tok.tag) === entry.key);
    if (at >= 0) { list.splice(at, 1); toast(t("dict.removed", { tag: entry.tag.replace(/_/g, " ") })); }
    else list.push({ tag: tagToPrompt(entry.tag), weight: 1 });
    ta.value = list.length ? `${formatPrompt(list)}, ` : "";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new Event("change", { bubbles: true }));
    paint();
  }

  function tagRow(entry, have) {
    const on = have.has(entry.key);
    const path = nodePath(index, entry.node).map(nodeName).join(" › ");
    return el("li", { class: `dict-tag${on ? " on" : ""}${focusTag === entry.tag ? " focus" : ""}` },
      el("button", {
        type: "button", class: "dict-tag-btn", "aria-pressed": String(on),
        title: on ? t("dict.removeHint") : t("dict.addHint", { target: target.label }),
        onclick: () => toggleTag(entry),
      },
      el("span", { class: "dict-check", "aria-hidden": "true" }, on ? "✓" : "+"),
      el("span", { class: "dict-tag-text" },
        el("b", {}, entry.tag.replace(/_/g, " ")),
        el("span", { class: "dict-ko" }, entry.aliases.join(" · ")),
        el("span", { class: "dict-desc" }, entry.desc),
        query ? el("small", { class: "dict-where" }, path) : null),
      el("small", { class: "dict-count" }, formatCount(entry.count))));
  }

  function paintCrumbs() {
    const path = node >= 0 ? nodePath(index, node) : [];
    crumbs.replaceChildren(
      el("button", { type: "button", class: "crumb", onclick: () => go(-1) }, t("dict.all")),
      ...path.flatMap((n) => [el("span", { "aria-hidden": "true" }, "›"), el("button", { type: "button", class: "crumb", onclick: () => go(n.i) }, nodeName(n))]),
    );
    crumbs.hidden = !!query;
  }

  function paintTargets() {
    targetSeg.replaceChildren(...targets.map((tg) => el("button", {
      type: "button", role: "radio", "aria-checked": String(tg === target),
      onclick: () => { target = tg; paint(); },
    }, tg.label)));
    targetSeg.hidden = targets.length < 2;
  }

  function paint() {
    if (!index) return;
    paintTargets();
    paintCrumbs();
    countText.textContent = t("dict.count", { n: index.tags.length.toLocaleString() });
    const have = present(target.textarea);

    if (query) {
      const hits = search(index, query, 200);
      body.replaceChildren(hits.length
        ? el("ul", { class: "dict-tags" }, hits.map((e) => tagRow(e, have)))
        : el("p", { class: "muted small empty" }, t("dict.noResult")));
      return;
    }

    const children = node < 0 ? index.roots : index.nodes[node].children;
    const parts = [];
    if (children.length) {
      parts.push(el("div", { class: "dict-nodes" }, children.map((c) => el("button", { type: "button", class: "chip", onclick: () => go(c.i) },
        nodeName(c), el("small", {}, String(c.count))))));
    }
    // 하위 분류가 있는 곳(맨 위 포함)에서는 그 아래 전체에서 많이 쓰는 태그를 먼저 보여 준다.
    const tags = children.length ? subtreeTags(node) : index.nodes[node].tags;
    if (tags.length) {
      if (children.length) parts.push(el("p", { class: "dict-sub muted small" }, t("dict.popular")));
      const sorted = [...tags].sort((a, b) => b.count - a.count);
      parts.push(el("ul", { class: "dict-tags" }, sorted.slice(0, shown).map((e) => tagRow(e, have))));
      if (sorted.length > shown) {
        parts.push(el("button", { type: "button", class: "btn ghost small block", onclick: () => { shown += PAGE; paint(); } },
          t("dict.more", { n: sorted.length - shown })));
      }
    }
    if (!parts.length) parts.push(el("p", { class: "muted small empty" }, t("dict.noResult")));
    body.replaceChildren(...parts);
  }

  /** 노드 아래(자식 분류 포함)의 모든 태그. -1 이면 사전 전체. */
  const subtreeCache = new Map();
  function subtreeTags(n) {
    if (n < 0) return index.tags;
    if (!subtreeCache.has(n)) {
      const out = [];
      const walk = (x) => { out.push(...x.tags); x.children.forEach(walk); };
      walk(index.nodes[n]);
      subtreeCache.set(n, out);
    }
    return subtreeCache.get(n);
  }

  function go(n) {
    node = n; shown = PAGE; focusTag = null;
    paint();
    body.scrollTop = 0;
  }

  async function open({ node: startNode = null, tag = null, target: ta = null } = {}) {
    if (ta) target = targets.find((x) => x.textarea === ta) || target;
    if (!dialog.open) dialog.showModal();
    if (!index) {
      body.replaceChildren(el("p", { class: "muted small empty" }, t("dict.loading")));
      try { index = await loadTagDict(); }
      catch { body.replaceChildren(el("p", { class: "muted small empty" }, t("dict.loadFailed"))); return; }
    }
    if (startNode != null) {
      query = ""; searchInput.value = "";
      node = startNode; shown = Math.max(PAGE, index.nodes[startNode].tags.length);
      focusTag = tag;
    }
    paint();
    const f = body.querySelector(".dict-tag.focus");
    if (f) f.scrollIntoView({ block: "center" });
    else if (!matchMedia("(pointer: coarse)").matches) searchInput.focus();   // 휴대폰에서는 키보드가 바로 올라오지 않게
  }

  return { open };
}
