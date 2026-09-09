import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function run(
  args: readonly string[],
  env: { readonly [key: string]: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'pnpm',
      ['--filter', '@permdock/example-terminal', 'start', '--', ...args],
      {
        cwd: root,
        env: { ...process.env, ...env },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

test.describe('terminal example', { tag: '@smoke' }, () => {
  test('grants developer status', async () => {
    const result = await run(['status'], { PERMDOCK_TOKEN: 'dev' });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/api staging/u);
  });

  test('denies developer production deploy', async () => {
    const result = await run(['deploy', '--env', 'production'], {
      PERMDOCK_TOKEN: 'dev',
    });
    expect(result.code).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toMatch(/denied/iu);
  });
});
