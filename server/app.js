/**
 * HTTP 애플리케이션: 이 시스템에서 외부에 공개되는 유일한 부분.
 *
 *   브라우저 ──HTTPS──> (Cloudflare Tunnel) ──> 이 앱 ──HTTP/WS (이 PC 안)──> ComfyUI
 *
 * 앱은 필요한 기능만 담은 작은 API 를 연다. ComfyUI 자체 API 는 절대 그대로 중계하지 않는다:
 * 임의의 경로·워크플로우·파일 이름을 넘겨주는 라우트는 하나도 없다.
 */
import fs from "node:fs";
import http from "node:http";
import { Readable } from "node:stream";
import { ComfyClient } from "./comfy/client.js";
import { ComfyMonitor } from "./comfy/monitor.js";
import { Catalog } from "./catalog.js";
import { HistoryStore } from "./history-store.js";
import { JobManager } from "./job-manager.js";
import { UploadRegistry } from "./uploads.js";
import { serveStatic } from "./static.js";
import { requireWorkflowRoles } from "./workflow/resolve-nodes.js";
import { validateGenerateRequest } from "./workflow/validate.js";
import { createAuth, createRateLimiter, checkOrigin } from "./security.js";
import {
  HttpError, L, applySecurityHeaders, clientIp, langOf, localize, readBody, readJson, sendError, sendJson,
} from "./http-utils.js";

const SSE_HEARTBEAT_MS = 15000;
const HEALTH_CACHE_MS = 3000;

