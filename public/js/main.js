/**
 * 앱 시작점: 로그인 상태 확인 → 로그인 화면 또는 앱 화면, 그다음 각 모듈을 연결한다.
 */
import { api, onUnauthorized } from "./api.js";
import { $, toast } from "./ui.js";
import { t, pick, getLang, setLang, applyStatic } from "./i18n.js";
import { createStatusMonitor } from "./status.js";
import { createForm } from "./form.js";
import { createReference } from "./reference.js";
import { createGenerator } from "./generate.js";
import { createGallery } from "./gallery.js";

applyStatic();   // HTML 기본 문구(한국어)를 저장된 언어로 맞춘다
const status = createStatusMonitor();
let started = false;
let generator = null;

/* ── 언어 전환 (한국어 ↔ English) ──
   화면 곳곳의 문구가 서버 데이터와 섞여 있어서, 바꿀 때는 새로고침으로 다시 그린다.
   입력 중이던 설정은 브라우저에 저장돼 있으므로 그대로 돌아온다. */
$("langBtn").addEventListener("click", () => {
  if (generator && generator.running) { toast(t("lang.waitGenerate")); return; }
  setLang(getLang() === "ko" ? "en" : "ko");
  location.reload();
});

/* ── 모바일 탭 (만들기 / 결과 / 갤러리). 넓은 화면에서는 모든 패널이 함께 보인다 ── */
function selectTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => {
    const on = tab.dataset.tab === name;
    tab.classList.toggle("on", on);
    tab.setAttribute("aria-selected", String(on));
  });
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.dataset.panel === name));
  if (name === "result") $("resultBadge").hidden = true;
  window.scrollTo({ top: 0 });
}
document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => selectTab(tab.dataset.tab)));
const isNarrow = () => window.matchMedia("(max-width: 959px)").matches;

/* ── 로그인 / 로그아웃 ── */
function showLogin(message = "") {
  $("appView").hidden = true;
  $("logoutBtn").hidden = true;
  $("loginView").hidden = false;
  $("loginError").textContent = message;
  $("tokenInput").focus();
}

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("loginBtn");
  btn.disabled = true;
  $("loginError").textContent = "";
  try {
    await api.login($("tokenInput").value);
    $("tokenInput").value = "";
    await startApp();
  } catch (err) {
    $("loginError").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$("logoutBtn").addEventListener("click", async () => {
  try { await api.logout(); } catch { /* 무시 */ }
  location.reload();
});

onUnauthorized(() => { if (started) { started = false; showLogin(t("login.expired")); } });

/* ── 앱 화면 ── */
async function startApp() {
  $("loginView").hidden = true;
  $("appView").hidden = false;
  $("logoutBtn").hidden = false;
  selectTab("create");

  let catalog;
  try {
    catalog = await api.catalog();
  } catch (err) {
    if (err.status === 401) return;
    toast(t("catalog.error", { msg: err.message }), { error: true });
    setTimeout(startApp, 5000);   // 서버가 아직 준비 중일 수 있으니 잠시 뒤 다시 시도
    return;
  }
  if (started) return;
  started = true;

  const reference = createReference(catalog);
  const form = createForm(catalog, { getControl: () => reference.get() });
  const gallery = createGallery({
    presetLabel: (id) => pick((catalog.stylePresets.find((p) => p.id === id) || { label: id }).label),
    onReuse: (req) => { form.applyRequest(req); selectTab("create"); toast(t("viewer.reused")); },
  });
  generator = createGenerator({
    status,
    onStart: () => { if (isNarrow()) selectTab("result"); },
    onFinished: (job, error) => {
      if (job) {
        form.setLastSeed(job.request.seed);
        gallery.refresh();
        if (isNarrow() && !document.querySelector('.panel[data-panel="result"].active')) $("resultBadge").hidden = false;
      } else if (error && /expired|만료/i.test(error)) {
        reference.clear();   // 서버에서 참조 이미지가 만료됨 → 다시 올리도록 비운다
      }
    },
    onOpenImage: (job, i) => gallery.open(job, i),
  });

  $("generateBtn").addEventListener("click", () => {
    let body;
    try { body = form.collect(); }
    catch (err) { toast(err.message, { error: true }); return; }
    generator.start(body);
  });

  // 프롬프트 칸에서 Ctrl/Cmd + Enter 로 바로 생성 (데스크톱 편의 기능)
  $("promptInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $("generateBtn").click(); }
  });

  // 모델 목록은 ComfyUI 에서 온다. 오프라인이던 서버가 다시 켜지면 목록을 새로 받도록 한 번 새로고침한다.
  status.onChange((online) => {
    if (!online || catalog.online || generator.running) return;
    let last = 0;
    try { last = Number(sessionStorage.getItem("cms.reloadedAt")) || 0; sessionStorage.setItem("cms.reloadedAt", String(Date.now())); } catch { /* 무시 */ }
    if (Date.now() - last > 60000) location.reload();   // 1분 안에 두 번 새로고침하지 않는다
  });

  gallery.refresh();
}

/* ── 시작 ── */
(async () => {
  status.start();
  try {
    const s = await api.session();
    if (s.authenticated) await startApp();
    else showLogin();
  } catch (err) {
    showLogin(err.message);
  }
})();
