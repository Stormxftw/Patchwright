import { readFile } from 'node:fs/promises';
import path from 'node:path';

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

export async function buildCodexPrompt(rootDir, config, issue, runId, currentStatus) {
  const instructions = await readRepoInstructions(rootDir);

  return `You are Codex running inside ${rootDir} for the GitHub issue below.

Repository: ${config.repo}
Run id: ${runId}
Project status at claim time: ${currentStatus}
Issue: #${issue.number} ${issue.title}
Issue URL: ${issue.url}

Your job:
- Implement only this issue.
- Preserve unrelated user changes. Read git state before editing.
- Keep changes scoped and boring.
- Follow AGENTS.md exactly.
- If you touch dashboard data, onboarding copy, demo state, seed data, or any PLACEHOLDER-DATA surface, update docs/placeholder-data.md in the same change.
- Run the verification that matches the change. For TypeScript or React changes, run npm.cmd run build.
- Do not merge or close the issue. The daemon will open a draft PR after you finish.
- In your final response, summarize files changed, verification run, and any blockers.

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
