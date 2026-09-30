/**
 * 로그인, 세션, 요청 횟수 제한, 같은 출처(Origin) 확인.
 *
 * - 사람은 ACCESS_TOKEN 으로 로그인하고 HMAC 서명된 HttpOnly · SameSite=Strict 세션 쿠키를 받는다
 *   (서버에 세션을 저장하지 않는 방식, DB 없음).
 * - 스크립트는 API_KEY 가 설정돼 있으면 `Authorization: Bearer <API_KEY>` 로 호출할 수 있다.
 * - 브라우저에서 오는 변경 요청(POST 등)은 반드시 이 앱의 주소에서 와야 한다.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { HttpError, L, requestProto } from "./http-utils.js";

export const SESSION_COOKIE = "cms_session";

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const digest = (s) => createHash("sha256").update(String(s)).digest();

/** 시간이 일정한 문자열 비교 (먼저 해시를 떠서 길이를 맞춘다 — 타이밍 공격 방지). */
export function safeEqual(a, b) {
  return timingSafeEqual(digest(a), digest(b));
}

export function signSession(secret, ttlMs, now = Date.now()) {
  const payload = b64url(JSON.stringify({ exp: now + ttlMs, n: randomBytes(8).toString("hex") }));
  const sig = b64url(createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifySession(secret, value, now = Date.now()) {
  if (typeof value !== "string" || value.length > 512) return false;
  const [payload, sig] = value.split(".");
  if (!payload || !sig) return false;
  const expected = b64url(createHmac("sha256", secret).update(payload).digest());
  if (!safeEqual(sig, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof data.exp === "number" && data.exp > now;
  } catch { return false; }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** IP(또는 아무 문자열) 기준 고정 창 방식 횟수 제한. 오래된 기록은 주기적으로 지운다. */
export function createRateLimiter({ limit, windowMs }) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs);
  sweep.unref();
  return {
    take(key) {
      const now = Date.now();
      let entry = hits.get(key);
      if (!entry || entry.reset <= now) { entry = { count: 0, reset: now + windowMs }; hits.set(key, entry); }
      entry.count += 1;
      if (entry.count > limit) {
        throw new HttpError(429, L("요청이 너무 많습니다 — 잠시 후 다시 시도해 주세요", "Too many requests — please wait a moment"), { retryAfter: Math.ceil((entry.reset - now) / 1000) });
      }
    },
    stop() { clearInterval(sweep); },
  };
}

export function createAuth(config) {
  const ttlMs = config.sessionTtlHours * 3600 * 1000;
  const enabled = !!config.accessToken;

  function isSecureRequest(req) {
    return requestProto(req, config.trustProxy) === "https" || config.publicOrigin.startsWith("https://");
  }

  return {
    enabled,

    /** "session" | "api-key" | "open"(로그인 꺼짐) | null(미인증) */
    identify(req) {
      if (!enabled) return "open";
      const authz = req.headers.authorization;
      if (config.apiKey && typeof authz === "string" && authz.startsWith("Bearer ")) {
        return safeEqual(authz.slice(7).trim(), config.apiKey) ? "api-key" : null;
      }
      const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      return cookie && verifySession(config.sessionSecret, cookie) ? "session" : null;
    },

    require(req) {
      const who = this.identify(req);
      if (!who) throw new HttpError(401, L("로그인이 필요합니다", "Sign in required"));
      return who;
    },

    checkToken(token) {
      return enabled && typeof token === "string" && token.length <= 256 && safeEqual(token, config.accessToken);
    },

    sessionCookie(req) {
      const attrs = [`${SESSION_COOKIE}=${signSession(config.sessionSecret, ttlMs)}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${Math.floor(ttlMs / 1000)}`];
      if (isSecureRequest(req)) attrs.push("Secure");
      return attrs.join("; ");
    },

    clearCookie(req) {
      const attrs = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
      if (isSecureRequest(req)) attrs.push("Secure");
      return attrs.join("; ");
    },
  };
}

/**
 * POST 요청의 CSRF 방어. 브라우저는 POST 에 항상 `Origin` 을 붙이므로, 그 값이
 * PUBLIC_ORIGIN 이나 요청이 들어온 주소와 같아야 한다.
 * `Origin` 이 없는 요청(curl, 스크립트)은 API 키로 인증한 경우에만 허용한다.
 */
export function checkOrigin(req, config, who) {
  const origin = req.headers.origin;
  if (!origin) {
    if (who === "api-key" || who === "open") return;
    throw new HttpError(403, L("요청 출처(Origin)가 없습니다", "Missing Origin header"));
  }
  const allowed = new Set();
  if (config.publicOrigin) allowed.add(config.publicOrigin);
  if (req.headers.host) allowed.add(`${requestProto(req, config.trustProxy)}://${req.headers.host}`);
  if (!allowed.has(origin)) throw new HttpError(403, L("다른 사이트에서 온 요청은 차단됩니다", "Cross-origin request blocked"));
}
