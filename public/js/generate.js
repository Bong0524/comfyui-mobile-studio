/**
 * 브라우저 쪽 생성 흐름:
 *   POST /api/generate → 작업 ID → Server-Sent Events (/api/jobs/:id/events)
 *   → 진행률 / 실시간 미리보기 / 결과
 *
 * 안정성 규칙 (원본 앱의 실행 루프와 같은 원칙):
 *  - 첫 await 전에 `running` 플래그를 세워 연속 탭(중복 요청)을 막는다
 *  - 이벤트 스트림이 끊기면 GET /api/jobs/:id 폴링으로 이어 간다
 *  - 서버가 아무 소식도 없으면 클라이언트 쪽 상한 시간 뒤에 멈춘다
 */
import { api } from "./api.js";
import { $, el, toast, formatDuration } from "./ui.js";
import { t, getLang } from "./i18n.js";

const CLIENT_TIMEOUT_MS = 20 * 60 * 1000;
const POLL_MS = 2000;

export function createGenerator({ status, onStart, onFinished, onOpenImage }) {
  const btn = $("generateBtn"), cancelBtn = $("cancelBtn");
  const progressBox = $("progressBox"), stageText = $("stageText"), elapsedText = $("elapsedText");
  const bar = $("progressBar"), fill = $("progressFill"), detail = $("progressDetail");
  const placeholder = $("placeholder"), live = $("livePreview"), results = $("results");
  const errorBox = $("errorBox"), errorText = $("errorText"), retryBtn = $("retryBtn"), meta = $("resultMeta");

  let running = false, jobId = null, es = null, pollTimer = null, ceiling = null, ticker = null, startedAt = 0, lastBody = null;

  /** 생성 버튼 상태: 생성 중이면 로딩 표시, 서버가 꺼져 있으면 비활성. */
  function setButtons() {
    btn.disabled = running || status.online === false;
    btn.classList.toggle("loading", running);
    btn.textContent = status.online === false && !running ? t("generate.offline") : t("generate");
    cancelBtn.hidden = !running;
    cancelBtn.disabled = false;
  }
  status.onChange(setButtons);

  function setProgress(job) {
    const queued = job.status === "queued";
    bar.classList.toggle("indeterminate", queued || job.progress.max <= 1);   // 스텝 정보가 없으면 흐르는 막대
    const pct = Math.round((job.progress.value / Math.max(1, job.progress.max)) * 100);
    fill.style.width = `${pct}%`;
    bar.setAttribute("aria-valuenow", String(pct));
    stageText.textContent = queued ? t("progress.waitingGpu") : job.stage || t("progress.working");
    detail.textContent = queued && job.position ? t("progress.position", { n: job.position })
      : job.progress.max > 1 ? t("progress.step", { v: job.progress.value, max: job.progress.max }) : "";
  }

  function stopTracking() {
    if (es) { es.close(); es = null; }
    clearInterval(pollTimer); pollTimer = null;
    clearTimeout(ceiling); ceiling = null;
    clearInterval(ticker); ticker = null;
  }

  /** 성공·실패·취소 어느 쪽이든 끝났을 때의 정리. */
  function end() {
    stopTracking();
    running = false;
    jobId = null;
    status.setGenerating(false);
    progressBox.hidden = true;
    live.hidden = true;
    setButtons();
  }

  function showError(message) {
    errorText.textContent = message;
    errorBox.hidden = false;
    placeholder.hidden = results.children.length > 0;
    toast(message, { error: true });
  }

  function showResult(job) {
    const r = job.request;
    results.classList.toggle("multi", job.images.length > 1);
    results.replaceChildren(...job.images.map((img, i) => el("div", { class: "result-item" },
      el("img", { src: img.url, alt: t("result.imageAlt", { n: i + 1, prompt: r.prompt.slice(0, 80) }), loading: "eager", onclick: () => onOpenImage(job, i) }),
      el("div", { class: "result-actions" },
        el("a", { class: "btn ghost small", href: img.downloadUrl, download: "" }, t("download")),
        el("button", { type: "button", class: "btn ghost small", onclick: () => onOpenImage(job, i) }, t("details")),
      ),
    )));
    placeholder.hidden = true;
    const took = job.finishedAt && job.startedAt ? formatDuration(job.finishedAt - job.startedAt) : "";
    meta.textContent = t("result.meta", { w: r.width, h: r.height, seed: r.seed, steps: r.steps, cfg: r.cfg, sampler: r.sampler })
      + (r.hires && r.hires.enabled ? ` · Hires ×${r.hires.scale}` : "") + (took ? ` · ${took}` : "");
  }

  /** 서버가 보낸 작업 상태 하나를 화면에 반영한다 (SSE·폴링 공통). */
  function handleJob(job) {
    if (!job || job.id !== jobId) return;
    setProgress(job);
    if (job.status === "completed") { showResult(job); end(); onFinished(job); toast(t("result.done")); }
    else if (job.status === "failed") { end(); showError(job.error || t("result.failed")); onFinished(null, job.error); }
    else if (job.status === "cancelled") { end(); placeholder.hidden = results.children.length > 0; toast(t("result.cancelled")); }
  }

  /** 이벤트 스트림 대신 2초마다 상태를 물어보는 대체 경로. */
  function poll() {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      if (!jobId) return;
      try { handleJob(await api.job(jobId)); }
      catch (err) { if (err.status === 404) { end(); showError(t("result.lost")); } }
    }, POLL_MS);
  }

  function follow(id) {
    // EventSource 는 헤더를 못 붙이므로 언어는 쿼리로 보낸다
    es = new EventSource(`/api/jobs/${id}/events?lang=${getLang()}`);
    es.addEventListener("job", (e) => { try { handleJob(JSON.parse(e.data)); } catch { /* 깨진 이벤트는 무시 */ } });
    es.addEventListener("preview", (e) => {
      try {
        const { image } = JSON.parse(e.data);
        if (typeof image === "string" && image.startsWith("data:image/")) { live.src = image; live.hidden = false; placeholder.hidden = true; }
      } catch { /* 무시 */ }
    });
    es.onerror = () => {
      if (!running || !es) return;
      es.close(); es = null;
      poll();   // 스트림이 끊김(네트워크 전환, 프록시 시간 제한 등) → 폴링으로 계속
    };
  }

  async function start(body) {
    if (running) { toast(t("generate.busy")); return; }
    running = true;            // await 전에 세운다: 연속 탭 방지
    lastBody = body;
    errorBox.hidden = true;
    results.replaceChildren();
    meta.textContent = "";
    live.hidden = true;
    placeholder.hidden = false;
    progressBox.hidden = false;
    setProgress({ status: "running", progress: { value: 0, max: 1 }, stage: t("progress.sending") });
    startedAt = Date.now();
    elapsedText.textContent = formatDuration(0);
    ticker = setInterval(() => { elapsedText.textContent = formatDuration(Date.now() - startedAt); }, 1000);
    status.setGenerating(true);
    setButtons();
    onStart();
    try {
      const job = await api.generate(body);
      jobId = job.id;
      handleJob(job);
      if (running) {
        follow(job.id);
        ceiling = setTimeout(() => {
          const id = jobId;
          end();
          showError(t("result.tooLong"));
          if (id) api.cancel(id).catch(() => {});
        }, CLIENT_TIMEOUT_MS);
      }
    } catch (err) {
      end();
      showError(err.message);
      onFinished(null, err.message);
    }
  }

  cancelBtn.addEventListener("click", async () => {
    if (!jobId) return;
    cancelBtn.disabled = true;
    stageText.textContent = t("progress.cancelling");
    try { await api.cancel(jobId); } catch (err) { toast(err.message, { error: true }); cancelBtn.disabled = false; }
  });
  retryBtn.addEventListener("click", () => { if (lastBody) start(lastBody); });

  setButtons();
  return { start, get running() { return running; } };
}
