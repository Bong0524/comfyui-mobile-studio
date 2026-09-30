/**
 * 참조 이미지 업로드 (선택 기능인 ControlNet 포즈/참조용).
 *
 * 브라우저가 이미지 바이트를 그대로 보내면, 서버가 파일 앞부분(매직 바이트)으로 실제 형식을
 * 확인하고, 무작위 이름을 붙여 ComfyUI 의 input 폴더로 넘긴다.
 * 브라우저는 의미 없는 ID 만 받으므로 저장 경로를 정할 수 없다.
 */
import { randomBytes } from "node:crypto";
import { HttpError, L } from "./http-utils.js";

const TTL_MS = 6 * 3600 * 1000;
const MAX_UPLOADS = 200;

export function sniffImageType(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", ext: "png" };
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return { mime: "image/webp", ext: "webp" };
  return null;
}

export class UploadRegistry {
  constructor({ comfy, subfolder }) {
    this.comfy = comfy;
    this.subfolder = `${subfolder}-input`;
    this.items = new Map();
  }

  sweep() {
    const now = Date.now();
    for (const [id, v] of this.items) if (now - v.createdAt > TTL_MS) this.items.delete(id);
    while (this.items.size > MAX_UPLOADS) this.items.delete(this.items.keys().next().value);
  }

  get(id) {
    this.sweep();
    return this.items.get(id) || null;
  }

  async add(buffer) {
    const type = sniffImageType(buffer);
    if (!type) throw new HttpError(415, L("PNG · JPEG · WebP 이미지만 올릴 수 있습니다", "Only PNG, JPEG or WebP images are accepted"));
    const id = randomBytes(16).toString("hex");
    const name = `${id}.${type.ext}`;
    const filename = await this.comfy.uploadImage(buffer, name, type.mime, this.subfolder);
    const slash = filename.lastIndexOf("/");
    this.items.set(id, {
      filename,
      view: { filename: filename.slice(slash + 1), subfolder: slash >= 0 ? filename.slice(0, slash) : "", type: "input" },
      createdAt: Date.now(),
    });
    this.sweep();
    return id;
  }
}
