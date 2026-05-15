import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { redact } from './state.mjs';

const execFileAsync = promisify(execFile);

export class CommandError extends Error {
  constructor(message, result) {
    super(message);
    this.name = 'CommandError';
    this.result = result;
  }
}

export async function runCommand(command, args, options = {}) {
  const result = {
    command,
    args,
    cwd: options.cwd,
    stdout: '',
    stderr: '',
    exitCode: 0
  };

  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      maxBuffer: options.maxBuffer ?? 1024 * 1024 * 20,
      env: {
        ...process.env,
        ...options.env
      }
    });
    result.stdout = stdout;
    result.stderr = stderr;
    return result;
  } catch (error) {
    result.stdout = error.stdout ?? '';
    result.stderr = error.stderr ?? error.message;
    result.exitCode = error.code ?? 1;
    throw new CommandError(
      `${command} ${args.join(' ')} failed: ${redact(result.stderr || result.stdout)}`,
      result
    );
  }
}

export async function runJson(command, args, options = {}) {
  const result = await runCommand(command, args, options);
  try {
    return JSON.parse(result.stdout || '{}');
  } catch (error) {
    throw new CommandError(`Could not parse JSON from ${command}: ${error.message}`, result);
  }
}

function fieldValue(item, name) {
  if (!name) {
    return undefined;
  }

  const candidates = [
    name,
    name.charAt(0).toLowerCase() + name.slice(1),
    name.toLowerCase()
  ];

  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(item, candidate)) {
      return item[candidate];
    }
  }
  return undefined;
}

export function issueFromItem(item, statusFieldName = 'Status') {
  if (!item?.content || item.content.type !== 'Issue') {
    return null;
  }

  return {
    itemId: item.id,
    projectStatus: fieldValue(item, statusFieldName) ?? item.status,
    priority: item.priority,
    size: item.size,
    repository: item.content.repository ?? item.repository,
    number: item.content.number,
    title: item.content.title,
    body: item.content.body ?? '',
    url: item.content.url,
    assignees: item.assignees ?? [],
    labels: item.labels ?? []
  };
}

export async function listProjectItems(config, cwd) {
  const data = await runJson(
    'gh',
    [
      'project',
      'item-list',
      String(config.projectNumber),
      '--owner',
      config.owner,
      '--limit',
      '100',
      '--format',
      'json'
    ],
    { cwd }
  );
  return data.items ?? [];
}

export async function findProjectItemByIssue(config, cwd, issueNumber) {
  const items = await listProjectItems(config, cwd);
  return items.find((item) => item.content?.number === issueNumber) ?? null;
}

export async function setProjectStatus(config, cwd, itemId, optionKey) {
  const optionId = config.statusOptions[optionKey];
  if (!optionId) {
    throw new Error(`Missing status option id for ${optionKey}`);
  }

  return runCommand(
    'gh',
    [
      'project',
      'item-edit',
      '--id',
      itemId,
      '--project-id',
      config.projectId,
      '--field-id',
      config.statusFieldId,
      '--single-select-option-id',
      optionId,
      '--format',
      'json'
    ],
    { cwd }
  );
}

export async function addIssueLabel(config, cwd, issueNumber, label) {
  return runCommand(
    'gh',
    ['issue', 'edit', String(issueNumber), '--repo', config.repo, '--add-label', label],
    { cwd }
  );
}

export async function removeIssueLabel(config, cwd, issueNumber, label) {
  return runCommand(
    'gh',
    ['issue', 'edit', String(issueNumber), '--repo', config.repo, '--remove-label', label],
    { cwd }
  );
}

export async function assignIssue(config, cwd, issueNumber) {
  if (!config.assignee) {
    return null;
  }

  return runCommand(
    'gh',
    ['issue', 'edit', String(issueNumber), '--repo', config.repo, '--add-assignee', config.assignee],
    { cwd }
  );
}

export async function addIssueComment(config, cwd, issueNumber, body) {
  return runCommand(
    'gh',
    ['issue', 'comment', String(issueNumber), '--repo', config.repo, '--body', redact(body)],
    { cwd }
  );
}

export async function createDraftPr(config, cwd, branch, title, body) {
  const result = await runCommand(
    'gh',
    [
      'pr',
      'create',
      '--repo',
      config.repo,
      '--base',
      'main',
      '--head',
      branch,
      '--title',
      title,
      '--body',
      redact(body),
      '--draft'
    ],
    { cwd }
  );
  return result.stdout.trim();
}

export async function pushBranch(cwd, branch) {
  return runCommand('git', ['push', '-u', 'origin', branch], { cwd });
}

export async function createOrSwitchBranch(cwd, branch) {
  const branches = await runCommand('git', ['branch', '--list', branch], { cwd });
  if (branches.stdout.trim()) {
    return runCommand('git', ['switch', branch], { cwd });
  }
  return runCommand('git', ['switch', '-c', branch], { cwd });
}

export async function currentBranch(cwd) {
  const result = await runCommand('git', ['branch', '--show-current'], { cwd });
  return result.stdout.trim();
}

export async function gitStatus(cwd) {
  const result = await runCommand('git', ['status', '--short'], { cwd });
  return result.stdout;
}

export async function changedFiles(cwd) {
  const result = await runCommand('git', ['status', '--short'], { cwd });
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3));
}

export async function commitFiles(cwd, files, message) {
  if (!files.length) {
    throw new Error('No files were provided to commit.');
  }

  await runCommand('git', ['add', '--', ...files], { cwd });
  return runCommand('git', ['commit', '-m', message], { cwd });
}
