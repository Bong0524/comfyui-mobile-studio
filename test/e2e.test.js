/**
 * 통합 테스트: 실제 앱 서버 ⇄ 가짜 ComfyUI (HTTP + WebSocket).
 * 로그인, 요청 검사, SSE 진행률과 함께 생성, 이미지 중계, 갤러리, 업로드 + ControlNet,
 * 취소, 대기열 제한, 백엔드 오류, 백엔드 오프라인 처리를 확인한다.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockComfy, makePng } from "../scripts/mock-comfyui.mjs";
import { createConfig } from "../server/config.js";
import { createApp } from "../server/app.js";
import { createLogger } from "../server/http-utils.js";

let mock, app, base, cookie;
const TOKEN = "test-access-token";

before(async () => {
  mock = await startMockComfy({ port: 0, stepMs: 5, quiet: true });
  const config = createConfig({
    ACCESS_TOKEN: TOKEN,
    APP_PORT: "0",
    COMFYUI_URL: mock.url,
    MODELS_CONFIG: "config/models.example.json",
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "cms-test-")),
    CONTROLNET_MODEL: "mock_openpose.safetensors",
    CONTROLNET_PREPROCESSOR: "openpose",
    MAX_PENDING_JOBS: "1",
    GENERATE_RATE_LIMIT_PER_MIN: "100",
    SAFETY_NEGATIVE: "fixed_negative_term",
  });
  app = createApp(config, { logger: createLogger("silent") });
  const addr = await app.start();
  base = `http://127.0.0.1:${addr.port}`;
  for (let i = 0; i < 50 && !app.monitor.connected; i++) await new Promise((r) => setTimeout(r, 20));
});

after(async () => {
  await app.stop();
  await mock.close();
});

const api = (p, opts = {}) => fetch(base + p, {
  ...opts,
  headers: { ...(cookie ? { Cookie: cookie } : {}), ...(opts.method && opts.method !== "GET" ? { Origin: base } : {}), ...(opts.headers || {}) },
});
const post = (p, body) => api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function request(overrides = {}) {
  const cat = await (await api("/api/catalog")).json();
  return { prompt: "a lighthouse on a cliff", negativePrompt: "", stylePreset: "", checkpoint: cat.checkpoints[0].name, loras: [], width: 768, height: 768, batchSize: 1, seed: 7, steps: 4, cfg: 6, sampler: "euler", scheduler: "normal", hires: { enabled: false }, ...overrides };
}

/** 작업이 끝날 때까지 SSE 이벤트를 모은다. */
async function follow(jobId) {
  const res = await api(`/api/jobs/${jobId}/events`);
  assert.equal(res.headers.get("content-type").split(";")[0], "text/event-stream");
  const decoder = new TextDecoder();
  const events = [];
  let buf = "";
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (ev && data) events.push({ ev, data: JSON.parse(data) });
    }
  }
  return events;
}

test("상태 확인은 공개, 나머지는 로그인이 필요하다", async () => {
  const h = await (await api("/api/health")).json();
  assert.equal(h.comfyui, "online");
  assert.equal(h.busy, undefined, "로그인 안 한 사람에게는 대기열 정보를 안 준다");
  assert.equal((await api("/api/catalog")).status, 401);
  assert.equal((await api("/api/gallery")).status, 401);
});

test("로그인: 틀린 비밀번호와 다른 사이트의 요청을 거절한다", async () => {
  const wrong = await post("/api/login", { token: "nope-nope" });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error, "접속 비밀번호가 틀렸습니다", "기본은 한국어");
  const wrongEn = await api("/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-Lang": "en" }, body: JSON.stringify({ token: "nope-nope" }) });
  assert.equal((await wrongEn.json()).error, "Wrong access token", "X-Lang: en 이면 영어");
  const cross = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify({ token: TOKEN }) });
  assert.equal(cross.status, 403);
  const ok = await post("/api/login", { token: TOKEN });
  assert.equal(ok.status, 200);
  const set = ok.headers.get("set-cookie");
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  cookie = set.split(";")[0];
});

test("카탈로그는 전용 폴더와 허용 목록에 있는, 설치된 모델만 공개한다", async () => {
  const cat = await (await api("/api/catalog")).json();
  assert.deepEqual(cat.checkpoints.map((c) => c.name), ["portfolio\\demo_sdxl.safetensors", "sd_xl_base_1.0.safetensors"]);
  assert.deepEqual(cat.loras.map((l) => l.name), ["portfolio\\demo_style.safetensors", "example_style_lora.safetensors"]);
  assert.equal(cat.checkpoints[0].label, "demo_sdxl", "표시 이름은 파일 이름에서");
  assert.equal(cat.features.controlnet, true);
  assert.equal(cat.features.preprocessor, true);
  assert.ok(cat.stylePresets.length >= 7);
});

test("생성 요청: 워크플로우를 직접 보내거나 Origin 이 없으면 거절한다", async () => {
  assert.equal((await post("/api/generate", { ...(await request()), workflow: { 1: {} } })).status, 400);
  const noOrigin = await fetch(base + "/api/generate", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(await request()) });
  assert.equal(noOrigin.status, 403);
});

