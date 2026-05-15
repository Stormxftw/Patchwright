import { mkdir, readFile, writeFile, appendFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export const runtimeDir = '.codex-daemon';

const secretPatterns = [
  /\bghp_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g,
  /\b[A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*=([^\s]+)/gi,
  /\b[A-Za-z0-9_]*KEY[A-Za-z0-9_]*=([^\s]+)/gi
];

export function redact(value) {
  if (value == null) {
    return value;
  }

  let output = typeof value === 'string' ? value : JSON.stringify(value);
  for (const pattern of secretPatterns) {
    output = output.replace(pattern, (match) => {
      const equalsIndex = match.indexOf('=');
      return equalsIndex === -1 ? '[REDACTED]' : `${match.slice(0, equalsIndex + 1)}[REDACTED]`;
    });
  }
  return output;
}

export function sanitizeRecord(record) {
  return JSON.parse(redact(record));
}

export function parseJsonText(text) {
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

export async function ensureRuntimeDirs(rootDir) {
  await mkdir(path.join(rootDir, runtimeDir, 'locks'), { recursive: true });
  await mkdir(path.join(rootDir, runtimeDir, 'runs'), { recursive: true });
}

export async function appendLedger(rootDir, event) {
  await ensureRuntimeDirs(rootDir);
  const record = {
    timestamp: new Date().toISOString(),
    ...sanitizeRecord(event)
  };
  await appendFile(
    path.join(rootDir, runtimeDir, 'runs.jsonl'),
    `${JSON.stringify(record)}\n`,
    'utf8'
  );
}

export function runDir(rootDir, runId) {
  return path.join(rootDir, runtimeDir, 'runs', runId);
}

export function lockPath(rootDir, issueNumber) {
  return path.join(rootDir, runtimeDir, 'locks', `issue-${issueNumber}.json`);
}

export async function readJsonIfExists(filePath) {
  try {
    const text = await readFile(filePath, 'utf8');
    return parseJsonText(text);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(sanitizeRecord(value), null, 2)}\n`, 'utf8');
}

export async function writeLock(rootDir, issueNumber, lock) {
  await writeJson(lockPath(rootDir, issueNumber), lock);
}

export async function readLock(rootDir, issueNumber) {
  return readJsonIfExists(lockPath(rootDir, issueNumber));
}

export async function removeLock(rootDir, issueNumber) {
  await rm(lockPath(rootDir, issueNumber), { force: true });
}

export async function isPidRunning(pid) {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function isStaleLock(rootDir, issueNumber) {
  const lock = await readLock(rootDir, issueNumber);
  if (!lock) {
    return false;
  }

  if (await isPidRunning(lock.pid)) {
    return false;
  }

  try {
    const lockStats = await stat(lockPath(rootDir, issueNumber));
    const ageMs = Date.now() - lockStats.mtimeMs;
    return ageMs > 60000;
  } catch {
    return true;
  }
}
