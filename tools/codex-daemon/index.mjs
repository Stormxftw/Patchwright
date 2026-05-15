#!/usr/bin/env node
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addIssueComment,
  addIssueLabel,
  assignIssue,
  changedFiles,
  commitFiles,
  createDraftPr,
  createOrSwitchBranch,
  currentBranch,
  findProjectItemByIssue,
  gitStatus,
  issueFromItem,
  listProjectItems,
  pushBranch,
  removeIssueLabel,
  runCommand,
  runShellCommand,
  setProjectStatus
} from './github.mjs';
import { runCodex } from './codex-runner.mjs';
import {
  appendLedger,
  ensureRuntimeDirs,
  isStaleLock,
  readJsonIfExists,
  readLock,
  redact,
  removeLock,
  runDir,
  runtimeDir,
  writeLock
} from './state.mjs';
import { branchName, buildCodexPrompt } from './prompts.mjs';
import {
  filesOutsideAllowedPaths,
  formatMissingPacketComment,
  formatScopeViolationComment,
  packetStatus,
  parseTaskPacket
} from './packet.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const defaultConfigPath = path.join(rootDir, 'tools', 'codex-daemon', 'config.example.json');
const localConfigPath = path.join(rootDir, runtimeDir, 'config.json');

function parseArgs(argv) {
  const flags = {
    dryRun: false,
    once: false,
    watch: false,
    includeBacklog: false,
    allowDirty: false,
    recover: false,
    intervalMs: null,
    configPath: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--once') flags.once = true;
    else if (arg === '--watch') flags.watch = true;
    else if (arg === '--include-backlog') flags.includeBacklog = true;
    else if (arg === '--allow-dirty') flags.allowDirty = true;
    else if (arg === '--recover') flags.recover = true;
    else if (arg === '--interval-ms') flags.intervalMs = Number(argv[++index]);
    else if (arg === '--config') flags.configPath = argv[++index];
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!flags.dryRun && !flags.once && !flags.watch) {
    flags.dryRun = true;
  }

  return flags;
}

function printHelp() {
  console.log(`Codex R&D daemon

Usage:
  node tools/codex-daemon/index.mjs --dry-run [--include-backlog]
  node tools/codex-daemon/index.mjs --once [--include-backlog] [--allow-dirty]
  node tools/codex-daemon/index.mjs --watch [--include-backlog] [--allow-dirty]

Options:
  --dry-run          Select and describe the next issue without mutating GitHub or git.
  --once             Claim and process one issue.
  --watch            Poll forever using config.watchIntervalMs.
  --include-backlog  Allow Backlog items when no Ready items exist.
  --allow-dirty      Permit real runs when the worktree already has changes.
  --recover          Clear stale issue locks before running.
  --config <path>    Use a config file instead of .codex-daemon/config.json.
`);
}

async function loadConfig(flags) {
  const defaults = JSON.parse(await readFile(defaultConfigPath, 'utf8'));
  const explicitPath = flags.configPath ? path.resolve(rootDir, flags.configPath) : null;
  const local = await readJsonIfExists(explicitPath ?? localConfigPath);
  return {
    ...defaults,
    ...(local ?? {}),
    statusOptions: {
      ...defaults.statusOptions,
      ...(local?.statusOptions ?? {})
    }
  };
}

