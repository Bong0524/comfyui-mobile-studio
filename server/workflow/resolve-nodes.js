/**
 * API 형식 워크플로우에서 노드를 고정 번호가 아니라 *역할* 로 찾는다.
 *
 * 원본 앱의 워크플로우 자동 탐지(workflow-detect) 아이디어를 옮겨 왔다:
 * ComfyUI 에서 워크플로우를 고칠 때마다 노드 번호가 바뀌므로, 필요한 부분을 그래프 연결로 찾는다.
 *
 *   SaveImage  ← VAEDecode ← 마지막 KSampler
 *   마지막 KSampler.latent_image ← LatentUpscale* ← 기본 KSampler   (Hires 단계가 있을 때)
 *   기본 KSampler.latent_image  ← EmptyLatentImage
 *   기본 KSampler.positive/negative ← CLIPTextEncode
 *   기본 KSampler.model → (위로 거슬러 올라가며) → CheckpointLoaderSimple
 *
 * 순수 함수(입출력 없음) — 테스트와 `npm run workflow:check` 에서 그대로 돈다.
 */

const isLink = (wf, v) => Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && !!wf[v[0]];

export function resolveWorkflowRoles(wf) {
  const ids = Object.keys(wf || {});
  const cls = (id) => wf[id]?.class_type || "";
  const input = (id, key) => wf[id]?.inputs?.[key];
  const source = (id, key) => (isLink(wf, input(id, key)) ? input(id, key)[0] : null);
  const problems = [];

  const saves = ids.filter((id) => cls(id) === "SaveImage");
  if (saves.length !== 1) problems.push(`SaveImage 노드가 정확히 1개 있어야 합니다 (현재 ${saves.length}개)`);
  const save = saves[0] || null;

  const decode = save ? source(save, "images") : null;
  if (!decode || cls(decode) !== "VAEDecode") problems.push("SaveImage.images 는 VAEDecode 노드에서 와야 합니다");

  const finalSampler = decode ? source(decode, "samples") : null;
  if (!finalSampler || cls(finalSampler) !== "KSampler") problems.push("VAEDecode.samples 는 KSampler 에서 와야 합니다");

  // 선택: Hires 단계 — 마지막 샘플러가 다른 샘플러 결과를 확대한 latent 를 읽는 구조
  let baseSampler = finalSampler, hiresSampler = null, latentUpscale = null;
  if (finalSampler) {
    const lat = source(finalSampler, "latent_image");
    if (lat && /^LatentUpscale/.test(cls(lat))) {
      const prev = source(lat, "samples");
      if (prev && cls(prev) === "KSampler") { latentUpscale = lat; hiresSampler = finalSampler; baseSampler = prev; }
    }
  }

  const latent = baseSampler ? source(baseSampler, "latent_image") : null;
  if (!latent || cls(latent) !== "EmptyLatentImage") problems.push("기본 KSampler.latent_image 는 EmptyLatentImage 에서 와야 합니다");

  const positive = baseSampler ? source(baseSampler, "positive") : null;
  const negative = baseSampler ? source(baseSampler, "negative") : null;
  if (!positive || cls(positive) !== "CLIPTextEncode") problems.push("기본 KSampler.positive 는 CLIPTextEncode 여야 합니다");
  if (!negative || cls(negative) !== "CLIPTextEncode") problems.push("기본 KSampler.negative 는 CLIPTextEncode 여야 합니다");
  if (positive && positive === negative) problems.push("긍정/부정 프롬프트가 같은 노드를 쓰고 있습니다");

  // Walk the model input upstream until the checkpoint loader (skips model patches, LoRA loaders, …).
  let checkpoint = null;
  for (let id = baseSampler ? source(baseSampler, "model") : null, guard = 0; id && guard < 50; guard++) {
    if (cls(id) === "CheckpointLoaderSimple") { checkpoint = id; break; }
    id = source(id, "model");
  }
  if (!checkpoint) problems.push("샘플러 앞쪽에서 CheckpointLoaderSimple 을 찾지 못했습니다");

  return {
    ok: problems.length === 0,
    problems,
    roles: { save, decode, baseSampler, hiresSampler, latentUpscale, latent, positive, negative, checkpoint },
  };
}

/** 시작할 때 쓰는 버전: 다룰 수 없는 워크플로우면 서버가 아예 시작하지 않는다. */
export function requireWorkflowRoles(wf, file = "workflow") {
  const r = resolveWorkflowRoles(wf);
  if (!r.ok) throw new Error(`${file}: 지원하지 않는 워크플로우 — ${r.problems.join("; ")}`);
  return r.roles;
}
