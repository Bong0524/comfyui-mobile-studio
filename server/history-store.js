/**
 * 최근 생성 결과 갤러리. 작은 JSON 파일(data/history.json)로 저장한다.
 *
 * 정보(설정값·파일 위치)만 저장하고 이미지는 ComfyUI 의 output 폴더에 그대로 둔다.
 * 이미지는 /api/images/작업ID/번호 로만 내보내므로, 브라우저는 파일 경로를 알거나 고를 수 없다.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export class HistoryStore {
  constructor({ dir, limit, logger }) {
    this.file = path.join(dir, "history.json");
    this.dir = dir;
    this.limit = limit;
    this.logger = logger;
    this.items = [];
    this.writing = Promise.resolve();
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (Array.isArray(data)) this.items = data.filter((x) => x && typeof x.id === "string" && Array.isArray(x.images)).slice(0, limit);
    } catch (err) {
      if (err.code !== "ENOENT") logger.warn("history.json 을 읽지 못해 빈 갤러리로 시작합니다:", err.message);
    }
  }

  list() { return this.items; }
  get(id) { return this.items.find((x) => x.id === id) || null; }

  add(entry) {
    if (this.limit === 0) return;
    this.items = [entry, ...this.items.filter((x) => x.id !== entry.id)].slice(0, this.limit);
    this.persist();
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((x) => x.id !== id);
    if (this.items.length !== before) this.persist();
  }

  /** 순서대로, 원자적으로 저장 (임시 파일에 쓰고 이름 바꾸기) — 도중에 죽어도 반쪽 파일이 남지 않는다. */
  persist() {
    const snapshot = JSON.stringify(this.items, null, 1);
    this.writing = this.writing.then(async () => {
      try {
        await fsp.mkdir(this.dir, { recursive: true });
        const tmp = `${this.file}.${process.pid}.tmp`;
        await fsp.writeFile(tmp, snapshot);
        await fsp.rename(tmp, this.file);
      } catch (err) { this.logger.warn("갤러리 기록을 저장하지 못했습니다:", err.message); }
    });
    return this.writing;
  }
}
