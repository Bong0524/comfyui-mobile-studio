#!/usr/bin/env node
/**
 * Windows 실행 파일(.bat)용 작은 도우미 — bat 으로는 .env 를 안정적으로 읽기 어렵다.
 *
 *   node scripts/env-get.mjs KEY [기본값]    → 값 출력 (없으면 기본값)
 *   node scripts/env-get.mjs --has KEY       → 값이 있으면 종료 코드 0, 비어 있으면 1
 *   node scripts/env-get.mjs --comfy-port    → COMFYUI_URL 의 포트
 *   node scripts/env-get.mjs --find-comfy    → 찾은 ComfyUI 포터블 폴더 출력 (못 찾으면 1)
 *   node scripts/env-get.mjs --set KEY VALUE → .env 에 KEY=VALUE 저장
 *
 * 비밀값은 절대 출력하지 않는다: 토큰은 --has 로만 확인한다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT_DIR, loadEnvFile } from "../server/config.js";

const ENV_FILE = path.join(ROOT_DIR, ".env");
loadEnvFile(ENV_FILE);
const [a, b, c] = process.argv.slice(2);
const val = (k) => (process.env[k] || "").trim();

/** ComfyUI Windows 포터블 폴더에는 python_embeded\python.exe 와 ComfyUI\main.py 가 있다. */
const isPortable = (dir) =>
  fs.existsSync(path.join(dir, "python_embeded", "python.exe")) && fs.existsSync(path.join(dir, "ComfyUI", "main.py"));

function subdirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name)); }
  catch { return []; }
}

/** 드라이브 최상위와 자주 쓰는 사용자 폴더에서, 두 단계 깊이까지 이름에 comfy 가 들어간 폴더를 찾는다. */
function findComfy() {
  const roots = [];
  if (process.platform === "win32") {
    for (let code = 67; code <= 90; code++) { const d = `${String.fromCharCode(code)}:\\`; if (fs.existsSync(d)) roots.push(d); }
  }
  const home = os.homedir();
  roots.push(home, path.join(home, "Desktop"), path.join(home, "Downloads"), path.join(home, "Documents"));
  const looksLike = (p) => /comfy/i.test(path.basename(p));
  for (const root of roots) {
    for (const d1 of subdirs(root)) {
      if (looksLike(d1) && isPortable(d1)) return d1;
      if (/^(windows|program files|programdata|\$recycle\.bin|system volume information|appdata)/i.test(path.basename(d1))) continue;
      for (const d2 of subdirs(d1)) if (looksLike(d2) && isPortable(d2)) return d2;
    }
  }
  return null;
}

function setEnv(key, value) {
  let text = "";
  try { text = fs.readFileSync(ENV_FILE, "utf8"); } catch { /* 새 파일 */ }
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  text = re.test(text) ? text.replace(re, line) : `${text.replace(/\s*$/, "")}\n${line}\n`;
  fs.writeFileSync(ENV_FILE, text);
}

if (a === "--has") process.exit(val(b) ? 0 : 1);
if (a === "--comfy-port") {
  try { const u = new URL(val("COMFYUI_URL") || "http://127.0.0.1:8188"); console.log(u.port || (u.protocol === "https:" ? "443" : "80")); }
  catch { console.log("8188"); }
  process.exit(0);
}
if (a === "--find-comfy") {
  const dir = findComfy();
  if (!dir) process.exit(1);
  console.log(dir);
  process.exit(0);
}
if (a === "--set") {
  if (!/^[A-Z0-9_]+$/.test(b || "") || /TOKEN|SECRET|KEY$/.test(b)) { console.error("쓸 수 없는 항목 이름입니다"); process.exit(2); }
  setEnv(b, c || "");
  process.exit(0);
}
if (/TOKEN|SECRET|KEY$/i.test(a || "")) { console.error("비밀 값은 출력하지 않습니다 — --has 를 쓰세요"); process.exit(2); }
console.log(val(a) || b || "");
