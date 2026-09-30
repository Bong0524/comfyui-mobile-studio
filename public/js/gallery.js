/**
 * 최근 생성 결과 갤러리와 이미지 상세 창.
 * 썸네일은 ComfyUI 의 preview 옵션으로 WebP 로 다시 인코딩해 받는다(모바일 전송량 절약).
 * 이미지 주소는 앱 서버의 /api/images/작업ID/번호 뿐이라, 파일 경로는 브라우저에 드러나지 않는다.
 */
import { api } from "./api.js";
import { $, el, toast, formatDuration } from "./ui.js";
import { t } from "./i18n.js";

export function createGallery({ onReuse, presetLabel = (id) => id }) {
  const grid = $("gallery"), empty = $("galleryEmpty");
  const dialog = $("viewerDialog"), img = $("viewerImg"), promptEl = $("viewerPrompt"), metaEl = $("viewerMeta");
  const download = $("viewerDownload"), reuse = $("viewerReuse"), hide = $("viewerDelete");
  let current = null;
  let loading = false;

  function render(items) {
    empty.hidden = items.length > 0;
    grid.replaceChildren(...items.flatMap((entry) => entry.images.map((image, i) => el("button", {
      type: "button", title: entry.request.prompt, "aria-label": t("gallery.open", { prompt: entry.request.prompt.slice(0, 60) }),
      onclick: () => open(entry, i),
    }, el("img", {
      src: image.thumbUrl, alt: "", loading: "lazy", decoding: "async",
      onerror: (e) => e.target.classList.add("broken"),   // ComfyUI 가 꺼져 있으면 빈 칸으로
    })))));
  }

  async function refresh() {
    if (loading) return;
    loading = true;
    try { render(await api.gallery()); }
    catch (err) { if (err.status !== 401) toast(t("gallery.error", { msg: err.message }), { error: true }); }
    finally { loading = false; }
  }

  /** 상세 창 열기. entry 는 갤러리 항목 또는 방금 끝난 작업(같은 모양). */
  function open(entry, index = 0) {
    current = entry;
    const image = entry.images[index];
    const r = entry.request;
    img.src = image.url;
    img.alt = r.prompt;
    download.href = image.downloadUrl;
    promptEl.textContent = r.prompt;
    const rows = [
      [t("meta.negative"), r.negativePrompt || "—"],
      [t("meta.style"), r.stylePreset ? presetLabel(r.stylePreset) : "—"],
      [t("meta.model"), r.checkpoint],
      ["LoRA", r.loras && r.loras.length ? r.loras.map((l) => `${l.name} (${l.strength})`).join(", ") : "—"],
      [t("meta.size"), `${r.width}×${r.height}${r.hires && r.hires.enabled ? ` → ×${r.hires.scale}` : ""}`],
      [t("meta.seed"), String(r.seed)],
      [t("meta.stepsCfg"), `${r.steps} / ${r.cfg}`],
      [t("meta.sampler"), `${r.sampler} · ${r.scheduler}`],
      [t("meta.reference"), r.control ? t("meta.referenceValue", { s: r.control.strength }) : "—"],
      [t("meta.time"), entry.durationMs ? formatDuration(entry.durationMs) : "—"],
    ];
    metaEl.replaceChildren(...rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));
    hide.hidden = !entry.createdAt;
    dialog.showModal();
  }

  reuse.addEventListener("click", () => { if (current) { onReuse(current.request); dialog.close(); } });
  hide.addEventListener("click", async () => {
    if (!current) return;
    try { await api.hide(current.id); dialog.close(); toast(t("gallery.hidden")); refresh(); }
    catch (err) { toast(err.message, { error: true }); }
  });
  $("viewerClose").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });   // 바깥(배경)을 누르면 닫기
  $("galleryRefresh").addEventListener("click", refresh);

  return { refresh, open };
}
