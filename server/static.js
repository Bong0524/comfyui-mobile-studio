/**
 * public/ 폴더의 정적 파일만 내보낸다.
 *
 * 원본 앱의 페이지 서버(ops/page_server.py)와 같은 규칙: 경로를 정규화한 뒤 public 폴더 밖이면 거절,
 * 폴더 목록은 절대 보여 주지 않고, 알려진 파일 형식만 내보낸다.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

/** 글자 파일은 gzip 으로 줄여 보낸다 (태그 사전 1.4MB → 약 0.55MB). 압축 결과는 파일이 바뀔 때까지 기억해 둔다. */
const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json)|image\/svg)/;
const gzipCache = new Map();   // 파일 경로 → { mtimeMs, size, buf }
function gzipped(file, stat) {
  const hit = gzipCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.buf;
  const buf = zlib.gzipSync(fs.readFileSync(file), { level: 6 });
  gzipCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, buf });
  return buf;
}

export function serveStatic(req, res, publicDir) {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { return false; }
  if (rel.endsWith("/")) rel += "index.html";
  if (rel.includes("\0") || rel.includes("\\")) return false;
  const file = path.resolve(publicDir, "." + rel);
  if (!file.startsWith(publicDir + path.sep)) return false;
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!type) return false;
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;
  const headers = {
    "Content-Type": type,
    // HTML 은 매번 새로 확인해 수정본이 바로 반영되게, 나머지 파일은 잠깐만 캐시
    "Cache-Control": type.startsWith("text/html") ? "no-cache" : "public, max-age=300",
    "Vary": "Accept-Encoding",
  };
  const wantsGzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
  if (wantsGzip && COMPRESSIBLE.test(type) && stat.size > 1024) {
    let buf;
    try { buf = gzipped(file, stat); } catch { buf = null; }
    if (buf) {
      res.writeHead(200, { ...headers, "Content-Encoding": "gzip", "Content-Length": buf.length });
      res.end(req.method === "HEAD" ? undefined : buf);
      return true;
    }
  }
  res.writeHead(200, { ...headers, "Content-Length": stat.size });
  if (req.method === "HEAD") { res.end(); return true; }
  fs.createReadStream(file).pipe(res);
  return true;
}
