#!/usr/bin/env node
/**
 * 가짜 ComfyUI 서버 — 자동 테스트와, GPU 없이 화면을 개발할 때 쓴다.
 *
 * 이 앱에 필요한 만큼만 ComfyUI API(HTTP + WebSocket)를 흉내 낸다:
 * /system_stats, /object_info, /prompt, /queue, /interrupt, /history, /view,
 * /upload/image, /ws (진행률, executed, 바이너리 미리보기 프레임).
 * "생성된" 이미지는 단순한 그라데이션 그림이다 — AI 결과물이 아님이 한눈에 보인다.
 *
 *   npm run mock   → http://127.0.0.1:8199  (COMFYUI_URL 을 이 주소로)
 */
import http from "node:http";
import zlib from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

/* ── 아주 작은 PNG 인코더 (RGB) ─────────────────────────────────────────── */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function makePng(width, height, seed = 1) {
  const hue = (seed % 360) / 360;
  const hsl = (h, s, l) => {
    const f = (n) => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
  };
  const top = hsl(hue, 0.55, 0.62), bottom = hsl((hue + 0.12) % 1, 0.6, 0.28), sun = hsl((hue + 0.5) % 1, 0.8, 0.75);
  const cx = width * 0.68, cy = height * 0.38, r = Math.min(width, height) * 0.14;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    const t = y / (height - 1 || 1);
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const glow = Math.max(0, 1 - d / (r * 2.2));
      const inSun = d < r;
      for (let ch = 0; ch < 3; ch++) {
        let v = top[ch] * (1 - t) + bottom[ch] * t;
        v = inSun ? sun[ch] : v + (sun[ch] - v) * glow * 0.5;
        if (y > height * 0.72) v *= 0.55 + 0.1 * Math.sin(x / 9 + seed);   // 아래쪽 "땅"
        raw[row + 1 + x * 3 + ch] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ── 최소한의 WebSocket 서버 프레임 처리 ─────────────────────────────────── */
function wsFrame(payload, opcode) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}

/* ── multipart 해석 (/upload/image 에 필요한 만큼만) ──────────────────── */
function parseMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!m) return {};
  const boundary = Buffer.from(`--${m[1] || m[2]}`);
  const out = {};
  let start = body.indexOf(boundary);
  while (start >= 0) {
    const next = body.indexOf(boundary, start + boundary.length);
    if (next < 0) break;
    const part = body.subarray(start + boundary.length + 2, next - 2);
    const sep = part.indexOf("\r\n\r\n");
    if (sep > 0) {
      const head = part.subarray(0, sep).toString("utf8");
      const name = /name="([^"]+)"/.exec(head)?.[1];
      const filename = /filename="([^"]*)"/.exec(head)?.[1];
      const data = part.subarray(sep + 4);
      if (name) out[name] = filename != null ? { filename, data } : data.toString("utf8");
    }
    start = next;
  }
  return out;
}

