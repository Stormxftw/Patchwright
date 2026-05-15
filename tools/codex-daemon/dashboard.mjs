#!/usr/bin/env node
import { createServer } from 'node:http';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeDir } from './state.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const publicDir = path.join(rootDir, 'tools', 'codex-daemon', 'public');
const runsFile = path.join(rootDir, runtimeDir, 'runs.jsonl');
const runsDir = path.join(rootDir, runtimeDir, 'runs');
const defaultPort = 3765;

const terminalEventTypes = new Set([
  'dry_run_selected',
  'packet_incomplete',
  'scope_violation',
  'draft_pr_opened',
  'fatal_error'
]);

function parseArgs(argv) {
  const flags = {
    host: '127.0.0.1',
    port: Number(process.env.CODEX_DAEMON_DASHBOARD_PORT) || defaultPort
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--host') flags.host = argv[++index];
    else if (arg === '--port') flags.port = Number(argv[++index]);
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return flags;
}

function printHelp() {
  console.log(`Patchwright dashboard

Usage:
  node tools/codex-daemon/dashboard.mjs [--host 127.0.0.1] [--port 3765]
`);
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

function parseJsonLines(text) {
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    try {
      records.push(JSON.parse(line));
    } catch {
      records.push({
        timestamp: null,
        type: 'unparseable_line',
        message: line.slice(0, 1000)
      });
    }
  }
  return records;
}

async function readLedger() {
  return parseJsonLines(await readTextIfExists(runsFile));
}

async function readRunOutput(runId) {
  if (!runId || runId.includes('..') || /[\\/]/.test(runId)) {
    return { events: [], finalMessage: '' };
  }

  const dir = path.join(runsDir, runId);
  const [eventsText, finalMessage] = await Promise.all([
    readTextIfExists(path.join(dir, 'events.jsonl')),
    readTextIfExists(path.join(dir, 'final.md'))
  ]);

  return {
    events: parseJsonLines(eventsText).slice(-80),
    finalMessage: finalMessage.slice(-12000)
  };
}

async function readRunDirs() {
  try {
    const entries = await readdir(runsDir, { withFileTypes: true });
    const dirs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const fullPath = path.join(runsDir, entry.name);
      const stats = await stat(fullPath).catch(() => null);
      dirs.push({
        runId: entry.name,
        updatedAt: stats?.mtime?.toISOString?.() ?? null
      });
    }
    return dirs;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function eventLabel(event) {
  switch (event.type) {
    case 'daemon_tick':
      return 'Scheduler tick';
    case 'run_started':
      return `Worker started for issue #${event.issueNumber}`;
    case 'run_claimed':
      return `Issue #${event.issueNumber} assigned to ${event.assignee ?? 'worker'}`;
    case 'codex_worker_started':
      return `${event.workerRole ?? 'Worker'} output stream started for issue #${event.issueNumber}`;
    case 'dry_run_selected':
      return `Dry run selected issue #${event.issueNumber}`;
    case 'packet_incomplete':
      return `Issue #${event.issueNumber} needs info`;
    case 'codex_explorer_finished':
      return `Explorer finished issue #${event.issueNumber}`;
    case 'codex_finished':
      return `Worker finished issue #${event.issueNumber}`;
    case 'run_changes_detected':
      return `Changes detected for issue #${event.issueNumber}`;
    case 'scope_violation':
      return `Scope violation on issue #${event.issueNumber}`;
    case 'draft_pr_opened':
      return `Draft PR opened for issue #${event.issueNumber}`;
    case 'no_candidate':
      return 'No ready issue found';
    case 'daemon_error':
    case 'fatal_error':
      return explainDaemonError(event.error);
    default:
      return event.type ?? 'Event';
  }
}

function explainDaemonError(error) {
  const message = String(error ?? 'Daemon error');
  if (message.includes('config.yml: Access is denied')) {
    return 'GitHub CLI config was not readable. Run the daemon from a normal shell or fix gh config permissions.';
  }
  if (message.includes('Unexpected token') && message.includes('repo')) {
    return 'Config JSON included a UTF-8 BOM. Patchwright now strips BOMs before parsing config.';
  }
  return message;
}

function buildRuns(ledger, runDirs) {
  const runs = new Map();

  for (const dir of runDirs) {
    runs.set(dir.runId, {
      runId: dir.runId,
      updatedAt: dir.updatedAt,
      timeline: [],
      status: 'recorded',
      active: false
    });
  }

  for (const event of ledger) {
    if (!event.runId) {
      continue;
    }

    const run = runs.get(event.runId) ?? {
      runId: event.runId,
      timeline: [],
      status: 'recorded',
      active: false
    };

    run.updatedAt = event.timestamp ?? run.updatedAt ?? null;
    run.issueNumber = event.issueNumber ?? run.issueNumber;
    run.dryRun = event.dryRun ?? run.dryRun ?? false;
    run.packetStatus = event.packetStatus ?? run.packetStatus;
    run.workerRole = event.workerRole ?? run.workerRole;
    run.validationCommands = event.validationCommands ?? run.validationCommands ?? [];
    run.missingFields = event.missingFields ?? run.missingFields ?? [];
    run.branch = event.branch ?? run.branch;
    run.codexCommand = event.codexCommand ?? run.codexCommand;
    run.exitCode = event.exitCode ?? run.exitCode;
    run.changedFiles = event.changedFiles ?? run.changedFiles ?? [];
    run.outOfScopeFiles = event.outOfScopeFiles ?? run.outOfScopeFiles ?? [];
    run.prUrl = event.prUrl ?? run.prUrl;
    run.verification = event.verification ?? run.verification ?? [];
    run.timeline.push({
      timestamp: event.timestamp,
      type: event.type,
      label: eventLabel(event)
    });

    if (event.type === 'run_started') {
      run.status = event.dryRun ? 'dry run' : 'running';
      run.startedAt = event.timestamp ?? run.startedAt;
    } else if (event.type === 'codex_finished') {
      run.status = event.exitCode === 0 ? 'verifying' : 'worker failed';
    } else if (event.type === 'run_changes_detected') {
      run.status = 'changes detected';
    } else if (event.type === 'draft_pr_opened') {
      run.status = 'in review';
      run.completedAt = event.timestamp;
    } else if (event.type === 'scope_violation') {
      run.status = 'blocked';
      run.completedAt = event.timestamp;
    } else if (event.type === 'packet_incomplete') {
      run.status = 'needs info';
      run.completedAt = event.timestamp;
    } else if (terminalEventTypes.has(event.type)) {
      run.completedAt = event.timestamp ?? run.completedAt;
    }

    runs.set(event.runId, run);
  }

  for (const run of runs.values()) {
    run.active = Boolean(run.startedAt && !run.completedAt && !run.dryRun);
    run.timeline = run.timeline.slice(-12);
  }

  return [...runs.values()].sort((left, right) =>
    String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''))
  );
}

