import { test } from "node:test";
import assert from "node:assert/strict";
import { validateGenerateRequest, findBlockedTerm } from "../server/workflow/validate.js";

/** 고정된 목록을 돌려주는 간단한 가짜 Catalog. */
function fakeCatalog(overrides = {}) {
  const view = {
    checkpoints: [{ name: "sdxl.safetensors", label: "SDXL" }],
    loras: [{ name: "style.safetensors", label: "Style", strength: 0.8, triggerWords: "styletrigger" }],
    samplers: ["euler", "dpmpp_2m"],
    schedulers: ["normal", "karras"],
    features: { hires: true, controlnet: false, preprocessor: false },
    ...overrides,
  };
  return {
    config: { limits: { maxPromptLength: 200, maxSteps: 40, maxBatchSize: 2, maxPixels: 1536 * 1536, maxLoras: 2 } },
    stylePresets: [{ id: "cine", positive: "cinematic", negative: "flat" }],
    blockedTerms: ["forbiddenword"],
    publicView: () => view,
  };
}

const valid = {
  prompt: "a red fox in the snow", negativePrompt: "blurry", stylePreset: "cine", checkpoint: "sdxl.safetensors",
  loras: [{ name: "style.safetensors", strength: 0.75 }], width: 1024, height: 1024, batchSize: 1, seed: 42,
  steps: 25, cfg: 6, sampler: "euler", scheduler: "karras", hires: { enabled: false },
};

test("올바른 요청을 받아 서버에서 프롬프트를 조합한다", () => {
  const { params, request } = validateGenerateRequest(valid, fakeCatalog(), { safetyNegative: "lowres" });
  assert.equal(params.prompt, "a red fox in the snow, styletrigger, cinematic");
  assert.equal(params.negative, "blurry, flat, lowres");
  assert.equal(params.seed, 42);
  assert.equal(request.prompt, "a red fox in the snow", "갤러리에는 사용자가 쓴 프롬프트 그대로 남는다");
});

test("워크플로우 끼워 넣기와 모르는 항목을 거절한다", () => {
  assert.throws(() => validateGenerateRequest({ ...valid, workflow: {} }, fakeCatalog()), /Custom workflows are not accepted/);
  assert.throws(() => validateGenerateRequest({ ...valid, filename_prefix: "../x" }, fakeCatalog()), /Unknown field/);
});

test("카탈로그에 있는 모델만 허용한다", () => {
  assert.throws(() => validateGenerateRequest({ ...valid, checkpoint: "other.safetensors" }, fakeCatalog()), /Checkpoint is not available/);
  assert.throws(() => validateGenerateRequest({ ...valid, loras: [{ name: "../../x", strength: 1 }] }, fakeCatalog()), /LoRA is not available/);
  assert.throws(() => validateGenerateRequest({ ...valid, sampler: "evil" }, fakeCatalog()), /Unknown sampler/);
});

test("숫자 범위 제한을 지킨다", () => {
  assert.throws(() => validateGenerateRequest({ ...valid, steps: 500 }, fakeCatalog()), /Steps must be between/);
  assert.throws(() => validateGenerateRequest({ ...valid, width: 1000 }, fakeCatalog()), /multiples of 64/);
  assert.throws(() => validateGenerateRequest({ ...valid, width: 2048, height: 2048 }, fakeCatalog()), /size exceeds/);
  assert.throws(() => validateGenerateRequest({ ...valid, batchSize: 8 }, fakeCatalog()), /Image count/);
  assert.throws(() => validateGenerateRequest({ ...valid, cfg: "abc" }, fakeCatalog()), /CFG must be a number/);
});

test("시드를 안 주면 랜덤 시드를 쓴다", () => {
  const { params } = validateGenerateRequest({ ...valid, seed: null }, fakeCatalog());
  assert.ok(Number.isInteger(params.seed) && params.seed >= 0);
});

test("금지어가 든 프롬프트를 막는다 (단어 단위)", () => {
  assert.throws(() => validateGenerateRequest({ ...valid, prompt: "a ForbiddenWord scene" }, fakeCatalog()), /not allowed/);
  assert.equal(findBlockedTerm("unforbiddenwordly", ["forbiddenword"]), null);
});

test("참조 이미지는 기능이 켜져 있고 올린 ID 가 있어야 한다", () => {
  const control = { imageId: "a".repeat(32), strength: 0.8, endPercent: 0.6 };
  assert.throws(() => validateGenerateRequest({ ...valid, control }, fakeCatalog()), /not enabled/);
  const cat = fakeCatalog({ features: { hires: true, controlnet: true, preprocessor: false } });
  assert.throws(() => validateGenerateRequest({ ...valid, control }, cat, { uploads: new Map() }), /expired/);
  const uploads = new Map([["a".repeat(32), { filename: "demo-input/a.png" }]]);
  const { params } = validateGenerateRequest({ ...valid, control }, cat, { uploads });
  assert.equal(params.control.image, "demo-input/a.png");
  assert.throws(() => validateGenerateRequest({ ...valid, control: { ...control, preprocess: true } }, cat, { uploads }), /Pose extraction/);
});

test("검사 오류는 한국어·영어 문구를 함께 가진다", () => {
  try { validateGenerateRequest({ ...valid, steps: 500 }, fakeCatalog()); assert.fail("예외가 나야 한다"); }
  catch (err) {
    assert.match(err.i18n.ko, /스텝: 1~40 사이/);
    assert.match(err.i18n.en, /Steps must be between 1 and 40/);
  }
});