export function startMockComfy({ port = 8199, host = "127.0.0.1", stepMs = 60, quiet = false } = {}) {
  const sockets = new Map();          // clientId → 소켓
  const files = new Map();            // "종류/하위폴더/파일명" → 이미지 데이터
  const history = {};
  const queue = [];                   // 대기 중인 작업 id
  let running = null;
  const state = { prompts: [], offline: false, failNext: false, stepMs };

  const send = (clientId, msg) => {
    const s = sockets.get(clientId);
    if (s && !s.destroyed) s.write(wsFrame(Buffer.from(JSON.stringify(msg)), 0x1));
  };
  const sendPreview = (clientId, png) => {
    const s = sockets.get(clientId);
    if (!s || s.destroyed) return;
    const head = Buffer.alloc(8); head.writeUInt32BE(1, 0); head.writeUInt32BE(2, 4);
    s.write(wsFrame(Buffer.concat([head, png]), 0x2));
  };

  function runNext() {
    if (running || !queue.length) return;
    const job = queue.shift();
    running = job;
    const { id, clientId, prompt } = job;
    const saveId = Object.keys(prompt).find((k) => prompt[k].class_type === "SaveImage");
    const samplers = Object.keys(prompt).filter((k) => prompt[k].class_type === "KSampler");
    const latent = Object.values(prompt).find((n) => n.class_type === "EmptyLatentImage")?.inputs || { width: 512, height: 512, batch_size: 1 };
    const seed = Number(prompt[samplers[0]]?.inputs?.seed) || 1;
    const steps = samplers.map((k) => Number(prompt[k].inputs.steps) || 1);
    const events = [];
    events.push(() => send(clientId, { type: "execution_start", data: { prompt_id: id } }));
    samplers.forEach((sid, si) => {
      events.push(() => send(clientId, { type: "executing", data: { node: sid, prompt_id: id } }));
      for (let v = 1; v <= steps[si]; v++) {
        events.push(() => {
          send(clientId, { type: "progress", data: { value: v, max: steps[si], prompt_id: id, node: sid } });
          if (v % 3 === 0) sendPreview(clientId, makePng(64, 64, seed + v));
        });
      }
    });
    events.push(() => {
      if (state.failNext) {
        state.failNext = false;
        send(clientId, { type: "execution_error", data: { prompt_id: id, node_id: saveId, exception_message: "Mock failure" } });
        history[id] = { outputs: {}, status: { status_str: "error", messages: [] } };
        running = null; runNext(); return true;
      }
      const images = [];
      const prefix = String(prompt[saveId].inputs.filename_prefix || "ComfyUI");
      const slash = prefix.lastIndexOf("/");
      const subfolder = slash >= 0 ? prefix.slice(0, slash) : "";
      for (let b = 0; b < (latent.batch_size || 1); b++) {
        const filename = `${prefix.slice(slash + 1)}_${String(b + 1).padStart(5, "0")}_.png`;
        files.set(`output/${subfolder}/${filename}`, makePng(Math.max(64, latent.width >> 2), Math.max(64, latent.height >> 2), seed + b * 37));
        images.push({ filename, subfolder, type: "output" });
      }
      send(clientId, { type: "executing", data: { node: saveId, prompt_id: id } });
      send(clientId, { type: "executed", data: { node: saveId, output: { images }, prompt_id: id } });
      history[id] = { outputs: { [saveId]: { images } }, status: { status_str: "success", completed: true } };
      send(clientId, { type: "execution_success", data: { prompt_id: id } });
      send(clientId, { type: "executing", data: { node: null, prompt_id: id } });
      running = null;
      runNext();
      return true;
    });
    let i = 0;
    const tick = () => {
      if (running !== job) return;               // 중단됨
      const stop = events[i++]();
      if (!stop && i < events.length) job.timer = setTimeout(tick, state.stepMs);
    };
    job.timer = setTimeout(tick, state.stepMs);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const json = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (state.offline) { res.destroy(); return; }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const p = url.pathname;
      if (p === "/system_stats") return json(200, { system: { comfyui_version: "mock" }, devices: [{ name: "mock-gpu" }] });
      if (p.startsWith("/object_info/")) {
        const cls = decodeURIComponent(p.slice("/object_info/".length));
        const req2 = {
          CheckpointLoaderSimple: { ckpt_name: [["sd_xl_base_1.0.safetensors", "another_model.safetensors"]] },
          LoraLoader: { lora_name: [["example_style_lora.safetensors", "unlisted_lora.safetensors"]] },
          KSampler: { sampler_name: [["euler", "euler_ancestral", "dpmpp_2m"]], scheduler: [["normal", "karras", "simple"]] },
          ControlNetLoader: { control_net_name: [["mock_openpose.safetensors"]] },
          OpenposePreprocessor: { image: ["IMAGE"] },
        }[cls];
        return json(200, req2 ? { [cls]: { input: { required: req2 } } } : {});
      }
      if (p === "/prompt" && req.method === "POST") {
        let payload;
        try { payload = JSON.parse(body.toString("utf8")); } catch { return json(400, { error: { type: "invalid_json", message: "bad json" } }); }
        const prompt = payload.prompt || {};
        const bad = Object.entries(prompt).find(([, n]) => !n || typeof n.class_type !== "string");
        if (bad || !Object.values(prompt).some((n) => n.class_type === "SaveImage")) {
          return json(400, { error: { type: "prompt_outputs_failed_validation", message: "Prompt outputs failed validation" }, node_errors: {} });
        }
        const id = randomUUID();
        state.prompts.push({ id, prompt, clientId: payload.client_id });
        queue.push({ id, clientId: payload.client_id, prompt });
        setImmediate(runNext);
        return json(200, { prompt_id: id, number: state.prompts.length, node_errors: {} });
      }
      if (p === "/queue" && req.method === "GET") {
        return json(200, { queue_running: running ? [[0, running.id]] : [], queue_pending: queue.map((q, i) => [i + 1, q.id]) });
      }
      if (p === "/queue" && req.method === "POST") {
        const ids = JSON.parse(body.toString("utf8") || "{}").delete || [];
        for (const id of ids) { const i = queue.findIndex((q) => q.id === id); if (i >= 0) queue.splice(i, 1); }
        return json(200, {});
      }
      if (p === "/interrupt") {
        if (running) {
          clearTimeout(running.timer);
          send(running.clientId, { type: "execution_interrupted", data: { prompt_id: running.id } });
          history[running.id] = { outputs: {}, status: { status_str: "error", messages: [] } };
          running = null;
          setImmediate(runNext);
        }
        return json(200, {});
      }
      if (p.startsWith("/history/")) {
        const id = decodeURIComponent(p.slice("/history/".length));
        return json(200, history[id] ? { [id]: history[id] } : {});
      }
      if (p === "/view") {
        const key = `${url.searchParams.get("type") || "output"}/${url.searchParams.get("subfolder") || ""}/${url.searchParams.get("filename")}`;
        const file = files.get(key);
        if (!file) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { "Content-Type": "image/png", "Content-Length": file.length });
        return res.end(file);
      }
      if (p === "/upload/image" && req.method === "POST") {
        const form = parseMultipart(body, req.headers["content-type"]);
        if (!form.image || !form.image.filename) return json(400, { error: "no image" });
        const subfolder = typeof form.subfolder === "string" ? form.subfolder : "";
        files.set(`input/${subfolder}/${form.image.filename}`, form.image.data);
        return json(200, { name: form.image.filename, subfolder, type: "input" });
      }
      res.writeHead(404); res.end();
    });
  });

  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname !== "/ws" || state.offline) { socket.destroy(); return; }
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const clientId = url.searchParams.get("clientId") || randomUUID();
    sockets.set(clientId, socket);
    socket.on("data", (buf) => { if ((buf[0] & 0x0f) === 0x8) socket.end(wsFrame(Buffer.alloc(0), 0x8)); });
    socket.on("error", () => {});
    socket.on("close", () => { if (sockets.get(clientId) === socket) sockets.delete(clientId); });
    socket.write(wsFrame(Buffer.from(JSON.stringify({ type: "status", data: { status: { exec_info: { queue_remaining: queue.length } }, sid: clientId } })), 0x1));
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      const url = `http://${host}:${addr.port}`;
      if (!quiet) console.info(`Mock ComfyUI 실행 중: ${url} (GPU 없이 UI 확인용)`);
      resolve({
        url,
        state,
        dropSockets() { for (const s of sockets.values()) s.destroy(); },
        close: () => new Promise((r) => { for (const s of sockets.values()) s.destroy(); server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const port = Number(process.env.MOCK_PORT || 8199);
  startMockComfy({ port, stepMs: Number(process.env.MOCK_STEP_MS || 120) });
}
