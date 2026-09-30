/**
 * ComfyUI 와 계속 연결해 두는 WebSocket 하나.
 *
 * ComfyUI 는 작업을 넣은 client id 로 실행 이벤트(`execution_start`, `progress`, `executing`,
 * `executed`, `execution_error` …)와 미리보기 이미지(바이너리)를 보낸다. 그 client id 는 서버가
 * 가지고 있으므로 브라우저는 ComfyUI 와 직접 통신하지 않고, 서버가 걸러 낸 내용을 SSE 로 받는다.
 *
 * 연결이 끊기면 간격을 늘려 가며 다시 연결한다. job-manager 가 /history 도 따로 확인하므로
 * "완료" 메시지 하나를 놓쳐도 작업이 영원히 멈춰 있지 않는다.
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export class ComfyMonitor extends EventEmitter {
  constructor({ wsUrl, logger }) {
    super();
    this.wsUrl = wsUrl;
    this.logger = logger;
    this.clientId = randomUUID();
    this.connected = false;
    this.ws = null;
    this.retryMs = 1000;
    this.timer = null;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.ws) { try { this.ws.close(); } catch { /* 이미 닫힘 */ } }
  }

  connect() {
    if (this.stopped) return;
    const url = `${this.wsUrl}${this.wsUrl.includes("?") ? "&" : "?"}clientId=${this.clientId}`;
    let ws;
    try { ws = new WebSocket(url); } catch (err) { this.scheduleReconnect(err); return; }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.connected = true;
      this.retryMs = 1000;
      this.logger.info("ComfyUI WebSocket 연결됨");
      this.emit("connection", true);
    });
    ws.addEventListener("message", (event) => this.onMessage(event.data));
    ws.addEventListener("close", () => {
      const was = this.connected;
      this.connected = false;
      if (was) { this.logger.warn("ComfyUI WebSocket 연결 끊김 — 다시 연결합니다"); this.emit("connection", false); }
      this.scheduleReconnect();
    });
    ws.addEventListener("error", () => { /* 곧 "close" 가 오고 거기서 다시 연결한다 */ });
  }

  scheduleReconnect() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), this.retryMs);
    this.timer.unref?.();
    this.retryMs = Math.min(this.retryMs * 2, 15000);
  }

  onMessage(data) {
    if (data instanceof ArrayBuffer) {
      // 바이너리 프레임: [uint32 이벤트 종류][uint32 이미지 형식][이미지 바이트]. 종류 1 = 미리보기 이미지
      const buf = Buffer.from(data);
      if (buf.length > 8 && buf.readUInt32BE(0) === 1) {
        const mime = buf.readUInt32BE(4) === 2 ? "image/png" : "image/jpeg";
        this.emit("preview", { mime, bytes: buf.subarray(8) });
      }
      return;
    }
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg && typeof msg.type === "string") this.emit("event", msg);
  }
}