function runIdFor(issue) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${stamp}-issue-${issue.number}`;
}

function normalizeStatus(status) {
  return String(status ?? '').trim().toLowerCase();
}

function pickIssue(items, config, includeBacklog) {
  const issues = items
    .map((item) => issueFromItem(item, config.projectStatusFieldName))
    .filter(Boolean);
  const readyStatuses = new Set((config.readyStatuses ?? ['Ready']).map(normalizeStatus));
  const fallbackStatuses = new Set((config.fallbackReadyStatuses ?? ['Backlog']).map(normalizeStatus));

  const ready = issues.find((issue) => readyStatuses.has(normalizeStatus(issue.projectStatus)));
  if (ready) {
    return { issue: ready, source: 'ready' };
  }

  if (!includeBacklog) {
    return { issue: null, source: 'none' };
  }

  const fallback = issues.find((issue) => fallbackStatuses.has(normalizeStatus(issue.projectStatus)));
  return { issue: fallback ?? null, source: fallback ? 'fallback' : 'none' };
}

function filesNeedBuild(files) {
  return files.some((file) =>
    /^(src\/|src\\|vite\.config\.ts|tsconfig|package\.json|package-lock\.json)/i.test(file)
  );
}

function filesNeedPlaceholderCheck(files) {
  return files.some((file) =>
    [
      'src/data/dashboard.ts',
      'src\\data\\dashboard.ts',
      'src/App.tsx',
      'src\\App.tsx',
      'docs/placeholder-data.md',
      'docs\\placeholder-data.md',
      'supabase/seed.sql',
      'supabase\\seed.sql'
    ].includes(file)
  );
}

async function ensureWorktreeAllowed(flags) {
  const status = await gitStatus(rootDir);
  const relevant = status
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => !line.includes(runtimeDir));

  if (relevant.length && !flags.allowDirty) {
    throw new Error(
      `Worktree has existing changes. Re-run with --allow-dirty only if this daemon should work alongside them.\n${relevant.join('\n')}`
    );
  }
}

async function baselineDirtyFiles() {
  const status = await gitStatus(rootDir);
  return new Set(
    status
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((line) => !line.includes(runtimeDir))
      .map((line) => line.trim().slice(3))
  );
}

async function maybeRecoverLock(flags, issue) {
  const lock = await readLock(rootDir, issue.number);
  if (!lock) {
    return;
  }

  const stale = await isStaleLock(rootDir, issue.number);
  if (!stale) {
    throw new Error(`Issue #${issue.number} is already locked by run ${lock.runId ?? '(unknown)'}.`);
  }

  if (!flags.recover) {
    throw new Error(`Issue #${issue.number} has a stale lock. Re-run with --recover to clear it.`);
  }

  await removeLock(rootDir, issue.number);
}

