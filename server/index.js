#!/usr/bin/env node
/**
 * 시작 파일:  npm start   (.env 를 읽고 웹앱을 켠다)
 */
import { createConfig, isLoopbackHost, loadEnvFile } from "./config.js";
import { createApp } from "./app.js";
import { createLogger } from "./http-utils.js";

if (typeof WebSocket === "undefined" || typeof fetch === "undefined") {
  console.error(`Node.js 22 이상이 필요합니다 (현재 ${process.version}).`);
  process.exit(1);
}

loadEnvFile();

let config;
try {
  config = createConfig();
} catch (err) {
  console.error(`설정 오류: ${err.message}\n.env.example 을 참고하세요.`);
  process.exit(1);
}

const logger = createLogger(config.logLevel);
if (config.ephemeralSecret) logger.warn("SESSION_SECRET 이 없어 임시 값을 씁니다 — 서버를 다시 켤 때마다 로그인이 풀립니다.");
if (!config.accessToken) logger.warn("로그인이 꺼져 있습니다 (ALLOW_NO_AUTH=true). 이 상태로 터널에 연결하지 마세요.");
if (!isLoopbackHost(new URL(config.comfyUrl).hostname)) logger.warn("COMFYUI_URL 이 127.0.0.1 이 아닙니다 — ComfyUI 가 인터넷에 노출되지 않았는지 확인하세요.");
if (!isLoopbackHost(config.appHost)) logger.warn(`APP_HOST=${config.appHost} — Cloudflare Tunnel 을 쓰면 127.0.0.1 로 충분하고 더 안전합니다.`);

const app = createApp(config, { logger });
const addr = await app.start();
logger.info(`ComfyUI Mobile Studio 실행 중: http://${addr.address}:${addr.port}`);
logger.info(`ComfyUI 백엔드: ${config.comfyUrl}`);
if (config.publicOrigin) logger.info(`외부 주소: ${config.publicOrigin}`);

const shutdown = async (signal) => {
  logger.info(`${signal} 신호를 받아 종료합니다`);
  await app.stop();
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
