import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redact, runDir } from './state.mjs';

export async function runCodex({ rootDir, runId, prompt }) {
  const dir = runDir(rootDir, runId);
  await mkdir(dir, { recursive: true });

  const finalPath = path.join(dir, 'final.md');
  const eventsPath = path.join(dir, 'events.jsonl');
  const commandPath = path.join(dir, 'command.txt');
  const args = [
    'exec',
    '--json',
    '--cd',
    rootDir,
    '--sandbox',
    'workspace-write',
    '--output-last-message',
    finalPath,
    '-'
  ];

  await writeFile(commandPath, `codex ${args.map((arg) => JSON.stringify(arg)).join(' ')}\n`, 'utf8');

  return new Promise((resolve) => {
    const child = spawn('codex', args, {
      cwd: rootDir,
      shell: false,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = redact(chunk.toString());
      stdout += text;
      writeFile(eventsPath, stdout, 'utf8').catch(() => {});
    });

    child.stderr.on('data', (chunk) => {
      stderr += redact(chunk.toString());
    });

    child.stdin.write(prompt);
    child.stdin.end();

    child.on('close', (exitCode) => {
      resolve({
        exitCode,
        stdout,
        stderr,
        finalPath,
        eventsPath,
        command: 'codex',
        args
      });
    });

    child.on('error', (error) => {
      resolve({
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n${redact(error.message)}`,
        finalPath,
        eventsPath,
        command: 'codex',
        args
      });
    });
  });
}
