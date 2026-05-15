import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redact, runDir } from './state.mjs';

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveCodexCommand() {
  if (process.env.CODEX_CLI_PATH && (await fileExists(process.env.CODEX_CLI_PATH))) {
    return process.env.CODEX_CLI_PATH;
  }

  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const localInstall = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin', 'codex.exe');
    if (await fileExists(localInstall)) {
      return localInstall;
    }
  }

  return 'codex';
}

export async function runCodex({ rootDir, runId, prompt, sandbox = 'workspace-write' }) {
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
    sandbox,
    '--output-last-message',
    finalPath,
    '-'
  ];
  const codexCommand = await resolveCodexCommand();

  await writeFile(
    commandPath,
    `${JSON.stringify(codexCommand)} ${args.map((arg) => JSON.stringify(arg)).join(' ')}\n`,
    'utf8'
  );

  return new Promise((resolve) => {
    const child = spawn(codexCommand, args, {
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
        command: codexCommand,
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
        command: codexCommand,
        args
      });
    });
  });
}