async function rollbackClaim(config, issue, changed) {
  const errors = [];
  if (changed.status && issue.itemId) {
    try {
      await setProjectStatus(config, rootDir, issue.itemId, changed.previousStatusKey ?? 'ready');
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (changed.label) {
    try {
      await removeIssueLabel(config, rootDir, issue.number, config.claimLabel);
    } catch (error) {
      errors.push(error.message);
    }
  }
  return errors;
}

async function claimIssue(config, flags, issue, runId) {
  await maybeRecoverLock(flags, issue);

  const freshItem = await findProjectItemByIssue(config, rootDir, issue.number);
  const freshIssue = issueFromItem(freshItem, config.projectStatusFieldName);
  if (!freshIssue) {
    throw new Error(`Could not refetch issue #${issue.number} from the project.`);
  }

  const allowedStatuses = new Set([
    ...(config.readyStatuses ?? []),
    ...(flags.includeBacklog ? config.fallbackReadyStatuses ?? [] : [])
  ].map(normalizeStatus));

  if (!allowedStatuses.has(normalizeStatus(freshIssue.projectStatus))) {
    throw new Error(`Issue #${issue.number} is now ${freshIssue.projectStatus}; skipping stale claim.`);
  }

  const changed = {};
  try {
    await setProjectStatus(config, rootDir, freshIssue.itemId, 'inProgress');
    changed.status = true;
    changed.previousStatusKey = normalizeStatus(freshIssue.projectStatus) === 'backlog' ? 'backlog' : 'ready';

    await assignIssue(config, rootDir, freshIssue.number);
    changed.assignee = true;

    await addIssueLabel(config, rootDir, freshIssue.number, config.claimLabel);
    changed.label = true;

    await addIssueComment(
      config,
      rootDir,
      freshIssue.number,
      `Codex daemon claimed this issue at ${new Date().toISOString()}; run id ${runId}.`
    );
    changed.comment = true;

    await writeLock(rootDir, freshIssue.number, {
      runId,
      issueNumber: freshIssue.number,
      itemId: freshIssue.itemId,
      pid: process.pid,
      claimedAt: new Date().toISOString()
    });
    return freshIssue;
  } catch (error) {
    const rollbackErrors = await rollbackClaim(config, freshIssue, changed);
    throw new Error(
      `Claim failed for #${freshIssue.number}: ${error.message}${
        rollbackErrors.length ? `\nRollback errors:\n${rollbackErrors.join('\n')}` : ''
      }`
    );
  }
}

async function verifyChanges(files, packet, config) {
  const results = [];
  const commands = packet?.validationCommands?.length
    ? packet.validationCommands.slice(0, config.maxValidationCommands ?? 5)
    : [];

  for (const command of commands) {
    const result = await runShellCommand(command, { cwd: rootDir }).catch(
      (error) => error.result ?? { stdout: '', stderr: error.message, exitCode: 1 }
    );
    results.push({
      command,
      exitCode: result.exitCode,
      stdout: result.stdout.slice(-4000),
      stderr: result.stderr.slice(-4000)
    });
  }

  if (!commands.length && filesNeedBuild(files)) {
    const result = await runCommand('npm.cmd', ['run', 'build'], { cwd: rootDir });
    results.push({
      command: 'npm.cmd run build',
      exitCode: result.exitCode,
      stdout: result.stdout.slice(-4000),
      stderr: result.stderr.slice(-4000)
    });
  }

  if (!commands.length && filesNeedPlaceholderCheck(files)) {
    const placeholderData = await runCommand('rg', ['-n', 'PLACEHOLDER-DATA'], { cwd: rootDir }).catch(
      (error) => error.result ?? { stdout: '', stderr: error.message, exitCode: 1 }
    );
    const registry = await runCommand('rg', ['-n', 'placeholderDataRegistry'], { cwd: rootDir }).catch(
      (error) => error.result ?? { stdout: '', stderr: error.message, exitCode: 1 }
    );
    results.push({
      command: 'rg placeholder checks',
      exitCode: 0,
      stdout: `${placeholderData.stdout}\n${registry.stdout}`.trim(),
      stderr: `${placeholderData.stderr}\n${registry.stderr}`.trim()
    });
  }

  return results;
}

function summarizeVerification(results) {
  if (!results.length) {
    return 'No runtime verification required by changed file set.';
  }

  return results
    .map((result) => `- ${result.command}: exit ${result.exitCode}`)
    .join('\n');
}

async function processIssue(config, flags, issue) {
  const runId = runIdFor(issue);
  const packet = parseTaskPacket(issue, config);
  const status = packetStatus(packet);
  const incompleteStatusKey = config.packetIncompleteStatus ?? 'needsInfo';
  await appendLedger(rootDir, {
    type: 'run_started',
    runId,
    issueNumber: issue.number,
    dryRun: flags.dryRun,
    packetStatus: status,
    workerRole: packet.role,
    validationCommands: packet.validationCommands
  });

  const branch = branchName(config, issue);
  const codexCommand = `codex exec --json --cd ${rootDir} --sandbox workspace-write --output-last-message ${path.join(
    runDir(rootDir, runId),
    'final.md'
  )} "<prompt>"`;

  if (flags.dryRun) {
    console.log(`Candidate issue: #${issue.number} ${issue.title}`);
    console.log(`Current status: ${issue.projectStatus}`);
    console.log(`Packet status: ${status}`);
    console.log(`Worker role: ${packet.role}`);
    console.log(
      `Validation commands: ${
        packet.validationCommands.length ? packet.validationCommands.join(' && ') : '(fallback verification)'
      }`
    );
    if (!packet.complete) {
      console.log(`Missing packet fields: ${packet.missingFields.join(', ')}`);
      console.log(`Planned status: ${incompleteStatusKey}`);
    } else {
      console.log(`Planned status: In progress`);
    }
    console.log(`Planned branch: ${branch}`);
    console.log(`Planned Codex command: ${codexCommand}`);
    await appendLedger(rootDir, {
      type: 'dry_run_selected',
      runId,
      issueNumber: issue.number,
      packetStatus: status,
      workerRole: packet.role,
      validationCommands: packet.validationCommands,
      missingFields: packet.missingFields,
      branch,
      codexCommand
    });
    return { processed: false, dryRun: true };
  }

  if (!packet.complete) {
    if (issue.itemId) {
      await setProjectStatus(config, rootDir, issue.itemId, incompleteStatusKey);
    }
    await addIssueComment(config, rootDir, issue.number, formatMissingPacketComment(packet));
    await appendLedger(rootDir, {
      type: 'packet_incomplete',
      runId,
      issueNumber: issue.number,
      missingFields: packet.missingFields,
      status: incompleteStatusKey
    });
    return { processed: false, packetIncomplete: true };
  }

  await ensureWorktreeAllowed(flags);
  const claimedIssue = await claimIssue(config, flags, issue, runId);
  let codexResult = null;
  let prUrl = null;

  try {
    await mkdir(runDir(rootDir, runId), { recursive: true });
    await createOrSwitchBranch(rootDir, branch);
    const baselineFiles = await baselineDirtyFiles();
    let effectivePacket = packet;

    if (packet.role === 'explorer') {
      const explorerRunId = `${runId}-explorer`;
      const explorerPrompt = await buildCodexPrompt(rootDir, config, claimedIssue, explorerRunId, claimedIssue.projectStatus, packet);
      const explorerResult = await runCodex({
        rootDir,
        runId: explorerRunId,
        prompt: explorerPrompt,
        sandbox: 'read-only'
      });
      const explorerSummary = await readFile(explorerResult.finalPath, 'utf8').catch(() => '');
      await appendLedger(rootDir, {
        type: 'codex_explorer_finished',
        runId,
        issueNumber: claimedIssue.number,
        exitCode: explorerResult.exitCode,
        stderr: explorerResult.stderr,
        finalPath: explorerResult.finalPath
      });

      if (explorerResult.exitCode !== 0) {
        await setProjectStatus(config, rootDir, claimedIssue.itemId, 'ready');
        await removeIssueLabel(config, rootDir, claimedIssue.number, config.claimLabel);
        await addIssueComment(
          config,
          rootDir,
          claimedIssue.number,
          `Codex daemon run ${runId} failed during read-only localization.\n\n${redact(
            explorerResult.stderr || 'No stderr captured.'
          )}`
        );
        return { processed: false, failed: true };
      }

      effectivePacket = {
        ...packet,
        role: 'fixer',
        explorerSummary
      };
    }

    const prompt = await buildCodexPrompt(rootDir, config, claimedIssue, runId, claimedIssue.projectStatus, effectivePacket);
    codexResult = await runCodex({ rootDir, runId, prompt });
    await appendLedger(rootDir, {
      type: 'codex_finished',
      runId,
      issueNumber: claimedIssue.number,
      exitCode: codexResult.exitCode,
      stderr: codexResult.stderr,
      packetStatus: status,
      workerRole: effectivePacket.role
    });

    const currentFiles = await changedFiles(rootDir);
    const files = currentFiles.filter((file) => !baselineFiles.has(file) && !file.includes(runtimeDir));
    const outOfScopeFiles = filesOutsideAllowedPaths(files, effectivePacket.allowedPaths);
    if (outOfScopeFiles.length) {
      await setProjectStatus(config, rootDir, claimedIssue.itemId, 'blocked');
      await addIssueLabel(config, rootDir, claimedIssue.number, config.blockedLabel);
      await addIssueComment(
        config,
        rootDir,
        claimedIssue.number,
        formatScopeViolationComment(runId, outOfScopeFiles, effectivePacket.allowedPaths)
      );
      await appendLedger(rootDir, {
        type: 'scope_violation',
        runId,
        issueNumber: claimedIssue.number,
        changedFiles: files,
        outOfScopeFiles,
        allowedPaths: effectivePacket.allowedPaths
      });
      return { processed: false, blocked: true, outOfScopeFiles };
    }

    const verification = await verifyChanges(files, effectivePacket, config);
    await appendLedger(rootDir, {
      type: 'run_changes_detected',
      runId,
      issueNumber: claimedIssue.number,
      changedFiles: files,
      validationCommands: effectivePacket.validationCommands
    });

    if (codexResult.exitCode !== 0 && !files.length) {
      await setProjectStatus(config, rootDir, claimedIssue.itemId, 'ready');
      await removeIssueLabel(config, rootDir, claimedIssue.number, config.claimLabel);
      await addIssueComment(
        config,
        rootDir,
        claimedIssue.number,
        `Codex daemon run ${runId} failed before producing changes.\n\n${redact(codexResult.stderr || 'No stderr captured.')}`
      );
      return { processed: false, failed: true };
    }

    if (!files.length) {
      await setProjectStatus(config, rootDir, claimedIssue.itemId, 'ready');
      await removeIssueLabel(config, rootDir, claimedIssue.number, config.claimLabel);
      await addIssueComment(
        config,
        rootDir,
        claimedIssue.number,
        `Codex daemon run ${runId} completed with no file changes.\n\nFinal message: ${codexResult.finalPath}`
      );
      return { processed: false, noChanges: true };
    }

    const failedVerification = verification.some((result) => result.exitCode !== 0);
    await commitFiles(rootDir, files, `codex: implement issue #${claimedIssue.number}`);
    const statusAfter = await gitStatus(rootDir);
    await pushBranch(rootDir, branch);

    prUrl = await createDraftPr(
      config,
      rootDir,
      branch,
      `[codex] ${claimedIssue.title}`,
      `Implements #${claimedIssue.number} via Codex daemon run ${runId}.\n\nPacket status: ${status}\nWorker role: ${effectivePacket.role}\n\nVerification:\n${summarizeVerification(
        verification
      )}\n\nLocal final message: ${codexResult.finalPath}`
    );

    await setProjectStatus(config, rootDir, claimedIssue.itemId, 'inReview');
    await appendLedger(rootDir, {
      type: 'draft_pr_opened',
      runId,
      issueNumber: claimedIssue.number,
      prUrl,
      packetStatus: status,
      workerRole: effectivePacket.role,
      verification: verification.map((result) => ({ command: result.command, exitCode: result.exitCode }))
    });

    if (failedVerification || codexResult.exitCode !== 0) {
      await addIssueLabel(config, rootDir, claimedIssue.number, config.blockedLabel);
    }

    await addIssueComment(
      config,
      rootDir,
      claimedIssue.number,
      `Codex daemon run ${runId} opened a draft PR.\n\nBranch: \`${branch}\`\nPR: ${prUrl}\nPacket status: ${status}\nWorker role: ${effectivePacket.role}\n\nVerification:\n${summarizeVerification(
        verification
      )}\n\nChanged files:\n${files.map((file) => `- ${file}`).join('\n')}\n\nCurrent git status after commit:\n\`\`\`\n${statusAfter.trim() || 'clean'}\n\`\`\``
    );

    return { processed: true, prUrl };
  } finally {
    await removeLock(rootDir, issue.number);
  }
}

async function runOnce(flags, config) {
  await ensureRuntimeDirs(rootDir);
  const branch = await currentBranch(rootDir).catch(() => '');
  await appendLedger(rootDir, { type: 'daemon_tick', branch, dryRun: flags.dryRun });

  const items = await listProjectItems(config, rootDir);
  const { issue, source } = pickIssue(items, config, flags.includeBacklog);

  if (!issue) {
    console.log(
      flags.includeBacklog
        ? 'No Ready or Backlog project issues found.'
        : 'No Ready project issues found. Use --include-backlog to allow Backlog fallback.'
    );
    await appendLedger(rootDir, { type: 'no_candidate', source });
    return { processed: false };
  }

  return processIssue(config, flags, issue);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    return;
  }

  const config = await loadConfig(flags);
  if (config.maxConcurrentRuns !== 1) {
    throw new Error('Only maxConcurrentRuns=1 is supported in v1.');
  }

  if (!flags.watch) {
    await runOnce(flags, config);
    return;
  }

  const interval = flags.intervalMs ?? config.watchIntervalMs ?? 300000;
  console.log(`Watching GitHub project every ${interval}ms. Press Ctrl+C to stop.`);
  while (true) {
    try {
      await runOnce(flags, config);
    } catch (error) {
      console.error(redact(error.stack || error.message));
      await appendLedger(rootDir, { type: 'daemon_error', error: error.message });
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

main().catch(async (error) => {
  console.error(redact(error.stack || error.message));
  await appendLedger(rootDir, { type: 'fatal_error', error: error.message }).catch(() => {});
  process.exitCode = 1;
});
