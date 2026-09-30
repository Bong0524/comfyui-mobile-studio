#!/usr/bin/env node
/**
 * 서비스가 응답할 때까지 기다린다 (start-demo.bat 에서 사용).
 *
 *   node scripts/wait-for.mjs comfyui [초]   → COMFYUI_URL/system_stats 확인
 *   node scripts/wait-for.mjs app [초]       → http://127.0.0.1:APP_PORT/api/health 확인
 *
 * 응답하면 종료 코드 0, 시간 안에 응답이 없으면 1.
 */
import { loadEnvFile } from "../server/config.js";

loadEnvFile();
const target = process.argv[2] || "comfyui";
const seconds = Number(process.argv[3] || 120);
const url = target === "app"
  ? `http://127.0.0.1:${process.env.APP_PORT || 8080}/api/health`
  : `${(process.env.COMFYUI_URL || "http://127.0.0.1:8188").replace(/\/+$/, "")}/system_stats`;

const deadline = Date.now() + seconds * 1000;
let dots = 0;
while (Date.now() < deadline) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (res.ok) { if (dots) process.stdout.write("\n"); process.exit(0); }
  } catch { /* 아직 안 켜짐 */ }
  if (seconds > 3) { process.stdout.write("."); dots++; }
  await new Promise((r) => setTimeout(r, 1000));
}
if (dots) process.stdout.write("\n");
process.exit(1);
