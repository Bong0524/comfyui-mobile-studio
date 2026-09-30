import { test } from "node:test";
import assert from "node:assert/strict";
import { signSession, verifySession, createRateLimiter } from "../server/security.js";
import { createConfig } from "../server/config.js";

test("세션 쿠키는 서명되어 있고 만료된다", () => {
  const token = signSession("secret-a", 1000, 0);
  assert.equal(verifySession("secret-a", token, 500), true);
  assert.equal(verifySession("secret-a", token, 2000), false, "만료됨");
  assert.equal(verifySession("secret-b", token, 500), false, "다른 비밀키");
  const [payload, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ exp: 9e15 })).toString("base64url");
  assert.equal(verifySession("secret-a", `${forged}.${sig}`, 500), false, "내용 위조");
  assert.equal(verifySession("secret-a", `${payload}.`, 500), false);
});

test("횟수 제한을 넘으면 막는다", () => {
  const rl = createRateLimiter({ limit: 2, windowMs: 60000 });
  rl.take("ip"); rl.take("ip");
  assert.throws(() => rl.take("ip"), /Too many requests/);
  rl.take("other-ip");
  rl.stop();
});

test("접속 비밀번호 없이는 설정이 시작을 거부한다", () => {
  assert.throws(() => createConfig({}), /ACCESS_TOKEN\(접속 비밀번호\)이 필요합니다/);
  assert.throws(() => createConfig({ ALLOW_NO_AUTH: "true", APP_HOST: "0.0.0.0" }), /ACCESS_TOKEN\(접속 비밀번호\)이 필요합니다/);
  assert.doesNotThrow(() => createConfig({ ALLOW_NO_AUTH: "true", APP_HOST: "127.0.0.1" }));
  assert.throws(() => createConfig({ ACCESS_TOKEN: "short" }), /8자 이상/);
  const cfg = createConfig({ ACCESS_TOKEN: "long-enough-token", DOMAIN: "demo.example.com" });
  assert.equal(cfg.publicOrigin, "https://demo.example.com");
  assert.equal(cfg.comfyWsUrl, "ws://127.0.0.1:8188/ws");
});