test("진행률을 스트리밍하며 이미지를 만들고, 그 이미지를 내보낸다", async () => {
  const res = await post("/api/generate", await request({ loras: [{ name: "example_style_lora.safetensors", strength: 0.6 }], stylePreset: "cinematic-film-still" }));
  assert.equal(res.status, 202);
  const job = await res.json();
  const events = await follow(job.id);
  const final = events.filter((e) => e.ev === "job").pop().data;
  assert.equal(final.status, "completed", final.error);
  assert.ok(events.some((e) => e.ev === "job" && e.data.progress.max === 4), "스텝 진행률이 온다");
  assert.ok(events.some((e) => e.ev === "preview" && e.data.image.startsWith("data:image/")), "실시간 미리보기가 전달된다");
  assert.equal(final.images.length, 1);

  const sent = mock.state.prompts.at(-1).prompt;
  const lora = Object.values(sent).find((n) => n.class_type === "LoraLoader");
  assert.equal(lora.inputs.strength_model, 0.6);
  const pos = Object.values(sent).find((n) => n._meta?.title === "Positive Prompt");
  assert.match(pos.inputs.text, /^a lighthouse on a cliff, cinematic film still/);
  const neg = Object.values(sent).find((n) => n._meta?.title === "Negative Prompt");
  assert.match(neg.inputs.text, /fixed_negative_term/, "고정 네거티브 문구가 항상 붙는다");

  const img = await api(final.images[0].url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  const dl = await api(final.images[0].downloadUrl);
  assert.match(dl.headers.get("content-disposition"), /attachment; filename="comfyui-/);
  await dl.arrayBuffer();
  assert.equal((await api(`/api/images/${job.id}/5`)).status, 404);

  const gallery = await (await api("/api/gallery")).json();
  assert.equal(gallery.items[0].id, job.id);
  assert.equal(gallery.items[0].request.prompt, "a lighthouse on a cliff");
});

test("참조 이미지를 올리고 ControlNet 을 연결한다", async () => {
  const bad = await api("/api/uploads", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.from("not an image") });
  assert.equal(bad.status, 415);
  const up = await api("/api/uploads", { method: "POST", headers: { "Content-Type": "image/png" }, body: makePng(32, 48, 3) });
  assert.equal(up.status, 201);
  const { id, url } = await up.json();
  assert.equal((await api(url)).status, 200);
  const res = await post("/api/generate", await request({ control: { imageId: id, strength: 0.9, endPercent: 0.5, preprocess: true } }));
  const job = await res.json();
  const final = (await follow(job.id)).filter((e) => e.ev === "job").pop().data;
  assert.equal(final.status, "completed");
  const sent = mock.state.prompts.at(-1).prompt;
  assert.equal(Object.values(sent).find((n) => n.class_type === "ControlNetApplyAdvanced").inputs.strength, 0.9);
  assert.match(Object.values(sent).find((n) => n.class_type === "LoadImage").inputs.image, new RegExp(`${id}\\.png$`));
});

test("취소하면 실행 중인 작업이 멈추고, 대기열이 차면 429 를 돌려준다", async () => {
  mock.state.stepMs = 40;
  const a = await (await post("/api/generate", await request({ steps: 30 }))).json();
  const b = await post("/api/generate", await request());
  assert.equal(b.status, 202, "한 건은 기다릴 수 있다");
  const c = await post("/api/generate", await request());
  assert.equal(c.status, 429, "MAX_PENDING_JOBS 를 넘으면 바쁨 응답");
  await new Promise((r) => setTimeout(r, 150));
  await post(`/api/jobs/${a.id}/cancel`, {});
  const finalA = (await follow(a.id)).filter((e) => e.ev === "job").pop().data;
  assert.equal(finalA.status, "cancelled");
  const finalB = (await follow((await b.json()).id)).filter((e) => e.ev === "job").pop().data;
  assert.equal(finalB.status, "completed", "취소 뒤에는 다음 작업이 실행된다");
  mock.state.stepMs = 5;
});

test("ComfyUI 실행 오류를 사용자에게 알린다", async () => {
  mock.state.failNext = true;
  const job = await (await post("/api/generate", await request())).json();
  const final = (await follow(job.id)).filter((e) => e.ev === "job").pop().data;
  assert.equal(final.status, "failed");
  assert.match(final.error, /Mock failure/);
});

test("백엔드가 꺼지면 상태가 오프라인이 되고 생성이 거절된다", async () => {
  mock.state.offline = true;
  mock.dropSockets();
  await new Promise((r) => setTimeout(r, 3100));   // 상태 확인 캐시(3초)가 지나기를 기다림
  const h = await (await api("/api/health")).json();
  assert.equal(h.comfyui, "offline");
  const res = await post("/api/generate", await request().catch(() => ({})));
  assert.equal(res.status, 503);
  mock.state.offline = false;
});
