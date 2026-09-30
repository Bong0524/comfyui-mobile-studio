/**
 * 생성 작업 관리: 한 번에 하나씩, 짧은 대기열과 함께.
 *
 *   submit() → 앱 대기열 → 워크플로우 조립 → POST /prompt → WebSocket 이벤트 따라가기
 *            → SaveImage 결과 모으기 → 갤러리
 *
 * 원본 앱(js/10-ws-run.js)에서 가져온 안정성 규칙:
 *  - 활동 기반 시간 제한: 이 작업의 이벤트가 올 때마다 타이머를 다시 감는다.
 *    오래 걸려도 진행 중이면 끊지 않고, 소식이 끊긴 작업만 시간 초과로 처리한다.
 *    ComfyUI 자체 대기열에서 아직 *대기* 중이면(다른 사람이 GPU 사용 중) 실패시키지 않고 다시 감는다.
 *  - "완료" 메시지를 놓쳐도 작업이 멈추면 안 된다: 소켓과 별개로 /history 를 주기적으로 확인한다.
 *  - 취소는 실패와 다른 결과로 다룬다.
 */
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { HttpError, L, same } from "./http-utils.js";
import { buildWorkflow } from "./workflow/build-workflow.js";

/* 노드가 실행될 때 보여 줄 단계 이름 — 역할 기준 (노드 번호는 워크플로우마다 다르므로). */
const ROLE_STAGES = {
  checkpoint: L("모델 불러오는 중", "Loading model"),
  positive: L("프롬프트 해석 중", "Encoding prompt"),
  negative: L("네거티브 프롬프트 해석 중", "Encoding negative prompt"),
  latent: L("캔버스 준비 중", "Preparing canvas"),
  baseSampler: L("이미지 생성 중", "Sampling"),
  latentUpscale: L("Hires 확대 중", "Hires upscale"),
  hiresSampler: L("Hires 보정 중", "Hires sampling"),
  decode: L("이미지 디코딩 중", "Decoding image"),
  save: L("이미지 저장 중", "Saving image"),
};
function stageTitles(wf, roles) {
  const titles = {};
  for (const [id, node] of Object.entries(wf)) titles[id] = same(node._meta?.title || node.class_type);
  for (const [role, id] of Object.entries(roles)) if (id && ROLE_STAGES[role] && wf[id]) titles[id] = ROLE_STAGES[role];
  for (const id of Object.keys(wf)) {
    const m = /^app_lora_(\d+)$/.exec(id);
    if (m) titles[id] = L(`LoRA ${m[1]} 적용 중`, `Applying LoRA ${m[1]}`);
    else if (id === "app_cn_pre") titles[id] = L("포즈 추출 중", "Extracting pose");
    else if (id.startsWith("app_cn_")) titles[id] = L("ControlNet 적용 중", "Applying ControlNet");
  }
  return titles;
}

const HISTORY_POLL_MS = 4000;
const PREVIEW_MIN_INTERVAL_MS = 400;
const PREVIEW_MAX_BYTES = 400 * 1024;
const KEEP_FINISHED_JOBS = 100;

const isOutputImage = (x) => x && typeof x.filename === "string" && x.type === "output";

export class JobManager extends EventEmitter {
  constructor({ config, comfy, monitor, template, roles, store, logger }) {
    super();
    this.setMaxListeners(200);
    this.config = config;
    this.comfy = comfy;
    this.monitor = monitor;
    this.template = template;
    this.roles = roles;
    this.store = store;
    this.logger = logger;
    this.jobs = new Map();
    this.queue = [];
    this.active = null;
    this.abortActive = null;
    this.lastPreviewAt = 0;

    monitor.on("preview", (frame) => this.onPreview(frame));
  }

  get busy() { return !!this.active; }
  get pendingCount() { return this.queue.length; }

  submit({ request, params }) {
    if (this.active && this.queue.length >= this.config.maxPendingJobs) {
      throw new HttpError(429, L("GPU 가 다른 작업을 처리 중입니다 — 잠시 후 다시 시도해 주세요", "The GPU is busy — please try again in a moment"), { retryAfter: 10 });
    }
    const job = {
      id: randomBytes(16).toString("hex"),
      status: "queued",
      stage: L("GPU 대기 중", "Waiting for the GPU"),
      progress: { value: 0, max: 1 },
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      request,
      params,
      images: [],
      error: null,
      promptId: null,
    };
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    this.trimFinished();
    this.update(job);
    setImmediate(() => this.pump());
    return job;
  }

  get(id) { return this.jobs.get(id) || null; }

  position(job) {
    const i = this.queue.indexOf(job.id);
    return i < 0 ? 0 : i + 1;
  }

