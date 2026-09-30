/**
 * POST /api/generate 요청 검사.
 *
 * 요청은 정해진 평평한 형식이다. 모르는 항목은 거절하고(`workflow` 같은 그래프를 몰래 넣지 못하게),
 * 모든 숫자는 범위를 확인하며, 모델·샘플러 이름은 공개된 목록에 있어야 한다.
 * 결과는 build-workflow.js 에 넘길 정리된 파라미터다.
 */
import { randomInt } from "node:crypto";
import { HttpError, L } from "../http-utils.js";

const ALLOWED_KEYS = new Set([
  "prompt", "negativePrompt", "stylePreset", "checkpoint", "loras", "width", "height", "batchSize",
  "seed", "steps", "cfg", "sampler", "scheduler", "hires", "control",
]);
export const MAX_SEED = 2 ** 48 - 1;

const bad = (msg) => new HttpError(400, msg);

/** 검사 오류 메시지에 보여 줄 항목 이름. */
const LABELS = {
  prompt: L("프롬프트", "Prompt"), negativePrompt: L("네거티브 프롬프트", "Negative prompt"),
  width: L("가로 크기", "Width"), height: L("세로 크기", "Height"), batchSize: L("이미지 수", "Image count"),
  seed: L("시드", "Seed"), steps: L("스텝", "Steps"), cfg: L("CFG", "CFG"),
  "hires.scale": L("Hires 배율", "Hires scale"), "hires.steps": L("Hires 스텝", "Hires steps"),
  "hires.denoise": L("Hires 디노이즈", "Hires denoise"),
  "control.strength": L("ControlNet 강도", "ControlNet strength"), "control.endPercent": L("ControlNet 적용 구간", "ControlNet end"),
};
const label = (field) => LABELS[field] || (/^loras\[\d+\]\.strength$/.test(field) ? L("LoRA 강도", "LoRA strength") : L(field, field));

function cleanText(v, field, maxLen, required) {
  if (v == null) v = "";
  if (typeof v !== "string") { const f = label(field); throw bad(L(`${f.ko}: 글자로 입력해야 합니다`, `${f.en} must be text`)); }
  // 제어 문자를 지우고(줄바꿈·탭은 유지) 지나치게 긴 공백을 줄인다.
  const s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/[ \t]{3,}/g, "  ").trim();
  if (required && !s) { const f = label(field); throw bad(L(`${f.ko}을(를) 입력해 주세요`, `${f.en} is required`)); }
  if (s.length > maxLen) { const f = label(field); throw bad(L(`${f.ko}이(가) 너무 깁니다 (최대 ${maxLen}자)`, `${f.en} is too long (max ${maxLen} characters)`)); }
  return s;
}

function num(v, field, min, max, { integer = false } = {}) {
  if (typeof v === "string" && v.trim() !== "") v = Number(v);
  const f = label(field);
  if (typeof v !== "number" || !Number.isFinite(v)) throw bad(L(`${f.ko}: 숫자여야 합니다`, `${f.en} must be a number`));
  if (integer && !Number.isInteger(v)) throw bad(L(`${f.ko}: 정수여야 합니다`, `${f.en} must be a whole number`));
  if (v < min || v > max) throw bad(L(`${f.ko}: ${min}~${max} 사이여야 합니다`, `${f.en} must be between ${min} and ${max}`));
  return v;
}

const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;

