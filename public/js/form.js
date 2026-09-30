/**
 * "만들기" 입력 폼.
 * 서버가 준 카탈로그(모델·LoRA·샘플러·크기·프리셋)로 입력 칸을 채우고, 사용자가 고른 값을
 * 이 브라우저에 기억해 두었다가, /api/generate 로 보낼 요청 본문을 만든다.
 * 서버가 모든 값을 다시 검사하므로 여기서의 검사는 빠른 안내용일 뿐이다.
 */
import { $, el, store, bindRange, toast } from "./ui.js";
import { t, pick } from "./i18n.js";

const SETTINGS_KEY = "cms.settings.v1";

export function createForm(catalog, { getControl }) {
  const d = catalog.defaults;
  const limits = catalog.limits;
  const saved = store.get(SETTINGS_KEY, {}) || {};

  const prompt = $("promptInput"), negative = $("negativeInput"), promptCount = $("promptCount");
  const ckpt = $("checkpointSelect"), loraRows = $("loraRows"), addLora = $("addLoraBtn"), loraHint = $("loraHint");
  const sizeBox = $("sizeButtons"), batch = $("batchSelect");
  const seed = $("seedInput"), seedRandom = $("seedRandom"), seedLast = $("seedLastBtn");
  const steps = $("stepsRange"), cfg = $("cfgRange");
  const sampler = $("samplerSelect"), scheduler = $("schedulerSelect");
  const hiresToggle = $("hiresToggle"), hiresScale = $("hiresScale"), hiresSteps = $("hiresSteps"), hiresDenoise = $("hiresDenoise");

  let presetId = "";
  let size = { width: d.width, height: d.height };
  let lastSeed = null;

  /* ── 프롬프트 ── */
  prompt.maxLength = limits.maxPromptLength;
  negative.maxLength = limits.maxPromptLength;
  const paintCount = () => { promptCount.textContent = `${prompt.value.length} / ${limits.maxPromptLength}`; };
  prompt.addEventListener("input", paintCount);

  // 프롬프트 도우미: 표시는 현재 언어, 누르면 영어 프롬프트 문구가 들어간다.
  const tagGroups = $("tagGroups");
  tagGroups.replaceChildren(...(catalog.promptTags || []).map((g) => el("div", { class: "tag-group" },
    el("b", {}, pick(g.group)),
    el("div", { class: "chip-wrap" }, (g.tags || []).map((tag) => {
      // 태그는 "영어 문구" 또는 { label: 표시 문구(문자열이나 {ko, en}), value: "영어 문구" }
      const value = typeof tag === "string" ? tag : tag.value;
      const shown = typeof tag === "string" ? tag : pick(tag.label) || tag.value;
      return el("button", {
        type: "button", class: "chip", title: value,
        onclick: () => {
          const cur = prompt.value.trim().replace(/,\s*$/, "");
          if (cur.toLowerCase().split(/\s*,\s*/).includes(value.toLowerCase())) return;   // 이미 있으면 넣지 않는다
          prompt.value = cur ? `${cur}, ${value}` : value;
          prompt.dispatchEvent(new Event("input"));
        },
      }, shown);
    })),
  )));

  /* ── 스타일 프리셋 ── */
  const presetChips = $("presetChips"), presetDesc = $("presetDesc"), presetRec = $("presetApplyRec");
  function paintPresets() {
    for (const c of presetChips.children) c.setAttribute("aria-checked", String(c.dataset.id === presetId));
    const p = catalog.stylePresets.find((x) => x.id === presetId);
    presetDesc.textContent = p ? pick(p.description) : "";
  }
  function selectPreset(id, { applyRecommended = false } = {}) {
    presetId = id;
    paintPresets();
    const p = catalog.stylePresets.find((x) => x.id === id);
    if (p && applyRecommended && presetRec.checked) {
      // 프리셋에 적힌 추천 스텝·CFG·크기를 함께 적용한다 (크기는 목록에 있는 값일 때만)
      const r = p.recommended || {};
      if (r.steps) steps.value = Math.min(r.steps, limits.maxSteps);
      if (r.cfg) cfg.value = r.cfg;
      if (r.width && r.height && catalog.sizes.some((s) => s.width === r.width && s.height === r.height)) setSize(r.width, r.height);
      paintRanges();
    }
    save();
  }
  presetChips.replaceChildren(
    el("button", { type: "button", class: "chip", role: "radio", dataset: { id: "" }, onclick: () => selectPreset("") }, t("preset.none")),
    ...catalog.stylePresets.map((p) => el("button", {
      type: "button", class: "chip", role: "radio", title: pick(p.description), dataset: { id: p.id },
      onclick: () => selectPreset(p.id, { applyRecommended: true }),
    }, pick(p.label), el("small", {}, pick(p.category)))),
  );

  /* ── 체크포인트 ── */
  ckpt.replaceChildren(...catalog.checkpoints.map((c) => el("option", { value: c.name }, c.label)));
  if (!catalog.checkpoints.length) {
    ckpt.replaceChildren(el("option", { value: "" }, catalog.online ? t("model.none") : t("model.offline")));
    ckpt.disabled = true;
  }

  /* ── LoRA 행 ── */
  function loraRow(name, strength) {
    const select = el("select", { "aria-label": "LoRA" }, catalog.loras.map((l) => el("option", { value: l.name }, l.label)));
    select.value = name;
    const num = el("input", { type: "number", min: "-2", max: "2", step: "0.05", value: String(strength), "aria-label": t("lora.strength") });
    const row = el("div", { class: "lora-row" }, select, num,
      el("button", { type: "button", class: "icon-btn", "aria-label": t("lora.remove"), title: t("lora.remove"), onclick: () => { row.remove(); paintLora(); save(); } }, "×"));
    select.addEventListener("change", () => {
      const l = catalog.loras.find((x) => x.name === select.value);
      if (l) num.value = l.strength;   // LoRA 를 바꾸면 그 LoRA 의 권장 강도로
      save();
    });
    num.addEventListener("change", save);
    loraRows.append(row);
  }
  function paintLora() {
    const n = loraRows.children.length;
    const max = Math.min(limits.maxLoras, catalog.loras.length);
    addLora.disabled = !catalog.loras.length || n >= max;
    loraHint.textContent = !catalog.loras.length ? t("lora.none") : `${n} / ${max}`;
  }
  addLora.addEventListener("click", () => {
    const used = new Set([...loraRows.querySelectorAll("select")].map((s) => s.value));
    const next = catalog.loras.find((l) => !used.has(l.name));   // 아직 안 고른 LoRA 부터
    if (next) { loraRow(next.name, next.strength); paintLora(); save(); }
  });

  /* ── 크기 · 생성 개수 ── */
  function setSize(w, h) {
    size = { width: w, height: h };
    for (const b of sizeBox.children) b.setAttribute("aria-checked", String(+b.dataset.w === w && +b.dataset.h === h));
  }
  sizeBox.replaceChildren(...catalog.sizes.map((s) => el("button", {
    type: "button", role: "radio", dataset: { w: s.width, h: s.height },
    onclick: () => { setSize(s.width, s.height); save(); },
  }, pick(s.label), el("small", {}, `${s.width}×${s.height}`))));
  batch.replaceChildren(...Array.from({ length: limits.maxBatchSize }, (_, i) => el("option", { value: i + 1 }, String(i + 1))));

  /* ── 샘플링 설정 ── */
  steps.max = limits.maxSteps;
  hiresSteps.max = Math.min(30, limits.maxSteps);
  const paints = [
    bindRange(steps, $("stepsOut")),
    bindRange(cfg, $("cfgOut"), (v) => (+v).toFixed(1)),
    bindRange(hiresScale, $("hiresScaleOut"), (v) => `×${(+v).toFixed(2)}`),
    bindRange(hiresSteps, $("hiresStepsOut")),
    bindRange(hiresDenoise, $("hiresDenoiseOut"), (v) => (+v).toFixed(2)),
  ];
  const paintRanges = () => paints.forEach((p) => p());
  const fillSelect = (sel, list) => sel.replaceChildren(...list.map((v) => el("option", { value: v }, v)));
  fillSelect(sampler, catalog.samplers);
  fillSelect(scheduler, catalog.schedulers);

  function paintSeed() {
    seed.disabled = seedRandom.checked;
    if (seedRandom.checked) seed.value = "";
    seedLast.disabled = lastSeed == null;
  }
  seedRandom.addEventListener("change", () => { paintSeed(); save(); });
  seedLast.addEventListener("click", () => {
    if (lastSeed == null) return;
    seedRandom.checked = false; paintSeed(); seed.value = lastSeed; save();
    toast(t("seed.reused", { seed: lastSeed }));
  });

  const hiresBlock = $("hiresBlock");
  hiresBlock.hidden = !catalog.features.hires;   // 워크플로우에 Hires 단계가 없으면 숨긴다
  const paintHires = () => hiresBlock.classList.toggle("disabled", !hiresToggle.checked);
  hiresToggle.addEventListener("change", () => { paintHires(); save(); });

  /* ── 저장해 둔 설정 되살리기 (지금 서버에서도 유효한 값만) ── */
  const has = (list, v) => list.some((x) => (x.name ?? x) === v);
  function apply(s) {
    prompt.value = typeof s.prompt === "string" ? s.prompt : "";
    negative.value = typeof s.negativePrompt === "string" ? s.negativePrompt : d.negativePrompt;
    presetId = catalog.stylePresets.some((p) => p.id === s.stylePreset) ? s.stylePreset : "";
    ckpt.value = has(catalog.checkpoints, s.checkpoint) ? s.checkpoint : d.checkpoint;
    loraRows.replaceChildren();
    (Array.isArray(s.loras) ? s.loras : []).filter((l) => has(catalog.loras, l.name)).slice(0, limits.maxLoras)
      .forEach((l) => loraRow(l.name, Number.isFinite(+l.strength) ? +l.strength : 0.8));
    const sz = catalog.sizes.find((x) => x.width === s.width && x.height === s.height)
      || catalog.sizes.find((x) => x.width === d.width && x.height === d.height) || catalog.sizes[0];
    if (sz) setSize(sz.width, sz.height);
    batch.value = String(Math.min(Math.max(1, +s.batchSize || 1), limits.maxBatchSize));
    const fixedSeed = Number.isInteger(s.seed) && s.seedRandom === false;
    seedRandom.checked = !fixedSeed;
    seed.value = fixedSeed ? s.seed : "";
    steps.value = Math.min(+s.steps || d.steps, limits.maxSteps);
    cfg.value = +s.cfg || d.cfg;
    sampler.value = catalog.samplers.includes(s.sampler) ? s.sampler : d.sampler;
    scheduler.value = catalog.schedulers.includes(s.scheduler) ? s.scheduler : d.scheduler;
    const h = { ...d.hires, ...(s.hires || {}) };
    hiresToggle.checked = !!(s.hires && s.hires.enabled);
    hiresScale.value = h.scale; hiresSteps.value = h.steps; hiresDenoise.value = h.denoise;
    paintCount(); paintPresets(); paintLora(); paintSeed(); paintRanges(); paintHires();
  }
  apply(saved);

  /* ── 요청 본문 만들기 ── */
  function collect() {
    const p = prompt.value.trim();
    if (!p) throw new Error(t("prompt.required"));
    if (!ckpt.value) throw new Error(t("model.required"));
    const seedValue = seedRandom.checked || seed.value === "" ? null : Number(seed.value);   // null = 서버가 랜덤 시드
    if (seedValue != null && (!Number.isInteger(seedValue) || seedValue < 0)) throw new Error(t("seed.invalid"));
    return {
      prompt: p,
      negativePrompt: negative.value.trim(),
      stylePreset: presetId,
      checkpoint: ckpt.value,
      loras: [...loraRows.children].map((row) => ({ name: row.querySelector("select").value, strength: Number(row.querySelector("input").value) || 0 })),
      width: size.width,
      height: size.height,
      batchSize: Number(batch.value) || 1,
      seed: seedValue,
      steps: Number(steps.value),
      cfg: Number(cfg.value),
      sampler: sampler.value,
      scheduler: scheduler.value,
      hires: hiresToggle.checked && catalog.features.hires
        ? { enabled: true, scale: Number(hiresScale.value), steps: Number(hiresSteps.value), denoise: Number(hiresDenoise.value) }
        : { enabled: false },
      control: getControl(),
    };
  }

  /* ── 설정 기억 (입력이 멈추고 0.3초 뒤에 저장) ── */
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { store.set(SETTINGS_KEY, collectLoose()); } catch { /* 무시 */ }
    }, 300);
  }
  /** collect() 와 같지만 검사 없이 — 브라우저에 저장하는 용도. */
  function collectLoose() {
    return {
      prompt: prompt.value, negativePrompt: negative.value, stylePreset: presetId, checkpoint: ckpt.value,
      loras: [...loraRows.children].map((row) => ({ name: row.querySelector("select").value, strength: Number(row.querySelector("input").value) })),
      width: size.width, height: size.height, batchSize: Number(batch.value),
      seed: seed.value === "" ? null : Number(seed.value), seedRandom: seedRandom.checked,
      steps: Number(steps.value), cfg: Number(cfg.value), sampler: sampler.value, scheduler: scheduler.value,
      hires: { enabled: hiresToggle.checked, scale: Number(hiresScale.value), steps: Number(hiresSteps.value), denoise: Number(hiresDenoise.value) },
    };
  }
  for (const node of [prompt, negative, ckpt, batch, seed, steps, cfg, sampler, scheduler, hiresScale, hiresSteps, hiresDenoise]) {
    node.addEventListener("change", save);
  }
  prompt.addEventListener("input", save);

  return {
    collect,
    /** 갤러리 항목의 설정을 불러온다 ("이 설정으로 다시 만들기"). 같은 그림이 나오도록 시드는 고정한다. */
    applyRequest(req) {
      apply({ ...req, seedRandom: false });
      save();
    },
    setLastSeed(v) { lastSeed = Number.isInteger(v) ? v : null; paintSeed(); },
  };
}
