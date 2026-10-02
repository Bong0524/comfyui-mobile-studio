#!/usr/bin/env node
/**
 * 처음 실행할 때 설정:  node scripts/init-env.mjs  (또는 npm run setup)
 *
 *  - .env.example 로 .env 를 만들고 ACCESS_TOKEN · SESSION_SECRET 을 랜덤 값으로 채운다
 *  - config/models.json 을 예시 파일로 만든다 (데모에 보여 줄 모델을 적는 곳)
 *
 * 이미 있는 파일은 절대 덮어쓰지 않는다.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ROOT_DIR } from "../server/config.js";

const envFile = path.join(ROOT_DIR, ".env");
const modelsFile = path.join(ROOT_DIR, "config", "models.json");

if (!fs.existsSync(envFile)) {
  const token = randomBytes(12).toString("base64url");
  const text = fs.readFileSync(path.join(ROOT_DIR, ".env.example"), "utf8")
    .replace(/^ACCESS_TOKEN=.*$/m, `ACCESS_TOKEN=${token}`)
    .replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${randomBytes(32).toString("hex")}`);
  fs.writeFileSync(envFile, text, { flag: "wx" });
  console.log(".env 를 만들었습니다 (ACCESS_TOKEN · SESSION_SECRET 은 랜덤 값으로 채움).");
  console.log(`  접속 비밀번호(ACCESS_TOKEN): ${token}`);
  console.log("  .env 에서 언제든 바꿀 수 있습니다.");
} else {
  console.log(".env 가 이미 있어 그대로 두었습니다.");
}

if (!fs.existsSync(modelsFile)) {
  fs.copyFileSync(path.join(ROOT_DIR, "config", "models.example.json"), modelsFile, fs.constants.COPYFILE_EXCL);
  console.log("config/models.json 을 만들었습니다 (선택: 표시 이름·기본 모델).");
  console.log("데모용 모델은 ComfyUI 모델 폴더의 checkpoints/portfolio/, loras/portfolio/ 에 넣으세요.");
}