  async cancel(id) {
    const job = this.jobs.get(id);
    if (!job) throw new HttpError(404, L("작업을 찾을 수 없습니다", "Job not found"));
    if (["completed", "failed", "cancelled"].includes(job.status)) return job;
    const qi = this.queue.indexOf(id);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      this.finish(job, "cancelled", L("취소했습니다", "Cancelled"));
      this.queue.forEach((jid) => this.update(this.jobs.get(jid)));
      return job;
    }
    if (this.active === id) {
      job.cancelRequested = true;
      job.stage = L("취소하는 중…", "Cancelling…");
      this.update(job);
      if (job.promptId) await this.comfy.cancel(job.promptId).catch((err) => this.logger.warn("취소 요청 실패:", err.message));
      // 보통은 ComfyUI 가 execution_interrupted 로 답한다. 서버가 죽었으면 그 답을 기다리지 않는다.
      setTimeout(() => { if (this.active === id && this.abortActive) this.abortActive("cancelled"); }, 5000).unref();
    }
    return job;
  }

  /* ── internals ─────────────────────────────────────────────────────────── */

  update(job) { if (job) this.emit("update", job); }

  finish(job, status, error = null) {
    job.status = status;
    job.error = error;
    job.finishedAt = Date.now();
    job.stage = status === "completed" ? L("완료", "Done") : status === "cancelled" ? L("취소됨", "Cancelled") : L("실패", "Failed");
    this.update(job);
  }

  trimFinished() {
    const done = [...this.jobs.values()].filter((j) => j.finishedAt).sort((a, b) => a.finishedAt - b.finishedAt);
    while (done.length > KEEP_FINISHED_JOBS) this.jobs.delete(done.shift().id);
  }

  async pump() {
    if (this.active || !this.queue.length) return;
    const job = this.jobs.get(this.queue.shift());
    if (!job) return this.pump();
    this.active = job.id;
    this.queue.forEach((jid) => this.update(this.jobs.get(jid)));
    try {
      await this.run(job);
    } catch (err) {
      const cancelled = err && err.cancelled;
      if (!cancelled) this.logger.warn(`작업 ${job.id.slice(0, 8)} 실패:`, err.detail || err.message);
      this.finish(job, cancelled ? "cancelled" : "failed", cancelled ? L("취소했습니다", "Cancelled") : publicMessage(err));
    } finally {
      this.active = null;
      this.abortActive = null;
      setImmediate(() => this.pump());
    }
  }

  async run(job) {
    job.status = "running";
    job.startedAt = Date.now();
    job.stage = L("워크플로우 준비 중", "Preparing workflow");
    this.update(job);

    const day = new Date().toISOString().slice(0, 10);
    const wf = buildWorkflow(this.template, this.roles, {
      ...job.params,
      filenamePrefix: `${this.config.outputSubfolder}/${day}/${job.id.slice(0, 12)}`,
    }, { controlnetModel: this.config.controlnetModel });
    const titles = stageTitles(wf, this.roles);

    job.stage = L("ComfyUI 로 전송 중", "Sending to ComfyUI");
    this.update(job);
    job.promptId = await this.comfy.queuePrompt(wf, this.monitor.clientId);
    if (job.cancelRequested) {
      // 작업을 보내는 사이에 취소가 들어왔다.
      await this.comfy.cancel(job.promptId).catch(() => {});
      throw Object.assign(new Error("Cancelled"), { cancelled: true });
    }
    job.stage = L("ComfyUI 대기열에서 대기 중", "Queued in ComfyUI");
    this.update(job);

    const images = await this.follow(job, titles);
    if (!images.length) throw Object.assign(new Error("The workflow finished without producing an image"), { i18n: L("워크플로우가 끝났지만 이미지가 만들어지지 않았습니다", "The workflow finished without producing an image") });
    job.images = images.map(({ filename, subfolder, type }) => ({ filename, subfolder: subfolder || "", type }));
    job.progress = { value: 1, max: 1 };
    this.finish(job, "completed");
    this.store.add({
      id: job.id,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      durationMs: job.finishedAt - job.startedAt,
      request: job.request,
      images: job.images,
    });
  }

  /** 작업 하나를 이미지가 나오거나 · 실패하거나 · 취소되거나 · 시간 초과될 때까지 따라간다. */
  follow(job, titles) {
    const { comfy, monitor, roles, config } = this;
    const promptId = job.promptId;
    return new Promise((resolve, reject) => {
      let settled = false;
      let collected = [];
      let idleTimer = null;
      let maxTimer = null;

      const cleanup = () => {
        settled = true;
        clearTimeout(idleTimer);
        clearTimeout(maxTimer);
        clearInterval(poll);
        monitor.off("event", onEvent);
      };
      const fail = (message, extra = {}) => { if (settled) return; cleanup(); reject(Object.assign(new Error(message.en), { i18n: message }, extra)); };
      const done = (imgs) => { if (settled) return; cleanup(); resolve(imgs); };

      this.abortActive = (why) => fail(why === "cancelled" ? L("취소했습니다", "Cancelled") : L("중단했습니다", "Aborted"), { cancelled: why === "cancelled" });

      const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(async () => {
          if (settled) return;
          // Still waiting behind other prompts in ComfyUI's own queue → keep waiting.
          const q = await comfy.getQueue().catch(() => null);
          if (q && (q.queue_pending || []).some((x) => x[1] === promptId)) { armIdle(); return; }
          if (await checkHistory()) return;
          comfy.cancel(promptId).catch(() => {});
          fail(L("시간 초과 — 이미지 서버가 응답하지 않습니다", "Generation timed out — the image server stopped responding"));
        }, config.jobIdleTimeoutSec * 1000);
      };
      maxTimer = setTimeout(() => {
        comfy.cancel(promptId).catch(() => {});
        fail(L("생성 시간이 너무 길어 중단했습니다", "Generation took too long and was stopped"));
      }, config.jobMaxDurationSec * 1000);

      /** WebSocket 메시지를 놓쳤을 때를 위한 안전망: /history 에서 결과를 직접 읽는다. */
      const checkHistory = async () => {
        if (settled) return true;
        let rec;
        try { rec = await comfy.history(promptId); } catch { return false; }
        if (!rec) return false;
        if (rec.status?.status_str === "error") {
          const msg = (rec.status.messages || []).find((m) => m[0] === "execution_error")?.[1]?.exception_message;
          fail(msg ? L(`ComfyUI 오류: ${String(msg).slice(0, 200)}`, `ComfyUI error: ${String(msg).slice(0, 200)}`) : L("ComfyUI 에서 오류가 발생했습니다", "ComfyUI reported an error"));
          return true;
        }
        const out = rec.outputs?.[roles.save]?.images;
        if (Array.isArray(out) && out.some(isOutputImage)) { done(out.filter(isOutputImage)); return true; }
        return false;
      };
      const poll = setInterval(() => { checkHistory(); }, HISTORY_POLL_MS);

      const onEvent = (msg) => {
        const data = msg.data || {};
        if (data.prompt_id !== promptId) return;
        armIdle();
        switch (msg.type) {
          case "execution_start":
            job.stage = L("시작하는 중", "Starting");
            this.update(job);
            break;
          case "execution_cached":
            job.stage = L("캐시 확인 중", "Loading cached nodes");
            this.update(job);
            break;
          case "executing":
            if (data.node == null) {
              // 예전 ComfyUI 는 이렇게 완료를 알린다.
              if (collected.length) done(collected);
              else checkHistory().then((ok) => { if (!ok) fail(L("이미지가 만들어지지 않았습니다", "No image was produced")); });
            } else {
              job.stage = titles[data.node] || L("실행 중", "Running");
              job.progress = { value: 0, max: 1 };
              this.update(job);
            }
            break;
          case "progress":
            job.progress = { value: Number(data.value) || 0, max: Math.max(1, Number(data.max) || 1) };
            if (data.node && titles[data.node]) job.stage = titles[data.node];
            this.update(job);
            break;
          case "executed":
            if (String(data.node) === String(roles.save) && Array.isArray(data.output?.images)) {
              collected = collected.concat(data.output.images.filter(isOutputImage));
            }
            break;
          case "execution_success":
            if (collected.length) done(collected);
            else checkHistory().then((ok) => { if (!ok) fail(L("이미지가 만들어지지 않았습니다", "No image was produced")); });
            break;
          case "execution_error":
            { const em = String(data.exception_message || "execution failed").slice(0, 200); fail(L(`ComfyUI 오류: ${em}`, `ComfyUI error: ${em}`)); }
            break;
          case "execution_interrupted":
            fail(L("취소했습니다", "Cancelled"), { cancelled: true });
            break;
          default:
            break;
        }
      };

      monitor.on("event", onEvent);
      armIdle();
      // 구독하기 전에 이미 끝났을 수도 있다 (캐시로 바로 끝나는 작은 작업).
      checkHistory();
    });
  }

  onPreview({ mime, bytes }) {
    const job = this.active && this.jobs.get(this.active);
    if (!job || job.status !== "running" || bytes.length > PREVIEW_MAX_BYTES) return;
    const now = Date.now();
    if (now - this.lastPreviewAt < PREVIEW_MIN_INTERVAL_MS) return;
    this.lastPreviewAt = now;
    this.emit("preview", job, `data:${mime};base64,${bytes.toString("base64")}`);
  }
}

/** 실패한 작업의 두 언어 메시지 { ko, en }. */
function publicMessage(err) {
  const base = err && err.i18n ? err.i18n : err && err.message ? same(String(err.message).slice(0, 300)) : L("생성에 실패했습니다", "Generation failed");
  if (err instanceof HttpError && err.detail) {
    const d = String(err.detail).slice(0, 300);
    return L(`${base.ko}: ${d}`, `${base.en}: ${d}`);
  }
  return base;
}
