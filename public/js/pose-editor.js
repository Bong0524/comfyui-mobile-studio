/**
 * OpenPose 뼈대 에디터 (COCO 관절 18개) — 원본 앱의 포즈 에디터를 옮겨 왔다.
 * 512×768 캔버스에서 관절을 끌어 포즈를 만들고, 결과를 PNG 뼈대 이미지로 내보낸다.
 * 이 이미지는 ControlNet(OpenPose 모델)이 전처리 없이 바로 쓴다.
 */
const W = 512, H = 768;
// 관절·팔다리 색은 OpenPose 표준 색상표를 따른다 (ControlNet 이 이 색으로 부위를 구분한다)
const COLORS = [[255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0], [0, 255, 0], [0, 255, 85], [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85]];
const LIMBS = [[1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7], [1, 8], [8, 9], [9, 10], [1, 11], [11, 12], [12, 13], [1, 0], [0, 14], [14, 16], [0, 15], [15, 17]];
// 기본 자세: 정면으로 선 사람 (캔버스 크기 대비 비율 좌표)
const DEFAULT_POSE = [[0.5, 0.12], [0.5, 0.20], [0.42, 0.22], [0.38, 0.34], [0.36, 0.46], [0.58, 0.22], [0.62, 0.34], [0.64, 0.46], [0.45, 0.50], [0.44, 0.68], [0.44, 0.86], [0.55, 0.50], [0.56, 0.68], [0.56, 0.86], [0.47, 0.105], [0.53, 0.105], [0.44, 0.115], [0.56, 0.115]];

export function createPoseEditor({ dialog, canvas, resetBtn, flipBtn, cancelBtn, applyBtn, onApply }) {
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  let pts = DEFAULT_POSE.map(([x, y]) => [x * W, y * H]);
  let drag = -1;

  const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
  function render() {
    if (!ctx) return;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(4, W * 0.014);
    LIMBS.forEach(([a, b], i) => {
      ctx.strokeStyle = rgb(COLORS[i % COLORS.length]);
      ctx.beginPath(); ctx.moveTo(...pts[a]); ctx.lineTo(...pts[b]); ctx.stroke();
    });
    pts.forEach((p, j) => {
      ctx.fillStyle = rgb(COLORS[j % COLORS.length]);
      ctx.beginPath(); ctx.arc(p[0], p[1], Math.max(4, W * 0.013), 0, Math.PI * 2); ctx.fill();
    });
  }

  /** 화면 좌표 → 캔버스 좌표 (캔버스가 화면에 맞게 줄어들어 있어도 정확하게) */
  function toCanvas(e) {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  }
  canvas.addEventListener("pointerdown", (e) => {
    const p = toCanvas(e);
    let best = -1, bestD = Infinity;
    // 누른 곳에서 가장 가까운 관절을 잡는다 (손가락으로도 잡기 쉽게 반경을 넉넉히)
    pts.forEach((q, j) => { const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2; if (d < bestD) { bestD = d; best = j; } });
    const R = W * 0.07;
    if (bestD <= R * R) { drag = best; canvas.setPointerCapture(e.pointerId); e.preventDefault(); }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (drag < 0) return;
    const p = toCanvas(e);
    pts[drag] = [Math.max(0, Math.min(W, p[0])), Math.max(0, Math.min(H, p[1]))];
    render();
  });
  const end = () => { drag = -1; };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  resetBtn.addEventListener("click", () => { pts = DEFAULT_POSE.map(([x, y]) => [x * W, y * H]); render(); });
  flipBtn.addEventListener("click", () => { pts = pts.map(([x, y]) => [W - x, y]); render(); });   // 좌우 반전
  cancelBtn.addEventListener("click", () => dialog.close());
  applyBtn.addEventListener("click", () => {
    canvas.toBlob((blob) => { if (blob) { dialog.close(); onApply(blob); } }, "image/png");
  });

  return {
    open() { render(); dialog.showModal(); },
  };
}
