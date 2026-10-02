# Changelog

[한국어](CHANGELOG.md) | **English**

Notable changes to this project, by version. Versions follow [Semantic Versioning](https://semver.org/).

## [1.2.0] — 2026-10-03

Ports the Korean–English tag dictionary features of the original app.

### Added
- **Tag autocomplete** in the prompt and negative prompt fields — search by English tag, Korean alias (`긴 머리` → `long hair`) or Korean initials (`ㄱㅁㄹ`). ↑↓ to move, Enter / Tab to pick, Esc to close; keys are left alone while a Korean syllable is being composed. Duplicates are reported instead of inserted.
- **Prompt chips** — the prompt shown as tag chips with Korean names. Tap a chip to change its emphasis (weight `(tag:1.2)`), move it, remove it or show it in the dictionary.
- **Dictionary browser** — find tags through the category tree (e.g. Appearance › Hair › Hair Length) or search, and add/remove them in the prompt or negative prompt. Each category shows its most used tags first.
- **Tag dictionary data** `public/data/tag-dict.json` — 10,100 general tags from the original app's Korean–English dictionary, each with a category, Korean aliases and a description; 745 category nodes.
- Gzip for static files (dictionary 1.4 MB → about 0.55 MB).
- New tests: dictionary completeness, search ranking / Korean initials, prompt token handling.

### Changed
- The prompt placeholder now mentions that Korean input works.

## [1.1.0] — 2026-10-02

### Added
- **Dedicated portfolio model folder.** Only models placed in `checkpoints/portfolio/` and `loras/portfolio/` inside the ComfyUI model folder are published. Other models installed in the same ComfyUI never show up in the demo.
- New setting `MODEL_FOLDER` (default `portfolio`) to rename that folder. Invalid names such as parent paths (`..`) are rejected at startup.
- `models.bat` / `npm run models` now shows the active publishing mode and marks the models the app actually shows (✓).
- Five tests for the model publishing rules (32 in total).
- This changelog (Korean / English).

### Changed
- `MODEL_LIST_MODE` now defaults to **`folder`** (was `allowlist`).
  - `folder`: models in the dedicated folder + models listed in `config/models.json`
  - `allowlist`: only models listed in `config/models.json` (previous default)
  - `all`: every installed model (personal use)
- `config/models.json` is now **optional**. In folder mode it only adds display names, the default model, LoRA strength and trigger words.
- Without a display name, the file name (without sub-folder and extension) is used.
- Model setup instructions in the READMEs, architecture docs and `.env.example` updated for the new folder layout.

### Upgrading
- An existing `.env` with `MODEL_LIST_MODE=allowlist` keeps the old behavior. To switch, set `MODEL_LIST_MODE=folder` and `MODEL_FOLDER=portfolio`, move the demo models into the dedicated folders and restart ComfyUI.

## [1.0.0] — 2026-09-30

First public (portfolio) release, built from a personal mobile ComfyUI client.

### Added
- **Architecture:** browser → web UI → Node.js app/API layer → ComfyUI HTTP/WebSocket → local GPU. The browser never talks to ComfyUI.
- **Generation:** prompt / negative prompt, 9 style presets, prompt helper keywords, checkpoint and multiple LoRAs with per-LoRA strength, size · seed · steps · CFG · sampler · scheduler, hires fix, pose / reference image (ControlNet, optional).
- **Live progress:** ComfyUI WebSocket → SSE with stage names, step progress and previews; polling fallback; queue position; cancel.
- **Gallery:** recent results, download, generation details.
- **Security boundary:** access password + HMAC-signed HttpOnly session cookie, Origin check (CSRF), rate limiting, strict CSP, no client-supplied workflow JSON (the server injects validated values only), allowlists for anything that becomes a file name, blocked-term check.
- **Reliability:** single-GPU job queue, inactivity timeout + per-job ceiling, `/history` polling as a safety net for missed WebSocket events.
- **Remote access:** Cloudflare Tunnel (no port forwarding, HTTPS, ComfyUI never exposed); the token is passed only via the environment.
- **Windows launchers:** `start-demo.bat` (ComfyUI · app · tunnel · browser in one go), `start.bat`, `test.bat`, `models.bat`; `.env` created on first run, ComfyUI folder auto-detected.
- **i18n:** Korean UI by default with an English toggle; server messages follow the request language. Korean README / architecture docs by default, English versions alongside.
- **Tooling:** dependency-free Node.js 22, mock ComfyUI for GPU-less development and tests, unit + integration tests, GitHub Actions CI.

[1.2.0]: https://github.com/Bong0524/comfyui-mobile-studio/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Bong0524/comfyui-mobile-studio/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Bong0524/comfyui-mobile-studio/releases/tag/v1.0.0