/** 단어 단위로 비교한다 — 금지어가 다른 단어의 일부일 때 잘못 걸리지 않도록. */
export function findBlockedTerm(text, terms) {
  const hay = ` ${String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  return terms.find((t) => hay.includes(` ${t.replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `)) || null;
}

function joinPrompt(...parts) {
  return parts.map((p) => (p || "").trim().replace(/^,|,$/g, "").trim()).filter(Boolean).join(", ");
}

/**
 * @param body     JSON 요청 본문
 * @param catalog  Catalog 객체 (허용 목록 + 제한값)
 * @param ctx      { uploads: Map<이미지ID, {filename}>, safetyNegative }
 */
export function validateGenerateRequest(body, catalog, ctx = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad(L("요청 형식이 올바르지 않습니다", "Invalid request"));
  for (const key of Object.keys(body)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw bad(key === "workflow" || key === "nodes" ? L("사용자 워크플로우는 받지 않습니다", "Custom workflows are not accepted") : L(`알 수 없는 항목: ${key}`, `Unknown field: ${key}`));
    }
  }
  const limits = catalog.config.limits;
  const view = catalog.publicView();

  const userPrompt = cleanText(body.prompt, "prompt", limits.maxPromptLength, true);
  const userNegative = cleanText(body.negativePrompt, "negativePrompt", limits.maxPromptLength, false);

  let preset = null;
  if (body.stylePreset != null && body.stylePreset !== "") {
    preset = catalog.stylePresets.find((p) => p.id === body.stylePreset);
    if (!preset) throw bad(L("알 수 없는 스타일 프리셋입니다", "Unknown style preset"));
  }

  const blocked = findBlockedTerm(userPrompt, catalog.blockedTerms);
  if (blocked) throw bad(L("데모에서 허용되지 않는 내용이 프롬프트에 들어 있습니다", "This prompt contains content that is not allowed in the demo"));

  const ckpt = view.checkpoints.find((c) => c.name === body.checkpoint);
  if (!ckpt) throw bad(L("사용할 수 없는 체크포인트입니다", "Checkpoint is not available"));

  if (body.loras != null && !Array.isArray(body.loras)) throw bad(L("LoRA 목록 형식이 올바르지 않습니다", "loras must be a list"));
  const loraList = body.loras || [];
  if (loraList.length > limits.maxLoras) throw bad(L(`LoRA 는 최대 ${limits.maxLoras}개까지 쓸 수 있습니다`, `At most ${limits.maxLoras} LoRAs`));
  const seenLora = new Set();
  const loras = loraList.map((l, i) => {
    if (!l || typeof l !== "object") throw bad(L(`${i + 1}번째 LoRA 설정이 올바르지 않습니다`, `LoRA #${i + 1} is invalid`));
    const entry = view.loras.find((x) => x.name === l.name);
    if (!entry) throw bad(L(`사용할 수 없는 LoRA 입니다: ${String(l.name).slice(0, 80)}`, `LoRA is not available: ${String(l.name).slice(0, 80)}`));
    if (seenLora.has(entry.name)) throw bad(L("같은 LoRA 를 두 번 선택했습니다", "The same LoRA was selected twice"));
    seenLora.add(entry.name);
    return { name: entry.name, strength: round(num(l.strength, `loras[${i}].strength`, -2, 2), 2) };
  });

  const width = num(body.width, "width", 512, 2048, { integer: true });
  const height = num(body.height, "height", 512, 2048, { integer: true });
  if (width % 64 || height % 64) throw bad(L("가로·세로 크기는 64의 배수여야 합니다", "Width and height must be multiples of 64"));
  if (width * height > limits.maxPixels) throw bad(L("데모에서 허용하는 이미지 크기를 넘었습니다", "Image size exceeds the demo limit"));
  const batchSize = num(body.batchSize ?? 1, "batchSize", 1, limits.maxBatchSize, { integer: true });

  let seed;
  if (body.seed == null || body.seed === -1 || body.seed === "") seed = randomInt(0, 2 ** 47);
  else seed = num(body.seed, "seed", 0, MAX_SEED, { integer: true });

  const steps = num(body.steps, "steps", 1, limits.maxSteps, { integer: true });
  const cfg = round(num(body.cfg, "cfg", 1, 20), 1);
  if (!view.samplers.includes(body.sampler)) throw bad(L("알 수 없는 샘플러입니다", "Unknown sampler"));
  if (!view.schedulers.includes(body.scheduler)) throw bad(L("알 수 없는 스케줄러입니다", "Unknown scheduler"));

  let hires = { enabled: false };
  if (body.hires != null) {
    if (typeof body.hires !== "object") throw bad(L("Hires 설정이 올바르지 않습니다", "hires is invalid"));
    if (body.hires.enabled === true) {
      if (!view.features.hires) throw bad(L("이 워크플로우에서는 Hires fix 를 쓸 수 없습니다", "Hires fix is not available with this workflow"));
      hires = {
        enabled: true,
        scale: round(num(body.hires.scale, "hires.scale", 1, 2), 2),
        steps: num(body.hires.steps, "hires.steps", 1, limits.maxSteps, { integer: true }),
        denoise: round(num(body.hires.denoise, "hires.denoise", 0.05, 0.9), 2),
      };
      const outPixels = Math.round(width * hires.scale) * Math.round(height * hires.scale);
      if (outPixels > limits.maxPixels * 2.25) throw bad(L("Hires 결과가 데모 크기 제한을 넘습니다", "Hires output would exceed the demo size limit"));
    }
  }

  let control = null;
  if (body.control != null) {
    if (typeof body.control !== "object") throw bad(L("참조 이미지 설정이 올바르지 않습니다", "control is invalid"));
    if (!view.features.controlnet) throw bad(L("이 서버에서는 참조 이미지 기능이 꺼져 있습니다", "Reference images are not enabled on this server"));
    const id = body.control.imageId;
    if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) throw bad(L("참조 이미지 ID가 올바르지 않습니다", "control.imageId is invalid"));
    const upload = ctx.uploads && ctx.uploads.get(id);
    if (!upload) throw bad(L("참조 이미지가 만료되었습니다 — 다시 올려 주세요", "Reference image expired — please upload it again"));
    const preprocess = body.control.preprocess === true;
    if (preprocess && !view.features.preprocessor) throw bad(L("이 서버에서는 사진에서 포즈 추출 기능을 쓸 수 없습니다", "Pose extraction is not available on this server"));
    control = {
      imageId: id,
      image: upload.filename,
      strength: round(num(body.control.strength, "control.strength", 0, 2), 2),
      endPercent: round(num(body.control.endPercent, "control.endPercent", 0.05, 1), 2),
      preprocess,
    };
  }

  const loraTriggers = loras.map((l) => view.loras.find((x) => x.name === l.name)?.triggerWords || "");
  return {
    // 사용자가 요청한 값 그대로 (갤러리의 "이 설정으로 다시 만들기" 용)
    request: {
      prompt: userPrompt, negativePrompt: userNegative, stylePreset: preset ? preset.id : "",
      checkpoint: ckpt.name, loras, width, height, batchSize, seed, steps, cfg,
      sampler: body.sampler, scheduler: body.scheduler, hires,
      control: control ? { strength: control.strength, endPercent: control.endPercent, preprocess: control.preprocess } : null,
    },
    // 워크플로우에 실제로 넣을 값
    params: {
      prompt: joinPrompt(userPrompt, ...loraTriggers, preset && preset.positive),
      negative: joinPrompt(userNegative, preset && preset.negative, ctx.safetyNegative),
      checkpoint: ckpt.name, loras, width, height, batchSize, seed, steps, cfg,
      sampler: body.sampler, scheduler: body.scheduler, hires, control,
    },
  };
}
