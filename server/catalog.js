/**
 * 화면에 보여 줄 수 있는 목록: 모델, LoRA, 샘플러, 크기, 프리셋.
 *
 * 모델 이름은 두 곳에서 오고, 둘 다에 있는 것만 공개한다:
 *   1. ComfyUI 에 실제로 설치된 것 (`/object_info`, 잠깐 캐시)
 *   2. 운영자가 config/models.json 에 적어 둔 허용 목록 (MODEL_LIST_MODE=allowlist)
 * 그래서 GPU PC 에 모델이 훨씬 많아도, 공개 데모에는 일부러 고른 모델만 드러난다.
 */
import fs from "node:fs";

const FALLBACK_SAMPLERS = ["euler", "euler_ancestral", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_sde", "ddim", "uni_pc"];
const FALLBACK_SCHEDULERS = ["normal", "karras", "exponential", "sgm_uniform", "simple", "beta"];

/** SDXL 에 맞는 화면비 프리셋 (모두 64의 배수). */
const SIZE_PRESETS = [
  { id: "square", label: "1:1", width: 1024, height: 1024 },
  { id: "portrait", label: "3:4", width: 896, height: 1152 },
  { id: "tall", label: "2:3", width: 832, height: 1216 },
  { id: "landscape", label: "4:3", width: 1152, height: 896 },
  { id: "wide", label: "3:2", width: 1216, height: 832 },
  { id: "cinema", label: "16:9", width: 1344, height: 768 },
  { id: "small", label: { ko: "빠름 768²", en: "Fast 768²" }, width: 768, height: 768 },
];

const baseName = (s) => String(s).split(/[\\/]/).pop().replace(/\.(safetensors|ckpt|pt|pth|bin)$/i, "");

function readJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (err) { if (err.code !== "ENOENT") throw new Error(`${file}: ${err.message}`); return fallback; }
}

export function loadBlockedTerms(file) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  return text.split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim().toLowerCase()).filter(Boolean);
}

/** 표시 문구를 문자열 또는 { ko, en } 객체로 정리한다. */
function text(v, fallback) {
  if (v && typeof v === "object" && (typeof v.ko === "string" || typeof v.en === "string")) return { ko: String(v.ko ?? v.en), en: String(v.en ?? v.ko) };
  return v == null || v === "" ? fallback : String(v);
}

function loadStylePresets(file) {
  const list = readJsonFile(file, []);
  if (!Array.isArray(list)) throw new Error(`${file}: expected an array`);
  const seen = new Set();
  return list.map((p) => {
    if (!p || typeof p.id !== "string" || !/^[a-z0-9-]{1,40}$/.test(p.id) || seen.has(p.id)) throw new Error(`${file}: invalid or duplicate preset id ${p && p.id}`);
    seen.add(p.id);
    return {
      id: p.id,
      // 표시 문구는 문자열이거나 { ko, en } — 화면이 현재 언어를 고른다.
      label: text(p.label, p.id),
      category: text(p.category, "general"),
      description: text(p.description, ""),
      positive: String(p.positive || ""),
      negative: String(p.negative || ""),
      recommended: p.recommended && typeof p.recommended === "object" ? p.recommended : {},
    };
  });
}

export class Catalog {
  constructor({ config, comfy, logger, template, roles }) {
    this.config = config;
    this.comfy = comfy;
    this.logger = logger;
    this.template = template;
    this.roles = roles;
    this.ttlMs = 60 * 1000;
    this.fetchedAt = 0;
    this.pending = null;
    this.online = false;

    const models = readJsonFile(config.modelsFile, null);
    if (!models && config.modelListMode === "allowlist") {
      logger.warn(`${config.modelsFile} 이 없어 워크플로우 기본 체크포인트만 허용합니다. config/models.example.json 을 config/models.json 으로 복사해 모델을 적어 주세요.`);
    }
    this.allow = {
      checkpoints: Array.isArray(models?.checkpoints) ? models.checkpoints.filter((m) => m && typeof m.name === "string") : [],
      loras: Array.isArray(models?.loras) ? models.loras.filter((m) => m && typeof m.name === "string") : [],
    };
    this.stylePresets = loadStylePresets(config.stylePresetsFile);
    this.promptTags = readJsonFile(config.promptTagsFile, []);
    this.blockedTerms = loadBlockedTerms(config.blockedTermsFile);

    this.installed = { checkpoints: [], loras: [], samplers: FALLBACK_SAMPLERS, schedulers: FALLBACK_SCHEDULERS, controlnet: false, preprocessor: false };
  }

