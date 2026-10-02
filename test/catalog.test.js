import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Catalog } from "../server/catalog.js";
import { createConfig } from "../server/config.js";
import { resolveWorkflowRoles } from "../server/workflow/resolve-nodes.js";

const template = JSON.parse(fs.readFileSync(new URL("../workflows/txt2img.api.json", import.meta.url), "utf8"));
const { roles } = resolveWorkflowRoles(template);
const silent = { warn() {}, info() {}, debug() {}, error() {} };

/** ComfyUI 에 설치된 모델 (Windows 형식 이름 섞음) */
const INSTALLED = {
  checkpoints: ["waiIllustriousSDXL_v170.safetensors", "portfolio\\juggernautXL.safetensors", "portfolio/realvisXL.safetensors", "other\\model.safetensors"],
  loras: ["Style\\private_lora.safetensors", "portfolio\\watercolor.safetensors"],
};

function makeCatalog(env, models) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cms-cat-"));
  const modelsFile = path.join(dir, "models.json");
  if (models) fs.writeFileSync(modelsFile, JSON.stringify(models));
  const config = createConfig({ ACCESS_TOKEN: "test-token-123", MODELS_CONFIG: modelsFile, ...env });
  const cat = new Catalog({ config, comfy: null, logger: silent, template, roles });
  cat.installed = { ...cat.installed, ...INSTALLED };
  return cat;
}

test("folder 모드: 전용 폴더(portfolio) 안의 모델만 공개한다", () => {
  const cat = makeCatalog({}, null);
  assert.deepEqual(cat.checkpoints.map((c) => c.name), ["portfolio\\juggernautXL.safetensors", "portfolio/realvisXL.safetensors"]);
  assert.deepEqual(cat.loras.map((l) => l.name), ["portfolio\\watercolor.safetensors"]);
  assert.equal(cat.checkpoints[0].label, "juggernautXL");
});

test("folder 모드: models.json 은 표시 이름·기본값을 덧붙이고, 적힌 모델도 함께 공개한다", () => {
  const cat = makeCatalog({}, {
    checkpoints: [{ name: "portfolio/realvisXL.safetensors", label: "RealVis XL", default: true }, { name: "not-installed.safetensors" }],
    loras: [{ name: "portfolio\\watercolor.safetensors", label: "수채화", strength: 0.6, triggerWords: "wtrcolor" }],
  });
  const real = cat.checkpoints.find((c) => c.name === "portfolio/realvisXL.safetensors");
  assert.equal(real.label, "RealVis XL");
  assert.equal(real.default, true);
  assert.ok(!cat.checkpoints.some((c) => c.name === "not-installed.safetensors"), "설치 안 된 모델은 빠진다");
  assert.deepEqual(cat.loras[0], { name: "portfolio\\watercolor.safetensors", label: "수채화", strength: 0.6, triggerWords: "wtrcolor" });
  assert.ok(!cat.checkpoints.some((c) => /waiIllustrious|other/.test(c.name)), "폴더 밖 모델은 공개되지 않는다");
});

test("MODEL_FOLDER 로 폴더 이름을 바꿀 수 있다", () => {
  const cat = makeCatalog({ MODEL_FOLDER: "other" }, null);
  assert.deepEqual(cat.checkpoints.map((c) => c.name), ["other\\model.safetensors"]);
  assert.deepEqual(cat.loras, []);
});

test("allowlist 모드: models.json 에 적은 모델만", () => {
  const cat = makeCatalog({ MODEL_LIST_MODE: "allowlist" }, { checkpoints: [{ name: "waiIllustriousSDXL_v170.safetensors" }], loras: [] });
  assert.deepEqual(cat.checkpoints.map((c) => c.name), ["waiIllustriousSDXL_v170.safetensors"]);
  assert.deepEqual(cat.loras, []);
});

test("all 모드: 설치된 전부", () => {
  const cat = makeCatalog({ MODEL_LIST_MODE: "all" }, null);
  assert.equal(cat.checkpoints.length, INSTALLED.checkpoints.length);
});
