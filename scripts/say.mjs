#!/usr/bin/env node
/**
 * Windows 실행 파일(.bat)이 보여 주는 한글 안내 문구.
 *
 *   node scripts/say.mjs <키> [값]
 *
 * 왜 .bat 파일에 한글을 직접 쓰지 않나?
 *  - UTF-8 + `chcp 65001` 은 일부 환경에서 cmd.exe 가 줄을 잘못 읽는다.
 *  - CP949(ANSI)로 저장하면 한국어 Windows 에서는 되지만 GitHub 에서 글자가 깨져 보인다.
 * Node 는 Windows 콘솔에 유니코드로 출력하므로, 한글을 여기(UTF-8)에 두면 어디서나 제대로 보이고
 * .bat 파일은 영문(ASCII)으로 유지할 수 있다.
 */
const MESSAGES = {
  "old-node": (v) => `[!] Node.js 22 이상이 필요합니다. 현재 버전: ${v}\n    https://nodejs.org 에서 LTS 버전을 설치하세요.`,
  "first-run": () => "처음 실행입니다. .env 와 config\\models.json 을 만듭니다...",
  "review-env": () => "\n메모장으로 .env 를 엽니다. COMFYUI_DIR 등을 확인하고 저장한 뒤 메모장을 닫고,\n이 파일을 다시 실행하세요.",
  "no-token": () => "[!] .env 의 ACCESS_TOKEN 이 비어 있습니다. 8자 이상의 비밀번호를 넣어 주세요.",

  "comfy-running": () => "[완료] ComfyUI 가 이미 실행 중입니다.",
  "comfy-starting": (port) => `ComfyUI 를 127.0.0.1:${port} 로 시작합니다... (외부에는 공개되지 않습니다)`,
  "comfy-searching": () => "ComfyUI 가 꺼져 있습니다. .env 에 COMFYUI_DIR 이 없어 ComfyUI 포터블 폴더를 찾는 중...",
  "comfy-found": (dir) => `[완료] ComfyUI 폴더를 찾아 .env 에 저장했습니다:\n    ${dir}`,
  "no-comfy-dir": () => "[!] ComfyUI 포터블 폴더를 찾지 못했습니다.\n    .env 의 COMFYUI_DIR 에 폴더 경로를 적어 주세요. 예: COMFYUI_DIR=E:\\ComfyUI_windows_portable\n    지금 ComfyUI 를 직접 켜면 자동으로 이어서 진행합니다.",
  "bad-comfy-dir": (dir) => `[!] COMFYUI_DIR 이 ComfyUI 포터블 폴더가 아닌 것 같습니다:\n    ${dir}\n    폴더 안에 python_embeded\\python.exe 가 있어야 합니다.`,
  "comfy-waiting": () => "ComfyUI 응답을 기다리는 중 (최대 3분, 처음 켤 때는 모델 로딩으로 1~2분 걸릴 수 있습니다)",
  "comfy-up": () => "[완료] ComfyUI 가 준비되었습니다.",
  "comfy-down": () => "[!] ComfyUI 가 응답하지 않습니다. 앱은 그대로 켜지고 화면에 '오프라인'으로 표시됩니다.",

  "app-running": (port) => `[완료] 웹앱이 이미 ${port} 포트에서 실행 중입니다.`,
  "app-starting": () => "웹앱을 시작합니다...",
  "app-ok": (port) => `[완료] 웹앱: http://127.0.0.1:${port}`,
  "app-failed": () => "[!] 웹앱이 시작되지 않았습니다. 'app' 창에 표시된 오류 메시지를 확인하세요.",

  "tunnel-starting": () => "Cloudflare Tunnel 을 시작합니다...",
  "public-url": (domain) => `[완료] 외부 접속 주소: https://${domain}`,
  "no-tunnel": () => "[안내] CLOUDFLARE_TUNNEL_TOKEN 이 비어 있어 이 PC 에서만 접속됩니다 (외부 주소 없음).",
  "running": () => [
    "",
    "============================================================",
    "  실행 중입니다. .env 의 ACCESS_TOKEN 으로 로그인하세요.",
    "  종료: app / tunnel / ComfyUI 창을 닫으면 됩니다.",
    "============================================================",
    "",
  ].join("\n"),

  "app-only": () => "웹앱만 시작합니다. (ComfyUI 는 이미 켜져 있어야 합니다 — 한 번에 켜려면 start-demo.bat)",
  "tests-failed": () => "\n[!] 실패한 테스트가 있습니다. 위의 메시지를 확인하세요.",
  "tests-passed": () => "\n[완료] 모든 테스트를 통과했습니다.",
};

const [key, ...args] = process.argv.slice(2);
const msg = MESSAGES[key];
console.log(msg ? msg(...args) : key || "");
