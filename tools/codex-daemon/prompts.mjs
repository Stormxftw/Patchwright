import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { formatTaskPacket } from './packet.mjs';

export function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function branchName(config, issue) {
  return `${config.branchPrefix}issue-${issue.number}-${slugify(issue.title)}`;
}

export async function readRepoInstructions(rootDir) {
  const agentsPath = path.join(rootDir, 'AGENTS.md');
  const placeholderPath = path.join(rootDir, 'docs', 'placeholder-data.md');
  const productLockPath = path.join(rootDir, 'docs', 'v1-product-lock.md');

  const [agents, placeholder, productLock] = await Promise.all([
    readFile(agentsPath, 'utf8').catch(() => ''),
    readFile(placeholderPath, 'utf8').catch(() => ''),
    readFile(productLockPath, 'utf8').catch(() => '')
  ]);

  return { agents, placeholder, productLock };
}

export async function buildCodexPrompt(rootDir, config, issue, runId, currentStatus, packet) {
  const instructions = await readRepoInstructions(rootDir);
  const role = packet?.role ?? 'fixer';
  const explorerSummary = packet?.explorerSummary
    ? `\n<explorer_summary>\n${packet.explorerSummary}\n</explorer_summary>\n`
    : '';
  const roleInstructions = role === 'explorer'
    ? `- First localize the work before editing. Read only the files needed to identify the smallest safe writable scope.
- Make no code changes. This pass is read-only localization for a later fixer.
- In your final response, include suspected files, allowed write scope, verification commands, and any blockers.`
    : `- Implement only this issue.
- Keep changes inside the packet scope and allowed paths when provided.
- In your final response, summarize files changed, verification run, and any blockers.`;

  return `You are Codex running inside ${rootDir} for the GitHub issue below.

Repository: ${config.repo}
Run id: ${runId}
Project status at claim time: ${currentStatus}
Worker role: ${role}
Issue: #${issue.number} ${issue.title}
Issue URL: ${issue.url}

Your job:
${roleInstructions}
- Preserve unrelated user changes. Read git state before editing.
- Keep changes scoped and boring.
- Follow AGENTS.md exactly.
- If you touch dashboard data, onboarding copy, demo state, seed data, or any PLACEHOLDER-DATA surface, update docs/placeholder-data.md in the same change.
- Run the validation commands listed in the task packet when they apply. For TypeScript or React changes without packet commands, run npm.cmd run build.
- Do not merge or close the issue. The daemon will open a draft PR after you finish.

<task_packet_json>
${packet ? formatTaskPacket(packet) : '{}'}
</task_packet_json>
${explorerSummary}

<issue_body>
${issue.body || '(No issue body provided.)'}
</issue_body>

<repo_instructions_AGENTS.md>
${instructions.agents}
</repo_instructions_AGENTS.md>

<product_lock_docs_v1_product_lock.md>
${instructions.productLock}
</product_lock_docs_v1_product_lock.md>

<placeholder_inventory_docs_placeholder_data.md>
${instructions.placeholder}
</placeholder_inventory_docs_placeholder_data.md>
`;
}
