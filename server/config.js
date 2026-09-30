/**
 * 실행 설정.
 *
 * 배포마다 달라지는 값(주소, 포트, 비밀값, 도메인)은 모두 환경변수나 `.env` 파일에서 읽는다.
 * 코드에는 특정 PC 전용 값이 없고, `.env` 는 git 에 올라가지 않는다 — 전체 목록은 `.env.example`.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 간단한 `.env` 읽기 (KEY=VALUE, `#` 주석, 따옴표 허용). 이미 설정된 환경변수는 덮어쓰지 않는다. */
export function loadEnvFile(file = path.join(ROOT_DIR, ".env"), target = process.env) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return false; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    if (!(key in target)) target[key] = value;
  }
  return true;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
export const isLoopbackHost = (host) => LOOPBACK.has(String(host || "").trim().toLowerCase());

function str(env, key, fallback = "") {
  const v = env[key];
  return v == null || String(v).trim() === "" ? fallback : String(v).trim();
}
function int(env, key, fallback, min, max) {
  const raw = str(env, key, "");
  if (raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${key} 는 ${min}~${max} 사이의 정수여야 합니다 (현재 값: "${raw}")`);
  return n;
}
function bool(env, key, fallback = false) {
  const raw = str(env, key, "").toLowerCase();
  if (raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}
function resolvePath(p) { return path.isAbsolute(p) ? p : path.join(ROOT_DIR, p); }

function wsUrlFrom(httpUrl) {
  const u = new URL(httpUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = u.pathname.replace(/\/$/, "") + "/ws";
  return u.toString();
}

/**
 * 설정 객체를 만들고 검사한다.
 * 값이 위험하거나 형식이 틀리면 알아보기 쉬운 메시지로 예외를 던져서,
 * 어중간한 설정으로 실행되는 대신 서버가 아예 시작하지 않게 한다.
 */
export function createConfig(env = process.env) {
  const comfyUrl = str(env, "COMFYUI_URL", "http://127.0.0.1:8188").replace(/\/+$/, "");
  try { new URL(comfyUrl); } catch { throw new Error(`COMFYUI_URL 이 올바른 주소가 아닙니다: ${comfyUrl}`); }

  const domain = str(env, "DOMAIN", "");
  const publicOrigin = str(env, "PUBLIC_ORIGIN", domain ? `https://${domain}` : "").replace(/\/+$/, "");

  const cfg = {
    appHost: str(env, "APP_HOST", "127.0.0.1"),
    appPort: int(env, "APP_PORT", 8080, 0, 65535),
    domain,
    publicOrigin,
    trustProxy: bool(env, "TRUST_PROXY", false),

    comfyUrl,
    comfyWsUrl: str(env, "COMFYUI_WS_URL", wsUrlFrom(comfyUrl)),
    comfyRequestTimeoutMs: int(env, "COMFYUI_REQUEST_TIMEOUT_MS", 15000, 1000, 120000),

    accessToken: str(env, "ACCESS_TOKEN", ""),
    apiKey: str(env, "API_KEY", ""),
    sessionSecret: str(env, "SESSION_SECRET", ""),
    sessionTtlHours: int(env, "SESSION_TTL_HOURS", 12, 1, 24 * 30),
    allowNoAuth: bool(env, "ALLOW_NO_AUTH", false),

    generateRateLimitPerMin: int(env, "GENERATE_RATE_LIMIT_PER_MIN", 6, 1, 600),
    loginRateLimitPerMin: int(env, "LOGIN_RATE_LIMIT_PER_MIN", 5, 1, 600),
    maxPendingJobs: int(env, "MAX_PENDING_JOBS", 2, 0, 50),
    jobIdleTimeoutSec: int(env, "JOB_IDLE_TIMEOUT_SEC", 180, 10, 3600),
    jobMaxDurationSec: int(env, "JOB_MAX_DURATION_SEC", 900, 30, 7200),

    limits: {
      maxPromptLength: int(env, "MAX_PROMPT_LENGTH", 1500, 50, 10000),
      maxSteps: int(env, "MAX_STEPS", 40, 1, 150),
      maxBatchSize: int(env, "MAX_BATCH_SIZE", 2, 1, 8),
      maxPixels: int(env, "MAX_PIXELS", 1536 * 1536, 256 * 256, 4096 * 4096),
      maxLoras: int(env, "MAX_LORAS", 3, 0, 8),
      maxUploadBytes: int(env, "MAX_UPLOAD_MB", 8, 1, 50) * 1024 * 1024,
    },

    outputSubfolder: str(env, "OUTPUT_SUBFOLDER", "portfolio-demo").replace(/[^\w-]/g, "_"),
    workflowFile: resolvePath(str(env, "WORKFLOW_FILE", "workflows/txt2img.api.json")),
    modelsFile: resolvePath(str(env, "MODELS_CONFIG", "config/models.json")),
    modelListMode: str(env, "MODEL_LIST_MODE", "allowlist").toLowerCase(),
    stylePresetsFile: resolvePath(str(env, "STYLE_PRESETS_FILE", "config/style-presets.json")),
    promptTagsFile: resolvePath(str(env, "PROMPT_TAGS_FILE", "config/prompt-tags.json")),
    blockedTermsFile: resolvePath(str(env, "BLOCKED_TERMS_FILE", "config/blocked-terms.txt")),
    safetyNegative: str(env, "SAFETY_NEGATIVE", ""),
    controlnetModel: str(env, "CONTROLNET_MODEL", ""),
    controlnetPreprocessor: str(env, "CONTROLNET_PREPROCESSOR", "none").toLowerCase(),
    galleryLimit: int(env, "GALLERY_LIMIT", 48, 0, 1000),
    dataDir: resolvePath(str(env, "DATA_DIR", "data")),
    publicDir: path.join(ROOT_DIR, "public"),
    logLevel: str(env, "LOG_LEVEL", "info").toLowerCase(),
    ephemeralSecret: false,
  };

  if (!["allowlist", "all"].includes(cfg.modelListMode)) throw new Error('MODEL_LIST_MODE 는 "allowlist" 또는 "all" 이어야 합니다');
  if (!["none", "openpose"].includes(cfg.controlnetPreprocessor)) throw new Error('CONTROLNET_PREPROCESSOR 는 "none" 또는 "openpose" 여야 합니다');
  if (cfg.publicOrigin) {
    try { const u = new URL(cfg.publicOrigin); if (u.origin !== cfg.publicOrigin) throw new Error(); }
    catch { throw new Error(`PUBLIC_ORIGIN 은 https://demo.example.com 같은 형식이어야 합니다 (현재 값: "${cfg.publicOrigin}")`); }
  }

  /* 로그인은 필수다. 이 PC 안에서만 쓰는 개발 서버에서 명시적으로 끈 경우만 예외.
     외부 터널은 항상 이 프로세스로 연결되므로, "비밀번호 없음" 이 조용한 기본값이 되면 안 된다. */
  if (!cfg.accessToken) {
    if (!(cfg.allowNoAuth && isLoopbackHost(cfg.appHost))) {
      throw new Error("ACCESS_TOKEN(접속 비밀번호)이 필요합니다. (로컬 개발용으로만: ALLOW_NO_AUTH=true + APP_HOST=127.0.0.1)");
    }
  } else if (cfg.accessToken.length < 8) {
    throw new Error("ACCESS_TOKEN 은 8자 이상이어야 합니다");
  }
  if (!cfg.sessionSecret) { cfg.sessionSecret = randomBytes(32).toString("hex"); cfg.ephemeralSecret = true; }
  return cfg;
}
