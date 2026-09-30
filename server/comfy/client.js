/**
 * ComfyUI HTTP API 를 부르는 얇은 클라이언트.
 *
 * 이 앱에 필요한 엔드포인트만 감쌌다. 브라우저에서 여기로 바로 올 수 있는 길은 없다 —
 * 라우트가 서버에서 이미 검사한 값만 넣어서 이 메서드들을 부른다.
 */
import { HttpError, L } from "../http-utils.js";

export class ComfyClient {
  constructor({ baseUrl, timeoutMs = 15000 }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
  }

  /** 시간 제한이 있는 fetch (원본 앱의 ServerAPI.request 와 같은 방식). */
  async request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || this.timeoutMs);
    try {
      return await fetch(this.baseUrl + path, { ...options, signal: controller.signal });
    } catch (err) {
      const e = new HttpError(503, L("이미지 서버(ComfyUI)에 연결할 수 없습니다", "Image server (ComfyUI) is not reachable"));
      e.cause = err;
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async json(path, options) {
    const res = await this.request(path, options);
    if (!res.ok) throw new HttpError(502, L(`ComfyUI 응답 오류 ${res.status} (${path.split("?")[0]})`, `ComfyUI responded with ${res.status} for ${path.split("?")[0]}`));
    try { return await res.json(); } catch { throw new HttpError(502, L("ComfyUI 응답을 해석하지 못했습니다", "ComfyUI returned invalid JSON")); }
  }

  async isOnline() {
    try { const res = await this.request("/system_stats", { timeoutMs: 4000 }); return res.ok; }
    catch { return false; }
  }

  /** 어떤 노드 입력에 넣을 수 있는 값 목록. 예: ("CheckpointLoaderSimple", "ckpt_name") → 체크포인트 파일 목록 */
  async listInputOptions(nodeClass, inputName) {
    const data = await this.json(`/object_info/${encodeURIComponent(nodeClass)}`);
    const spec = data?.[nodeClass]?.input?.required?.[inputName] ?? data?.[nodeClass]?.input?.optional?.[inputName];
    const values = Array.isArray(spec) ? spec[0] : null;
    if (Array.isArray(values)) return values.filter((v) => typeof v === "string");
    // 새 버전 ComfyUI 의 "COMBO" 형식: ["COMBO", { options: [...] }]
    if (spec && spec[0] === "COMBO" && Array.isArray(spec[1]?.options)) return spec[1].options;
    return [];
  }

  async hasNodeClass(nodeClass) {
    try { const data = await this.json(`/object_info/${encodeURIComponent(nodeClass)}`); return !!data?.[nodeClass]; }
    catch { return false; }
  }

  /**
   * API 형식 워크플로우를 대기열에 넣는다. ComfyUI 의 검증 오류(node_errors)는
   * "노드 번호 (종류): 메시지" 한 줄로 요약한다 — 원본 앱의 오류 표시와 같은 방식.
   */
  async queuePrompt(workflow, clientId) {
    const res = await this.request("/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    });
    let body = null;
    try { body = await res.json(); } catch { /* 아래에서 처리 */ }
    if (!res.ok) {
      const parts = [];
      if (body?.error) parts.push(`${body.error.type || ""} ${body.error.message || ""}`.trim());
      for (const [nid, ne] of Object.entries(body?.node_errors || {})) {
        const msgs = (ne?.errors || []).map((x) => `${x.message || ""}${x.details ? ` (${x.details})` : ""}`).join("; ");
        parts.push(`node ${nid}${ne?.class_type ? ` (${ne.class_type})` : ""}: ${msgs}`);
      }
      const err = new HttpError(502, L("ComfyUI 가 워크플로우를 거부했습니다", "ComfyUI rejected the workflow"));
      err.detail = parts.join(" | ") || `HTTP ${res.status}`;
      throw err;
    }
    if (!body?.prompt_id) throw new HttpError(502, L("ComfyUI 가 작업 ID를 돌려주지 않았습니다", "ComfyUI did not return a prompt id"));
    return body.prompt_id;
  }

  getQueue() { return this.json("/queue"); }

  async history(promptId) {
    const data = await this.json(`/history/${encodeURIComponent(promptId)}`);
    return data?.[promptId] || null;
  }

  /** 대기 중이면 대기열에서 빼고, 이미 실행 중이면 중단시킨다. */
  async cancel(promptId) {
    const q = await this.getQueue().catch(() => null);
    if (q && (q.queue_pending || []).some((x) => x[1] === promptId)) {
      await this.request("/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: [promptId] }) });
    }
    if (!q || (q.queue_running || []).some((x) => x[1] === promptId)) {
      await this.request("/interrupt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt_id: promptId }) });
    }
  }

  /** 출력/입력 이미지를 받아 온다. `preview`(예: "webp;75")를 주면 ComfyUI 가 썸네일용으로 다시 인코딩한다. */
  view({ filename, subfolder = "", type = "output" }, { preview } = {}) {
    const p = new URLSearchParams({ filename, subfolder, type });
    if (preview) p.set("preview", preview);
    return this.request(`/view?${p}`, { timeoutMs: 60000 });
  }

  async uploadImage(buffer, filename, mime, subfolder) {
    const fd = new FormData();
    fd.append("image", new Blob([buffer], { type: mime }), filename);
    fd.append("type", "input");
    fd.append("subfolder", subfolder);
    fd.append("overwrite", "true");
    const data = await this.json("/upload/image", { method: "POST", body: fd, timeoutMs: 60000 });
    if (!data?.name) throw new HttpError(502, L("ComfyUI 에 이미지를 올리지 못했습니다", "ComfyUI upload failed"));
    return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
  }
}
