/** 라우트들이 같이 쓰는 작은 HTTP 도우미. 프레임워크 없이 `node:http` 만 쓴다. */

/* ── 다국어 ──────────────────────────────────────────────────────────────────
   사용자에게 보이는 메시지는 L("한국어", "English") 로 두 언어를 함께 갖는다.
   화면이 X-Lang 헤더(EventSource 는 ?lang=)로 언어를 알려 주면 요청마다 그 언어로 답한다.
   기본은 한국어. */
export const LANGS = ["ko", "en"];
export const DEFAULT_LANG = "ko";
export const L = (ko, en) => ({ ko, en });
export function localize(msg, lang = DEFAULT_LANG) {
  if (msg && typeof msg === "object") return msg[lang] ?? msg[DEFAULT_LANG] ?? msg.en ?? "";
  return msg == null ? "" : String(msg);
}
/** 두 언어에 같은 글자를 쓸 때 (예: ComfyUI 가 준 원문 오류). */
export const same = (s) => L(String(s), String(s));
export function langOf(req) {
  let q = null;
  try { q = new URL(req.url, "http://x").searchParams.get("lang"); } catch { /* 무시 */ }
  const h = req.headers["x-lang"];
  const pick = [q, typeof h === "string" ? h : null].find((v) => v && LANGS.includes(v));
  return pick || DEFAULT_LANG;
}

export class HttpError extends Error {
  /** @param message 문자열 또는 L(ko, en) */
  constructor(status, message, extra = {}) {
    super(typeof message === "object" ? message.en : message);
    this.i18n = typeof message === "object" ? message : same(message);
    this.status = status;
    this.extra = extra;
  }
}

/** 모든 응답에 붙는 보안 헤더. 화면은 외부 사이트에서 아무것도 불러오지 않는다. */
export const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin",
};

export function applySecurityHeaders(res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
}

export function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

export function sendError(res, err, logger, lang = DEFAULT_LANG) {
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500 && logger) logger.error("요청 처리 실패:", err && err.stack ? err.stack : err);
  const message = err instanceof HttpError ? localize(err.i18n, lang) : localize(L("서버 내부 오류가 발생했습니다", "Internal server error"), lang);
  sendJson(res, status, { error: message, ...(err instanceof HttpError ? err.extra : {}) },
    err instanceof HttpError && err.extra.retryAfter ? { "Retry-After": String(err.extra.retryAfter) } : {});
}

/** 요청 본문을 크기 제한 안에서 읽는다. Content-Length 로 미리 알 수 있으면 바로 거절한다. */
export function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > limitBytes) { reject(new HttpError(413, L("요청 크기가 너무 큽니다", "Request body too large"))); req.resume(); return; }
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) { reject(new HttpError(413, L("요청 크기가 너무 큽니다", "Request body too large"))); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function readJson(req, limitBytes = 64 * 1024) {
  const type = String(req.headers["content-type"] || "");
  if (!type.toLowerCase().startsWith("application/json")) throw new HttpError(415, L("JSON 형식의 요청이 필요합니다", "Expected application/json"));
  const buf = await readBody(req, limitBytes);
  try {
    const value = JSON.parse(buf.toString("utf8") || "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new HttpError(400, L("요청 형식이 올바르지 않습니다", "Malformed JSON body")); }
}

/**
 * 요청 횟수 제한에 쓸 접속자 IP.
 * Cloudflare Tunnel 뒤에서는 모든 요청이 이 PC 의 cloudflared 에서 오므로, 실제 주소는
 * `CF-Connecting-IP` 헤더에만 있다 — 이 헤더는 TRUST_PROXY=true 일 때만 믿는다.
 */
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf) return cf.trim();
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

export function requestProto(req, trustProxy) {
  if (trustProxy) {
    const p = req.headers["x-forwarded-proto"];
    if (typeof p === "string" && p) return p.split(",")[0].trim();
  }
  return req.socket.encrypted ? "https" : "http";
}

export function createLogger(level = "info") {
  const order = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
  const min = order[level] ?? 20;
  const at = (lvl, fn) => (...args) => { if (order[lvl] >= min) fn(new Date().toISOString(), `[${lvl}]`, ...args); };
  return {
    debug: at("debug", console.debug),
    info: at("info", console.info),
    warn: at("warn", console.warn),
    error: at("error", console.error),
  };
}