function summarizeDaemon(ledger, runs) {
  const latest = ledger.at(-1);
  const activeRuns = runs.filter((run) => run.active);
  const latestTick = [...ledger].reverse().find((event) => event.type === 'daemon_tick');
  const latestHealthyIndex = ledger.findLastIndex(
    (event) => event.type && !event.type.includes('error') && event.type !== 'fatal_error'
  );
  const currentErrors = ledger
    .slice(Math.max(0, latestHealthyIndex + 1))
    .filter((event) => event.type === 'daemon_error' || event.type === 'fatal_error');

  return {
    live: true,
    generatedAt: new Date().toISOString(),
    latestEventAt: latest?.timestamp ?? null,
    latestEvent: latest ? eventLabel(latest) : 'No daemon events recorded yet',
    latestTickAt: latestTick?.timestamp ?? null,
    activeRunCount: activeRuns.length,
    totalRunCount: runs.length,
    currentErrorCount: currentErrors.length
  };
}

async function buildSnapshot() {
  const [ledger, runDirs] = await Promise.all([readLedger(), readRunDirs()]);
  const runs = buildRuns(ledger, runDirs);
  const latestHealthyIndex = ledger.findLastIndex(
    (event) => event.type && !event.type.includes('error') && event.type !== 'fatal_error'
  );
  const recentEvents = ledger.slice(-40).reverse().map((event) => ({
    timestamp: event.timestamp,
    type: event.type,
    label:
      (event.type === 'daemon_error' || event.type === 'fatal_error') && ledger.indexOf(event) < latestHealthyIndex
        ? `Recovered: ${eventLabel(event)}`
        : eventLabel(event),
    recovered: (event.type === 'daemon_error' || event.type === 'fatal_error') && ledger.indexOf(event) < latestHealthyIndex,
    runId: event.runId,
    issueNumber: event.issueNumber
  }));

  return {
    daemon: summarizeDaemon(ledger, runs),
    runs: runs.slice(0, 30),
    recentEvents
  };
}

async function sendJson(response, value) {
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function sendNotFound(response) {
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('Not found\n');
}

function sendError(response, error) {
  response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify({ error: error.message })}\n`);
}

async function sendStatic(requestUrl, response) {
  const pathname = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
  const decoded = decodeURIComponent(pathname);
  const filePath = path.normalize(path.join(publicDir, decoded));

  if (!filePath.startsWith(publicDir)) {
    sendNotFound(response);
    return;
  }

  if (!(await fileExists(filePath))) {
    sendNotFound(response);
    return;
  }

  const ext = path.extname(filePath);
  const contentType =
    ext === '.html'
      ? 'text/html; charset=utf-8'
      : ext === '.css'
        ? 'text/css; charset=utf-8'
        : ext === '.js'
          ? 'text/javascript; charset=utf-8'
          : ext === '.svg'
            ? 'image/svg+xml; charset=utf-8'
            : ext === '.png'
              ? 'image/png'
              : 'application/octet-stream';

  response.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-store'
  });
  response.end(await readFile(filePath));
}

async function sendEvents(response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive'
  });

  let closed = false;
  response.on('close', () => {
    closed = true;
  });

  const writeSnapshot = async () => {
    if (closed) {
      return;
    }
    const snapshot = await buildSnapshot();
    response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
  };

  await writeSnapshot().catch((error) => {
    response.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
  });

  const timer = setInterval(() => {
    writeSnapshot().catch((error) => {
      response.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
    });
  }, 1500);

  response.on('close', () => clearInterval(timer));
}

async function handleRequest(request, response) {
  const requestUrl = new URL(request.url ?? '/', 'http://localhost');

  try {
    if (requestUrl.pathname === '/api/status') {
      await sendJson(response, await buildSnapshot());
      return;
    }

    if (requestUrl.pathname === '/api/run') {
      await sendJson(response, await readRunOutput(requestUrl.searchParams.get('id')));
      return;
    }

    if (requestUrl.pathname === '/api/events') {
      await sendEvents(response);
      return;
    }

    await sendStatic(requestUrl, response);
  } catch (error) {
    sendError(response, error);
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    return;
  }

  const server = createServer((request, response) => {
    handleRequest(request, response);
  });

  server.listen(flags.port, flags.host, () => {
    console.log(`Patchwright dashboard: http://${flags.host}:${flags.port}`);
  });
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

export { buildRuns, buildSnapshot, parseJsonLines };
