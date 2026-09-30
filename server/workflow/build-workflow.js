/**
 * 워크플로우 파라미터 동적 주입.
 *
 * 서버에 있는 템플릿과 *이미 검사를 마친* 파라미터를 받아, ComfyUI 에 보낼 API 형식 그래프를 만든다.
 * 브라우저는 그래프 구조를 절대 보내지 않는다 — 정해진 형식의 값만 보내고, 그 값은 여기서
 * 정해진 자리에만 들어간다.
 *
 * 순수 함수: 입력이 같으면 결과도 같다 → 테스트하기 쉽다.
 */

export const cloneWorkflow = (wf) => structuredClone(wf);

/** `rootId` 와 그 조상 노드만 남긴다 (더 이상 연결되지 않은 가지는 지운다). */
export function pruneToAncestors(wf, rootId) {
  const keep = new Set();
  const stack = [String(rootId)];
  while (stack.length) {
    const id = stack.pop();
    if (keep.has(id) || !wf[id]) continue;
    keep.add(id);
    for (const v of Object.values(wf[id].inputs || {})) {
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string") stack.push(v[0]);
    }
  }
  for (const id of Object.keys(wf)) if (!keep.has(id)) delete wf[id];
  return keep;
}

/** `[fromId, fromSlot]` 을 읽던 모든 입력을 `to` 로 바꿔 연결한다 (`skip` 에 있는 노드는 제외). */
function rewire(wf, fromId, fromSlot, to, skip = new Set()) {
  for (const [id, node] of Object.entries(wf)) {
    if (skip.has(id)) continue;
    for (const [key, v] of Object.entries(node.inputs || {})) {
      if (Array.isArray(v) && v[0] === fromId && v[1] === fromSlot) node.inputs[key] = [...to];
    }
  }
}

function setSampler(node, p, { seed, steps, denoise }) {
  Object.assign(node.inputs, {
    seed,
    steps,
    cfg: p.cfg,
    sampler_name: p.sampler,
    scheduler: p.scheduler,
    denoise,
  });
}

export function buildWorkflow(template, roles, p, options = {}) {
  const wf = cloneWorkflow(template);
  const r = roles;

  // 프롬프트
  wf[r.positive].inputs.text = p.prompt;
  wf[r.negative].inputs.text = p.negative;

  // 모델
  wf[r.checkpoint].inputs.ckpt_name = p.checkpoint;

  // 캔버스(크기·장수)
  Object.assign(wf[r.latent].inputs, { width: p.width, height: p.height, batch_size: p.batchSize });

  // 샘플러
  setSampler(wf[r.baseSampler], p, { seed: p.seed, steps: p.steps, denoise: 1 });
  const useHires = !!(p.hires && p.hires.enabled && r.hiresSampler && r.latentUpscale);
  if (useHires) {
    wf[r.latentUpscale].inputs.scale_by = p.hires.scale;
    setSampler(wf[r.hiresSampler], p, { seed: p.seed, steps: p.hires.steps, denoise: p.hires.denoise });
  } else if (r.hiresSampler) {
    // Hires 꺼짐: 기본 결과를 바로 디코딩하고, 안 쓰는 가지는 잘라 낸다.
    wf[r.decode].inputs.samples = [r.baseSampler, 0];
    pruneToAncestors(wf, r.save);
  }

  // 저장 위치는 서버가 정한다.
  wf[r.save].inputs.filename_prefix = p.filenamePrefix;

  // LoRA chain: CheckpointLoader → LoraLoader × N → (everything that used the checkpoint outputs)
  if (p.loras && p.loras.length) {
    const added = new Set();
    let model = [r.checkpoint, 0], clip = [r.checkpoint, 1];
    p.loras.forEach((lora, i) => {
      const id = `app_lora_${i + 1}`;
      wf[id] = {
        class_type: "LoraLoader",
        inputs: { model, clip, lora_name: lora.name, strength_model: lora.strength, strength_clip: lora.strength },
        _meta: { title: `LoRA ${i + 1}` },
      };
      added.add(id);
      model = [id, 0]; clip = [id, 1];
    });
    rewire(wf, r.checkpoint, 0, model, added);
    rewire(wf, r.checkpoint, 1, clip, added);
  }

  // 선택: ControlNet 참조 (포즈 뼈대 이미지, 또는 전처리한 사진)
  if (p.control && options.controlnetModel) {
    wf.app_cn_image = { class_type: "LoadImage", inputs: { image: p.control.image }, _meta: { title: "Reference Image" } };
    let imageRef = ["app_cn_image", 0];
    if (p.control.preprocess) {
      wf.app_cn_pre = {
        class_type: "OpenposePreprocessor",
        inputs: { detect_hand: "enable", detect_body: "enable", detect_face: "disable", resolution: 512, scale_stick_for_xinsr_cn: "disable", image: imageRef },
        _meta: { title: "OpenPose Preprocessor" },
      };
      imageRef = ["app_cn_pre", 0];
    }
    wf.app_cn_loader = { class_type: "ControlNetLoader", inputs: { control_net_name: options.controlnetModel }, _meta: { title: "ControlNet Model" } };
    wf.app_cn_apply = {
      class_type: "ControlNetApplyAdvanced",
      inputs: {
        positive: [r.positive, 0],
        negative: [r.negative, 0],
        control_net: ["app_cn_loader", 0],
        image: imageRef,
        strength: p.control.strength,
        start_percent: 0,
        end_percent: p.control.endPercent,
      },
      _meta: { title: "Apply ControlNet" },
    };
    for (const sid of [r.baseSampler, useHires ? r.hiresSampler : null].filter(Boolean)) {
      wf[sid].inputs.positive = ["app_cn_apply", 0];
      wf[sid].inputs.negative = ["app_cn_apply", 1];
    }
  }

  return wf;
}

/** 테스트용 점검: 모든 연결이 실제로 있는 노드를 가리켜야 한다. */
export function findDanglingLinks(wf) {
  const bad = [];
  for (const [id, node] of Object.entries(wf)) {
    for (const [key, v] of Object.entries(node.inputs || {})) {
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && !wf[v[0]]) bad.push(`${id}.${key} → ${v[0]}`);
    }
  }
  return bad;
}
