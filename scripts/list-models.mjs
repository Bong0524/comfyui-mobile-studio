#!/usr/bin/env node
/**
 * ComfyUI 가 알고 있는 체크포인트 / LoRA 를 보여 주고, 그중 이 앱이 공개하는 것을 표시한다.
 *   npm run models   (또는 models.bat)
 *
 * ComfyUI 가 켜져 있어야 한다. 공개 여부는 서버와 같은 규칙(MODEL_LIST_MODE)으로 계산한다.
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR, loadEnvFile } from "../server/config.js";
import { ComfyClient } from "../server/comfy/client.js";

loadEnvFile();
const comfy = new ComfyClient({ baseUrl: process.env.COMFYUI_URL || "http://127.0.0.1:8188", timeoutMs: 8000 });
const modelsFile = path.resolve(ROOT_DIR, process.env.MODELS_CONFIG || "config/models.json");
const mode = (process.env.MODEL_LIST_MODE || "folder").toLowerCase();
const folder = (process.env.MODEL_FOLDER || "portfolio").replace(/^[\\/]+|[\\/]+$/g, "");

if (!(await comfy.isOnline())) {
  console.error(`ComfyUI(${comfy.baseUrl}) 에 연결할 수 없습니다. ComfyUI 를 먼저 켜 주세요.`);
  process.exit(1);
}

const [checkpoints, loras] = await Promise.all([
  comfy.listInputOptions("CheckpointLoaderSimple", "ckpt_name"),
  comfy.listInputOptions("LoraLoader", "lora_name"),
]);
let listed = { checkpoints: [], loras: [] };
try { listed = JSON.parse(fs.readFileSync(modelsFile, "utf8")); } catch { /* 아직 파일이 없음 */ }
const listedNames = new Set([...(listed.checkpoints || []), ...(listed.loras || [])].map((m) => m.name));

const folderKey = folder.replace(/\\/g, "/").toLowerCase();
const inFolder = (n) => String(n).replace(/\\/g, "/").toLowerCase().startsWith(`${folderKey}/`);
const published = (n) => mode === "all" || listedNames.has(n) || (mode === "folder" && inFolder(n));

console.log(`\n공개 방식: MODEL_LIST_MODE=${mode}` + (mode === "folder" ? `  (전용 폴더: checkpoints/${folder}/ , loras/${folder}/)` : ""));

function show(title, names) {
  const shown = names.filter(published);
  console.log(`\n${title} — 전체 ${names.length}개 중 ${shown.length}개 공개 (✓ = 앱에 보임)`);
  if (!names.length) console.log("  (없음)");
  names.forEach((n) => console.log(`  ${published(n) ? "✓" : " "} ${n}`));
}
show("ComfyUI 체크포인트", checkpoints);
show("ComfyUI LoRA", loras);

const missing = [...listedNames].filter((n) => !checkpoints.includes(n) && !loras.includes(n));
if (missing.length) {
  console.log(`\n[!] ${path.relative(ROOT_DIR, modelsFile)} 에 있지만 ComfyUI 에서 찾을 수 없는 이름 (화면에 나오지 않습니다):`);
  missing.forEach((n) => console.log(`    ${n}`));
}
if (mode === "folder") {
  console.log(`\n포트폴리오에 쓸 모델은 ComfyUI 모델 폴더 안의 "${folder}" 하위 폴더에 넣으세요. 넣은 뒤 ComfyUI 를 다시 켜면 반영됩니다.`);
  console.log(`표시 이름·기본 모델·LoRA 강도를 바꾸고 싶으면 ${path.relative(ROOT_DIR, modelsFile)} 에 적습니다 (선택).`);
} else {
  console.log(`\n데모에 보여 줄 모델의 이름을 위 목록 그대로 복사해 ${path.relative(ROOT_DIR, modelsFile)} 에 적으세요.`);
}
console.log("Windows 경로의 \\ 는 JSON 에서 \\\\ 로 두 번 적어야 합니다. 예: \"portfolio\\\\model.safetensors\"");
