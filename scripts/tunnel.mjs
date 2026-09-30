#!/usr/bin/env node
/**
 * 이 앱용 Cloudflare Tunnel 실행:  npm run tunnel
 *
 * .env 의 CLOUDFLARE_TUNNEL_TOKEN 을 읽어 TUNNEL_TOKEN 환경변수로 cloudflared 에 넘긴다
 * (cloudflared 가 공식 지원하는 방법). 그래서 비밀값이 명령줄·프로세스 목록에 드러나지 않는다.
 *
 * 외부 주소 → http://127.0.0.1:APP_PORT 연결은 Cloudflare 대시보드에서 설정한다
 * (README 의 "Remote Demo" 참고). ComfyUI 는 연결하지 않는다.
 */
import { spawn } from "node:child_process";
import { loadEnvFile } from "../server/config.js";

loadEnvFile();
const token = (process.env.CLOUDFLARE_TUNNEL_TOKEN || "").trim();
const bin = (process.env.CLOUDFLARED_PATH || "cloudflared").trim();

if (!token) {
  console.error(".env 에 CLOUDFLARE_TUNNEL_TOKEN 이 없습니다 — README 의 Remote Demo 항목을 참고하세요.");
  process.exit(1);
}

const child = spawn(bin, ["tunnel", "--no-autoupdate", "run"], {
  stdio: "inherit",
  env: { ...process.env, TUNNEL_TOKEN: token },
});
child.on("error", (err) => {
  console.error(`cloudflared 를 실행하지 못했습니다 (${bin}): ${err.message}\ncloudflared 를 설치하거나 .env 의 CLOUDFLARED_PATH 에 경로를 적어 주세요.`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
