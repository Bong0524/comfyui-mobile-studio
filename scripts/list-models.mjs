#!/usr/bin/env node
/**
 * ComfyUI 가 알고 있는 체크포인트 / LoRA 와, 그중 config/models.json 에 등록된 것을 보여 준다.
 *   npm run models   (또는 models.bat)
 *
 * ComfyUI 가 켜져 있어야 한다. 보여 줄 모델 이름을 그대로 복사해 config/models.json 에 적는다.
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR, loadEnvFile } from "../server/config.js";
import { ComfyClient } from "../server/comfy/client.js";

loadEnvFile();
const comfy = new ComfyClient({ baseUrl: process.env.COMFYUI_URL || "http://127.0.0.1:8188", timeoutMs: 8000 });
const modelsFile = path.resolve(ROOT_DIR, process.env.MODELS_CONFIG || "config/models.json");

if (!(await comfy.isOnline())) {
  console.error(`ComfyUI(${comfy.baseUrl}) 에 연결할 수 없습니다. ComfyUI 를 먼저 켜 주세요.`);
  process.exit(1);
}

const [checkpoints, loras] = await Promise.all([
  comfy.listInputOptions("CheckpointLoaderSimple", "ckpt_name"),
  comfy.listInputOptions("LoraLoader", "lora_name"),
]);
let allowed = { checkpoints: [], loras: [] };
try { allowed = JSON.parse(fs.readFileSync(modelsFile, "utf8")); } catch { /* 아직 파일이 없음 */ }
const allowedNames = new Set([...(allowed.checkpoints || []), ...(allowed.loras || [])].map((m) => m.name));

function show(title, names) {
  console.log(`\n${title} (${names.length}개)  — ✓ = config/models.json 에 등록됨`);
  if (!names.length) console.log("  (없음)");
  names.forEach((n) => console.log(`  ${allowedNames.has(n) ? "✓" : " "} ${n}`));
}
show("ComfyUI 체크포인트", checkpoints);
show("ComfyUI LoRA", loras);

const missing = [...allowedNames].filter((n) => !checkpoints.includes(n) && !loras.includes(n));
if (missing.length) {
  console.log("\n[!] config/models.json 에 있지만 ComfyUI 에서 찾을 수 없는 이름 (화면에 나오지 않습니다):");
  missing.forEach((n) => console.log(`    ${n}`));
}
console.log(`\n데모에 보여 줄 모델의 이름을 위 목록 그대로 복사해 ${path.relative(ROOT_DIR, modelsFile)} 에 적으세요.`);
console.log("Windows 경로의 \\ 는 JSON 에서 \\\\ 로 두 번 적어야 합니다. 예: \"SDXL\\\\model.safetensors\"");
