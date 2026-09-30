/**
 * ControlNet 포즈 · 참조 이미지 (선택 기능).
 * 이미지를 올리거나 포즈 에디터로 그린 뼈대를 참조로 쓴다.
 * 서버에 ControlNet 모델이 설정된 경우에만 화면에 나타난다.
 * 브라우저는 서버가 돌려준 업로드 ID 만 들고 있다 — 파일 경로는 알지 못한다.
 */
import { api } from "./api.js";
import { $, el, toast, bindRange } from "./ui.js";
import { t } from "./i18n.js";
import { createPoseEditor } from "./pose-editor.js";

const MAX_SIDE = 1536;

/** 큰 사진은 올리기 전에 줄이고(모바일 데이터 절약) PNG 로 통일한다. */
async function normalizeImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(t("ref.unreadable")))), "image/png"));
}

export function createReference(catalog) {
  const block = $("refBlock");
  if (!catalog.features.controlnet) {
    block.hidden = true;
    return { get: () => null, clear() {} };
  }
  block.hidden = false;

  const thumb = $("refThumb"), fileInput = $("refFile"), clearBtn = $("refClearBtn");
  const preprocessWrap = $("refPreprocessWrap"), preprocess = $("refPreprocess");
  const strength = $("cnStrength"), endPct = $("cnEnd");
  strength.value = catalog.defaults.control.strength;
  endPct.value = catalog.defaults.control.endPercent;
  bindRange(strength, $("cnStrengthOut"), (v) => (+v).toFixed(2));
  bindRange(endPct, $("cnEndOut"), (v) => `${Math.round(v * 100)}%`);

  let ref = null;   // { id, url, fromEditor }

  function paint() {
    thumb.replaceChildren(ref ? el("img", { src: ref.url, alt: t("ref.alt") }) : el("span", { class: "muted small" }, t("ref.none")));
    clearBtn.disabled = !ref;
    // "사진에서 포즈 추출" 은 사진을 올렸고 서버에 전처리 노드가 있을 때만 의미가 있다
    preprocessWrap.hidden = !(ref && !ref.fromEditor && catalog.features.preprocessor);
  }

  async function upload(blob, fromEditor) {
    thumb.replaceChildren(el("span", { class: "muted small" }, t("ref.uploading")));
    try {
      const r = await api.upload(blob);
      ref = { id: r.id, url: r.url, fromEditor };
      preprocess.checked = !fromEditor && catalog.features.preprocessor;
      toast(fromEditor ? t("ref.poseSet") : t("ref.uploaded"));
    } catch (err) {
      toast(err.message, { error: true });
    }
    paint();
  }

  $("refUploadBtn").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (!f) return;
    if (f.size > catalog.limits.maxUploadBytes * 4) { toast(t("ref.tooLarge"), { error: true }); return; }
    try { await upload(await normalizeImage(f), false); }
    catch (err) { toast(err.message || t("ref.unreadable"), { error: true }); paint(); }
  });
  clearBtn.addEventListener("click", () => { ref = null; paint(); });

  const editor = createPoseEditor({
    dialog: $("poseDialog"), canvas: $("poseCanvas"),
    resetBtn: $("poseReset"), flipBtn: $("poseFlip"), cancelBtn: $("poseCancel"), applyBtn: $("poseApply"),
    onApply: (blob) => upload(blob, true),
  });
  $("poseEditBtn").addEventListener("click", () => editor.open());

  paint();
  return {
    /** 생성 요청에 넣을 참조 설정 (없으면 null). */
    get: () => (ref ? {
      imageId: ref.id,
      strength: Number(strength.value),
      endPercent: Number(endPct.value),
      preprocess: !ref.fromEditor && catalog.features.preprocessor && preprocess.checked,
    } : null),
    clear() { ref = null; paint(); },
  };
}
