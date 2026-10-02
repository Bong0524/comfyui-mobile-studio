# 변경 이력 (Changelog)

**한국어** | [English](CHANGELOG.en.md)

이 프로젝트의 주요 변경 사항을 버전별로 적습니다. 버전 번호는 [유의적 버전](https://semver.org/lang/ko/)을 따릅니다.

## [1.2.0] — 2026-10-03

원본 앱의 한/영 태그 사전 기능을 옮겼습니다.

### 추가
- **태그 자동완성** — 프롬프트 · 네거티브 입력칸에서 영어 태그, 한국어 별칭(`긴 머리` → `long hair`), 초성(`ㄱㅁㄹ`)으로 찾기. ↑↓ 이동, Enter · Tab 선택, Esc 닫기, 한글 조합 중에는 키를 가로채지 않음. 이미 있는 태그는 넣지 않고 알려 줌.
- **프롬프트 칩** — 입력한 프롬프트를 태그 칩으로 보여 주고 한국어 이름을 함께 표시. 칩을 눌러 강조(가중치 `(태그:1.2)`) 조절, 순서 이동, 삭제, 사전에서 보기.
- **사전 탐색** — 분류 트리(예: 외형 › 머리카락 › 머리 길이)와 검색으로 태그를 찾아 프롬프트 · 네거티브에 넣거나 빼기. 분류마다 많이 쓰는 태그를 먼저 보여 줌.
- **태그 사전 데이터** `public/data/tag-dict.json` — 원본 앱의 한/영 사전에서 분류 · 한국어 별칭 · 설명이 모두 갖춰진 일반 태그 10,100개, 분류 노드 745개.
- 정적 파일 gzip 전송(사전 1.4MB → 약 0.55MB).
- 테스트 추가: 사전 완전성, 검색 순위 · 초성, 프롬프트 토큰 처리.

### 변경
- 프롬프트 입력칸 안내 문구를 한국어 입력이 가능하다는 내용으로 바꿈.

## [1.1.0] — 2026-10-02

### 추가
- **포트폴리오 전용 모델 폴더.** ComfyUI 모델 폴더 안의 `checkpoints/portfolio/`, `loras/portfolio/`에 넣은 모델만 앱에 공개합니다. 같은 ComfyUI에 다른 모델이 많이 설치돼 있어도 데모 화면에는 일부러 골라 넣은 모델만 보입니다.
- 새 설정 `MODEL_FOLDER`(기본 `portfolio`) — 전용 폴더 이름을 바꿀 수 있습니다. 상위 경로(`..`) 같은 잘못된 이름은 시작할 때 거부합니다.
- `models.bat` / `npm run models`가 현재 공개 방식과, 앱에 실제로 보이는 모델(✓)을 함께 보여 줍니다.
- 모델 공개 규칙 테스트 5개 추가 (전체 32개).
- 이 변경 이력 문서(한국어 / 영어).

### 변경
- `MODEL_LIST_MODE` 기본값을 `allowlist` → **`folder`** 로 바꿨습니다.
  - `folder`: 전용 폴더 안의 모델 + `config/models.json`에 적은 모델
  - `allowlist`: `config/models.json`에 적은 모델만 (이전 기본 동작)
  - `all`: 설치된 모든 모델 (개인용)
- `config/models.json`은 이제 **선택 사항**입니다. folder 모드에서는 표시 이름 · 기본 모델 · LoRA 강도 · 트리거 단어만 덧붙이는 용도입니다.
- 표시 이름이 없으면 하위 폴더와 확장자를 뺀 파일 이름을 씁니다.
- README · 구조 문서 · `.env.example`의 모델 설치 안내를 새 폴더 구조에 맞게 고쳤습니다.

### 업그레이드 방법
- 기존 `.env`에 `MODEL_LIST_MODE=allowlist`가 있으면 이전처럼 동작합니다. 새 방식을 쓰려면 `MODEL_LIST_MODE=folder`, `MODEL_FOLDER=portfolio`로 바꾸고 모델을 전용 폴더에 넣은 뒤 ComfyUI를 다시 켜세요.

## [1.0.0] — 2026-09-30

개인용 모바일 ComfyUI 클라이언트를 바탕으로 만든 첫 공개(포트폴리오) 버전입니다.

### 추가
- **구조:** 브라우저 → 웹 UI → Node.js 앱/API 계층 → ComfyUI HTTP/WebSocket → 로컬 GPU. 브라우저는 ComfyUI와 직접 통신하지 않습니다.
- **생성 기능:** 프롬프트 / 네거티브, 스타일 프리셋 9종, 프롬프트 도우미 키워드, 체크포인트 · 여러 LoRA(개별 강도), 크기 · 시드 · 스텝 · CFG · 샘플러 · 스케줄러, Hires 보정, 포즈 · 참조 이미지(ControlNet, 선택).
- **실시간 진행 상황:** ComfyUI WebSocket → SSE로 단계 이름 · 스텝 진행률 · 미리보기 전달, 연결이 끊기면 폴링으로 대체, 대기열 순번 표시, 생성 취소.
- **갤러리:** 최근 결과, 다운로드, 생성 설정 상세 보기.
- **보안 경계:** 접속 비밀번호 + HMAC 서명 HttpOnly 세션 쿠키, Origin 검사(CSRF), 요청 횟수 제한, 엄격한 CSP, 클라이언트가 보낸 워크플로우 JSON은 받지 않고 서버가 검증한 값만 주입, 파일 이름이 되는 값은 허용 목록으로 제한, 금지어 검사.
- **안정성:** 단일 GPU 작업 대기열, 무응답 시간 제한 + 작업당 최대 시간, `/history` 확인으로 WebSocket 누락 보완.
- **원격 접속:** Cloudflare Tunnel(포트포워딩 없음, HTTPS, ComfyUI 비공개), 토큰은 환경 변수로만 전달.
- **Windows 실행 파일:** `start-demo.bat`(ComfyUI · 앱 · 터널 · 브라우저 한 번에), `start.bat`, `test.bat`, `models.bat`. 첫 실행 시 `.env` 자동 생성, ComfyUI 폴더 자동 찾기.
- **다국어:** 화면 한국어 기본 + 영어 전환, 서버 메시지도 요청 언어에 맞춤. README · 구조 문서 한국어 기본 + 영어 버전.
- **개발 도구:** 의존성 없는 Node.js 22, 가짜 ComfyUI(GPU 없이 개발 · 테스트), 단위 + 통합 테스트, GitHub Actions CI.

[1.2.0]: https://github.com/Bong0524/comfyui-mobile-studio/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Bong0524/comfyui-mobile-studio/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Bong0524/comfyui-mobile-studio/releases/tag/v1.0.0