  /** ComfyUI 에서 설치된 모델 목록을 새로 받는다 (TTL 동안 한 번만, 동시에 불러도 요청은 하나). */
  async refresh(force = false) {
    if (!force && Date.now() - this.fetchedAt < this.ttlMs) return;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        const c = this.comfy;
        const [checkpoints, loras, samplers, schedulers] = await Promise.all([
          c.listInputOptions("CheckpointLoaderSimple", "ckpt_name"),
          c.listInputOptions("LoraLoader", "lora_name"),
          c.listInputOptions("KSampler", "sampler_name"),
          c.listInputOptions("KSampler", "scheduler"),
        ]);
        let controlnet = false, preprocessor = false;
        if (this.config.controlnetModel) {
          const cns = await c.listInputOptions("ControlNetLoader", "control_net_name").catch(() => []);
          controlnet = cns.includes(this.config.controlnetModel);
          if (!controlnet) this.logger.warn(`CONTROLNET_MODEL "${this.config.controlnetModel}" 이 ComfyUI 에 없어 참조 이미지 기능을 끕니다`);
          if (controlnet && this.config.controlnetPreprocessor === "openpose") preprocessor = await c.hasNodeClass("OpenposePreprocessor");
        }
        this.installed = {
          checkpoints, loras,
          samplers: samplers.length ? samplers : FALLBACK_SAMPLERS,
          schedulers: schedulers.length ? schedulers : FALLBACK_SCHEDULERS,
          controlnet, preprocessor,
        };
        this.online = true;
        this.fetchedAt = Date.now();
      } catch (err) {
        this.online = false;
        this.logger.debug("catalog refresh failed:", err.message);
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }

  /** 사용자가 고를 수 있는 체크포인트 (허용 목록 ∩ 설치된 것). */
  get checkpoints() {
    const installed = new Set(this.installed.checkpoints);
    if (this.config.modelListMode === "all") return this.installed.checkpoints.map((name) => ({ name, label: baseName(name) }));
    const defaultName = this.template[this.roles.checkpoint].inputs.ckpt_name;
    const list = this.allow.checkpoints.length ? this.allow.checkpoints : [{ name: defaultName, label: baseName(defaultName), default: true }];
    return list.filter((m) => installed.has(m.name)).map((m) => ({ name: m.name, label: String(m.label || baseName(m.name)), default: !!m.default }));
  }

  get loras() {
    const installed = new Set(this.installed.loras);
    if (this.config.modelListMode === "all") return this.installed.loras.map((name) => ({ name, label: baseName(name), strength: 0.8 }));
    return this.allow.loras.filter((m) => installed.has(m.name)).map((m) => ({
      name: m.name,
      label: String(m.label || baseName(m.name)),
      strength: Number.isFinite(+m.strength) ? +m.strength : 0.8,
      triggerWords: typeof m.triggerWords === "string" ? m.triggerWords : "",
    }));
  }

  get sizes() {
    return SIZE_PRESETS.filter((s) => s.width * s.height <= this.config.limits.maxPixels);
  }

  get features() {
    return {
      hires: !!(this.roles.hiresSampler && this.roles.latentUpscale),
      controlnet: this.installed.controlnet,
      preprocessor: this.installed.preprocessor,
    };
  }

  defaults() {
    const base = this.template[this.roles.baseSampler].inputs;
    const hires = this.roles.hiresSampler ? this.template[this.roles.hiresSampler].inputs : null;
    const up = this.roles.latentUpscale ? this.template[this.roles.latentUpscale].inputs : null;
    const ckpts = this.checkpoints;
    return {
      checkpoint: (ckpts.find((c) => c.default) || ckpts[0] || {}).name || "",
      width: 1024, height: 1024, batchSize: 1,
      steps: Math.min(base.steps, this.config.limits.maxSteps),
      cfg: base.cfg,
      sampler: base.sampler_name,
      scheduler: base.scheduler,
      negativePrompt: "lowres, blurry, worst quality, low quality, jpeg artifacts, watermark, text, signature",
      hires: { enabled: false, scale: up ? up.scale_by : 1.5, steps: hires ? hires.steps : 12, denoise: hires ? hires.denoise : 0.45 },
      control: { strength: 0.8, endPercent: 0.6 },
    };
  }

  /** 브라우저가 입력 폼을 그리는 데 필요한 모든 것. */
  publicView() {
    return {
      online: this.online,
      checkpoints: this.checkpoints,
      loras: this.loras,
      samplers: this.installed.samplers,
      schedulers: this.installed.schedulers,
      sizes: this.sizes,
      stylePresets: this.stylePresets,
      promptTags: Array.isArray(this.promptTags) ? this.promptTags : [],
      features: this.features,
      limits: this.config.limits,
      defaults: this.defaults(),
    };
  }
}
