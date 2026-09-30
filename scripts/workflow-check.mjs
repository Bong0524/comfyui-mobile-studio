#!/usr/bin/env node
/**
 * 워크플로우(API 형식)를 이 앱이 다룰 수 있는지 확인하고, 어떤 노드가 어떤 역할인지 보여 준다.
 *
 *   npm run workflow:check                       # 설정된 WORKFLOW_FILE
 *   node scripts/workflow-check.mjs my.api.json  # 다른 파일
 *
 * ComfyUI 에서 "Workflow → Export (API)" 로 내보낸 파일을 쓴다.
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR, loadEnvFile } from "../server/config.js";
import { resolveWorkflowRoles } from "../server/workflow/resolve-nodes.js";

loadEnvFile();
const file = path.resolve(process.argv[2] || process.env.WORKFLOW_FILE || path.join(ROOT_DIR, "workflows/txt2img.api.json"));
const wf = JSON.parse(fs.readFileSync(file, "utf8"));
const { ok, problems, roles } = resolveWorkflowRoles(wf);

console.log(`워크플로우: ${file}  (노드 ${Object.keys(wf).length}개)\n`);
for (const [role, id] of Object.entries(roles)) {
  const node = id ? wf[id] : null;
  console.log(`  ${role.padEnd(14)} ${id ? `#${id}`.padEnd(6) : "—".padEnd(6)} ${node ? `${node.class_type}${node._meta?.title ? `  "${node._meta.title}"` : ""}` : ""}`);
}
if (!ok) {
  console.error(`\n✗ 지원하지 않는 워크플로우:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
console.log(`\n✓ 사용 가능${roles.hiresSampler ? " (Hires 단계 있음)" : " (Hires 단계 없음)"}`);
