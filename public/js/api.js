/**
 * 브라우저 → 앱 서버 API 호출.
 * 모든 호출에 시간 제한을 두고, 응답 형식을 확인한 뒤에 쓴다.
 * 어느 요청이든 401 이 오면 로그인 화면으로 돌려보낸다.
 * 현재 화면 언어를 X-Lang 헤더로 보내서, 서버 오류 메시지도 같은 언어로 받는다.
 */
import { t, getLang } from "./i18n.js";

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

const listeners = new Set();
/** 세션이 끊겼을 때(401) 부를 함수를 등록한다. */
export function onUnauthorized(fn) { listeners.add(fn); }

export async function request(path, { method = "GET", json, body, headers = {}, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: { "X-Lang": getLang(), ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : body,
      signal: controller.signal,
    });
  } catch (err) {
    throw new ApiError(err.name === "AbortError" ? t("api.timeout") : t("api.network"), 0);
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  if ((res.headers.get("content-type") || "").includes("application/json")) {
    try { data = await res.json(); } catch { data = null; }
  }
  if (res.status === 401 && path !== "/api/login") listeners.forEach((fn) => fn());
  if (!res.ok) {
    const retry = res.headers.get("retry-after");
    const msg = (data && typeof data.error === "string" && data.error) || t("api.failed", { status: res.status });
    throw new ApiError(retry && res.status === 429 ? t("api.retryIn", { msg, s: retry }) : msg, res.status);
  }
  if (data === null || typeof data !== "object") throw new ApiError(t("api.badResponse"), res.status);
  return data;
}

/* 용도별 호출 — 화면이 기대하는 응답 모양인지 각각 확인한다. */
const need = (cond, what) => { if (!cond) throw new ApiError(`${t("api.badResponse")} (${what})`); };

export const api = {
  session: () => request("/api/session"),
  health: () => request("/api/health", { timeoutMs: 8000 }),
  login: (token) => request("/api/login", { method: "POST", json: { token } }),
  logout: () => request("/api/logout", { method: "POST", json: {} }),

  async catalog() {
    const c = await request("/api/catalog");
    need(Array.isArray(c.checkpoints) && Array.isArray(c.loras) && Array.isArray(c.sizes) && c.defaults && c.limits, "catalog");
    return c;
  },

  async generate(params) {
    const job = await request("/api/generate", { method: "POST", json: params });
    need(typeof job.id === "string" && typeof job.status === "string", "job");
    return job;
  },

  job: (id) => request(`/api/jobs/${encodeURIComponent(id)}`),
  cancel: (id) => request(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", json: {} }),

  async gallery() {
    const g = await request("/api/gallery");
    need(Array.isArray(g.items), "gallery");
    return g.items;
  },
  hide: (id) => request(`/api/gallery/${encodeURIComponent(id)}`, { method: "DELETE", json: {} }),

  async upload(blob) {
    const r = await request("/api/uploads", { method: "POST", body: blob, headers: { "Content-Type": blob.type || "image/png" }, timeoutMs: 60000 });
    need(typeof r.id === "string" && typeof r.url === "string", "upload");
    return r;
  },
};
