/**
 * 서버 상태 표시: 연결 중 → 온라인 / 오프라인, 생성 중에는 "생성 중".
 * /api/health 를 주기적으로 확인하고(오프라인일 때 더 자주), 탭이 숨겨지면 멈춘다
 * — 원본 앱의 연결 확인 방식과 같다.
 */
import { api } from "./api.js";
import { $ } from "./ui.js";
import { t } from "./i18n.js";

export function createStatusMonitor() {
  const pill = $("statusPill"), text = $("statusText");
  let online = null;          // null = 아직 모름
  let generating = false;
  let timer = null;
  const listeners = new Set();

  function paint() {
    const state = generating ? "generating" : online === null ? "connecting" : online ? "online" : "offline";
    pill.dataset.state = state;
    text.textContent = t(`status.${state}`);
    pill.title = state === "offline" ? t("status.offlineTitle") : "";
  }

  async function check() {
    clearTimeout(timer);
    let next;
    try {
      const h = await api.health();
      next = h.comfyui === "online";
    } catch {
      next = false;
    }
    if (next !== online) { online = next; listeners.forEach((fn) => fn(online)); }
    paint();
    if (!document.hidden) timer = setTimeout(check, online ? 15000 : 5000);
  }

  document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); else clearTimeout(timer); });
  window.addEventListener("online", check);
  paint();

  return {
    start: check,
    check,
    get online() { return online; },
    setGenerating(v) { generating = v; paint(); },
    onChange(fn) { listeners.add(fn); },
  };
}