export function createApp(config, { logger }) {
  const template = JSON.parse(fs.readFileSync(config.workflowFile, "utf8"));
  const roles = requireWorkflowRoles(template, config.workflowFile);

  const comfy = new ComfyClient({ baseUrl: config.comfyUrl, timeoutMs: config.comfyRequestTimeoutMs });
  const monitor = new ComfyMonitor({ wsUrl: config.comfyWsUrl, logger });
  const catalog = new Catalog({ config, comfy, logger, template, roles });
  const store = new HistoryStore({ dir: config.dataDir, limit: config.galleryLimit, logger });
  const jobs = new JobManager({ config, comfy, monitor, template, roles, store, logger });
  const uploads = new UploadRegistry({ comfy, subfolder: config.outputSubfolder });
  const auth = createAuth(config);
  const loginLimiter = createRateLimiter({ limit: config.loginRateLimitPerMin, windowMs: 60000 });
  const generateLimiter = createRateLimiter({ limit: config.generateRateLimitPerMin, windowMs: 60000 });
  const uploadLimiter = createRateLimiter({ limit: 20, windowMs: 60000 });

  let health = { at: 0, online: false };
  async function comfyOnline() {
    if (Date.now() - health.at < HEALTH_CACHE_MS) return health.online;
    const online = await comfy.isOnline();
    health = { at: Date.now(), online };
    return online;
  }

  /* ── public view helpers ─────────────────────────────────────────────── */
  const imageLinks = (id, images) => images.map((_, i) => ({
    url: `/api/images/${id}/${i}`,
    thumbUrl: `/api/images/${id}/${i}?variant=thumb`,
    downloadUrl: `/api/images/${id}/${i}?download=1`,
  }));

  const publicJob = (job, lang) => ({
    id: job.id,
    status: job.status,
    stage: localize(job.stage, lang),
    progress: job.progress,
    position: jobs.position(job),
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error ? localize(job.error, lang) : null,
    request: job.request,
    images: imageLinks(job.id, job.images),
  });

  const publicEntry = (e) => ({
    id: e.id, createdAt: e.createdAt, durationMs: e.durationMs, request: e.request, images: imageLinks(e.id, e.images),
  });

  /* ── routes ──────────────────────────────────────────────────────────── */
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => routes.push({ method, pattern, handler, auth: opts.auth !== false });

  route("GET", /^\/api\/health$/, async (req, res, _m, who) => {
    const online = await comfyOnline();
    sendJson(res, 200, {
      status: "ok",
      comfyui: online ? "online" : "offline",
      ...(who ? { busy: jobs.busy, pending: jobs.pendingCount } : {}),
    });
  }, { auth: false });

  route("GET", /^\/api\/session$/, async (req, res, _m, who) => {
    sendJson(res, 200, { authenticated: !!who, authRequired: auth.enabled });
  }, { auth: false });

  route("POST", /^\/api\/login$/, async (req, res) => {
    loginLimiter.take(clientIp(req, config.trustProxy));
    checkOrigin(req, config, null);
    const body = await readJson(req, 4096);
    if (!auth.checkToken(body.token)) throw new HttpError(401, L("접속 비밀번호가 틀렸습니다", "Wrong access token"));
    sendJson(res, 200, { authenticated: true }, { "Set-Cookie": auth.sessionCookie(req) });
  }, { auth: false });

  route("POST", /^\/api\/logout$/, async (req, res) => {
    sendJson(res, 200, { authenticated: false }, { "Set-Cookie": auth.clearCookie(req) });
  }, { auth: false });

  route("GET", /^\/api\/catalog$/, async (req, res) => {
    await catalog.refresh();
    sendJson(res, 200, catalog.publicView());
  });

  route("POST", /^\/api\/generate$/, async (req, res, _m, who) => {
    checkOrigin(req, config, who);
    generateLimiter.take(clientIp(req, config.trustProxy));
    const body = await readJson(req, 32 * 1024);
    if (!(await comfyOnline())) throw new HttpError(503, L("지금은 이미지 서버(ComfyUI)가 꺼져 있습니다", "The image server is offline right now"));
    await catalog.refresh();
    const validated = validateGenerateRequest(body, catalog, { uploads, safetyNegative: config.safetyNegative });
    const job = jobs.submit(validated);
    sendJson(res, 202, publicJob(job, langOf(req)));
  });

  route("GET", /^\/api\/jobs\/([a-f0-9]{32})$/, async (req, res, m) => {
    const job = jobs.get(m[1]);
    if (!job) throw new HttpError(404, L("작업을 찾을 수 없습니다", "Job not found"));
    sendJson(res, 200, publicJob(job, langOf(req)));
  });

  route("POST", /^\/api\/jobs\/([a-f0-9]{32})\/cancel$/, async (req, res, m, who) => {
    checkOrigin(req, config, who);
    const job = await jobs.cancel(m[1]);
    sendJson(res, 200, publicJob(job, langOf(req)));
  });

  route("GET", /^\/api\/jobs\/([a-f0-9]{32})\/events$/, async (req, res, m) => {
    const job = jobs.get(m[1]);
    if (!job) throw new HttpError(404, L("작업을 찾을 수 없습니다", "Job not found"));
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const isFinal = (j) => ["completed", "failed", "cancelled"].includes(j.status);
    const close = () => {
      clearInterval(beat);
      jobs.off("update", onUpdate);
      jobs.off("preview", onPreview);
      res.end();
    };
    let lastPosition = jobs.position(job);
    const onUpdate = (j) => {
      if (j.id === job.id) { send("job", publicJob(j, langOf(req))); if (isFinal(j)) close(); return; }
      const pos = jobs.position(job);   // 다른 작업이 움직임: 기다리는 사람에게 바뀐 대기 순서를 알린다
      if (job.status === "queued" && pos !== lastPosition) { lastPosition = pos; send("job", publicJob(job, langOf(req))); }
    };
    const onPreview = (j, image) => { if (j.id === job.id) send("preview", { image }); };
    const beat = setInterval(() => res.write(": ping\n\n"), SSE_HEARTBEAT_MS);
    jobs.on("update", onUpdate);
    jobs.on("preview", onPreview);
    req.on("close", close);
    send("job", publicJob(job, langOf(req)));
    if (isFinal(job)) close();
  });

  route("GET", /^\/api\/gallery$/, async (req, res) => {
    sendJson(res, 200, { items: store.list().map(publicEntry) });
  });

  route("DELETE", /^\/api\/gallery\/([a-f0-9]{32})$/, async (req, res, m, who) => {
    checkOrigin(req, config, who);
    store.remove(m[1]);
    sendJson(res, 200, { ok: true });
  });

  route("GET", /^\/api\/images\/([a-f0-9]{32})\/(\d{1,2})$/, async (req, res, m) => {
    const entry = jobs.get(m[1]) || store.get(m[1]);
    const img = entry && entry.images[Number(m[2])];
    if (!img) throw new HttpError(404, L("이미지를 찾을 수 없습니다", "Image not found"));
    const q = new URL(req.url, "http://x").searchParams;
    const thumb = q.get("variant") === "thumb";
    await pipeImage(res, await comfy.view(img, { preview: thumb ? "webp;80" : undefined }), {
      download: q.get("download") === "1" ? `comfyui-${m[1].slice(0, 8)}-${Number(m[2]) + 1}.png` : null,
    });
  });

  route("POST", /^\/api\/uploads$/, async (req, res, _m, who) => {
    checkOrigin(req, config, who);
    uploadLimiter.take(clientIp(req, config.trustProxy));
    if (!catalog.features.controlnet) { await catalog.refresh(true); if (!catalog.features.controlnet) throw new HttpError(403, L("이 서버에서는 참조 이미지 기능이 꺼져 있습니다", "Reference images are not enabled on this server")); }
    const buf = await readBody(req, config.limits.maxUploadBytes);
    const id = await uploads.add(buf);
    sendJson(res, 201, { id, url: `/api/uploads/${id}` });
  });

  route("GET", /^\/api\/uploads\/([a-f0-9]{32})$/, async (req, res, m) => {
    const up = uploads.get(m[1]);
    if (!up) throw new HttpError(404, L("업로드한 이미지를 찾을 수 없습니다", "Upload not found"));
    await pipeImage(res, await comfy.view(up.view), {});
  });

  async function pipeImage(res, upstream, { download }) {
    const type = upstream.headers.get("content-type") || "";
    if (!upstream.ok || !type.startsWith("image/")) throw new HttpError(upstream.status === 404 ? 404 : 502, L("이미지를 불러올 수 없습니다", "Image is not available"));
    const headers = { "Content-Type": type, "Cache-Control": "private, max-age=86400" };
    const len = upstream.headers.get("content-length");
    if (len) headers["Content-Length"] = len;
    if (download) headers["Content-Disposition"] = `attachment; filename="${download}"`;
    res.writeHead(200, headers);
    await new Promise((resolve) => {
      const stream = Readable.fromWeb(upstream.body);
      stream.on("error", () => { res.destroy(); resolve(); });
      res.on("close", resolve);
      stream.pipe(res);
    });
  }

  /* ── dispatcher ──────────────────────────────────────────────────────── */
  async function handle(req, res) {
    applySecurityHeaders(res);
    const pathname = new URL(req.url, "http://x").pathname;
    try {
      if (pathname.startsWith("/api/")) {
        for (const r of routes) {
          const m = pathname.match(r.pattern);
          if (!m) continue;
          if (r.method !== req.method) continue;
          const who = r.auth ? auth.require(req) : auth.identify(req);
          await r.handler(req, res, m, who);
          return;
        }
        throw new HttpError(routes.some((r) => r.pattern.test(pathname)) ? 405 : 404, L("찾을 수 없습니다", "Not found"));
      }
      if ((req.method === "GET" || req.method === "HEAD") && serveStatic(req, res, config.publicDir)) return;
      throw new HttpError(404, L("찾을 수 없습니다", "Not found"));
    } catch (err) {
      sendError(res, err, logger, langOf(req));
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.requestTimeout = 120000;
  server.headersTimeout = 30000;

  return {
    server,
    jobs,
    catalog,
    monitor,
    async start() {
      monitor.start();
      catalog.refresh(true);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.appPort, config.appHost, resolve);
      });
      return server.address();
    },
    async stop() {
      monitor.stop();
      loginLimiter.stop(); generateLimiter.stop(); uploadLimiter.stop();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
