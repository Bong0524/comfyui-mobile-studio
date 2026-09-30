import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { resolveWorkflowRoles } from "../server/workflow/resolve-nodes.js";
import { buildWorkflow, findDanglingLinks } from "../server/workflow/build-workflow.js";

const template = JSON.parse(fs.readFileSync(new URL("../workflows/txt2img.api.json", import.meta.url), "utf8"));

const baseParams = {
  prompt: "a lighthouse at dusk", negative: "blurry", checkpoint: "model.safetensors", loras: [],
  width: 896, height: 1152, batchSize: 2, seed: 1234, steps: 20, cfg: 5.5, sampler: "euler", scheduler: "karras",
  hires: { enabled: false }, control: null, filenamePrefix: "demo/test",
};

/** Renumber every node id — the resolver must not depend on ids. */
function renumber(wf) {
  const map = Object.fromEntries(Object.keys(wf).map((id, i) => [id, String(900 + i * 7)]));
  const out = {};
  for (const [id, node] of Object.entries(wf)) {
    const inputs = {};
    for (const [k, v] of Object.entries(node.inputs)) inputs[k] = Array.isArray(v) ? [map[v[0]], v[1]] : v;
    out[map[id]] = { ...node, inputs };
  }
  return out;
}

test("기본 템플릿에서 모든 역할을 찾는다", () => {
  const r = resolveWorkflowRoles(template);
  assert.equal(r.ok, true, r.problems.join("; "));
  assert.deepEqual(r.roles, { save: "9", decode: "8", baseSampler: "5", hiresSampler: "7", latentUpscale: "6", latent: "4", positive: "2", negative: "3", checkpoint: "1" });
});

test("노드 번호와 상관없이 그래프로 역할을 찾는다", () => {
  const wf = renumber(template);
  const r = resolveWorkflowRoles(wf);
  assert.equal(r.ok, true);
  assert.equal(wf[r.roles.checkpoint].class_type, "CheckpointLoaderSimple");
  assert.equal(wf[r.roles.positive]._meta.title, "Positive Prompt");
  assert.equal(wf[r.roles.hiresSampler]._meta.title, "Hires Sampler");
});

test("추측하지 않고 지원하지 않는 워크플로우라고 알린다", () => {
  const wf = structuredClone(template);
  delete wf["9"];
  const r = resolveWorkflowRoles(wf);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /SaveImage/);
});

test("파라미터를 넣고, Hires 가 꺼지면 그 가지를 잘라 낸다", () => {
  const { roles } = resolveWorkflowRoles(template);
  const wf = buildWorkflow(template, roles, baseParams);
  assert.equal(wf["2"].inputs.text, "a lighthouse at dusk");
  assert.equal(wf["3"].inputs.text, "blurry");
  assert.equal(wf["1"].inputs.ckpt_name, "model.safetensors");
  assert.deepEqual([wf["4"].inputs.width, wf["4"].inputs.height, wf["4"].inputs.batch_size], [896, 1152, 2]);
  assert.equal(wf["5"].inputs.seed, 1234);
  assert.equal(wf["5"].inputs.scheduler, "karras");
  assert.equal(wf["9"].inputs.filename_prefix, "demo/test");
  assert.ok(!wf["6"] && !wf["7"], "Hires 노드가 지워짐");
  assert.deepEqual(wf["8"].inputs.samples, ["5", 0]);
  assert.deepEqual(findDanglingLinks(wf), []);
  assert.equal(template["2"].inputs.text, "", "템플릿 원본은 바뀌지 않는다");
});

test("Hires 가 켜지면 그 단계를 남기고 설정한다", () => {
  const { roles } = resolveWorkflowRoles(template);
  const wf = buildWorkflow(template, roles, { ...baseParams, hires: { enabled: true, scale: 1.25, steps: 8, denoise: 0.4 } });
  assert.equal(wf["6"].inputs.scale_by, 1.25);
  assert.equal(wf["7"].inputs.steps, 8);
  assert.equal(wf["7"].inputs.denoise, 0.4);
  assert.equal(wf["7"].inputs.seed, 1234);
  assert.deepEqual(wf["8"].inputs.samples, ["7", 0]);
});

test("LoRA 로더를 줄줄이 잇고 모델/CLIP 을 쓰는 곳을 모두 다시 연결한다", () => {
  const { roles } = resolveWorkflowRoles(template);
  const loras = [{ name: "a.safetensors", strength: 0.7 }, { name: "b.safetensors", strength: 1 }];
  const wf = buildWorkflow(template, roles, { ...baseParams, loras, hires: { enabled: true, scale: 1.5, steps: 10, denoise: 0.5 } });
  assert.deepEqual(wf.app_lora_1.inputs.model, ["1", 0]);
  assert.deepEqual(wf.app_lora_2.inputs.clip, ["app_lora_1", 1]);
  assert.equal(wf.app_lora_2.inputs.lora_name, "b.safetensors");
  for (const sid of ["5", "7"]) assert.deepEqual(wf[sid].inputs.model, ["app_lora_2", 0]);
  for (const tid of ["2", "3"]) assert.deepEqual(wf[tid].inputs.clip, ["app_lora_2", 1]);
  assert.deepEqual(wf["8"].inputs.vae, ["1", 2], "VAE 는 여전히 체크포인트에서 온다");
  assert.deepEqual(findDanglingLinks(wf), []);
});

test("프롬프트와 샘플러 사이에 ControlNet 을 넣는다", () => {
  const { roles } = resolveWorkflowRoles(template);
  const control = { image: "portfolio-demo-input/abc.png", strength: 0.8, endPercent: 0.6, preprocess: true };
  const wf = buildWorkflow(template, roles, { ...baseParams, control }, { controlnetModel: "openpose.safetensors" });
  assert.equal(wf.app_cn_loader.inputs.control_net_name, "openpose.safetensors");
  assert.deepEqual(wf.app_cn_apply.inputs.image, ["app_cn_pre", 0]);
  assert.deepEqual(wf["5"].inputs.positive, ["app_cn_apply", 0]);
  assert.deepEqual(wf["5"].inputs.negative, ["app_cn_apply", 1]);
  assert.deepEqual(findDanglingLinks(wf), []);

  const noCn = buildWorkflow(template, roles, { ...baseParams, control }, {});
  assert.ok(!noCn.app_cn_apply, "모델이 설정되지 않으면 ControlNet 도 없다");
});
