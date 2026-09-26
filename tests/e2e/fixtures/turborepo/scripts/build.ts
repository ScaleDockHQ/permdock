import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Each step runs in its package, as `turbo run build` would. */
const steps = [
  { cwd: 'packages/permissions', bin: 'tsdown', args: [] },
  { cwd: 'apps/web', bin: 'next', args: ['build'] },
] as const;

for (const step of steps) {
  const cwd = join(root, step.cwd);
  const result = spawnSync(
    join(cwd, 'node_modules/.bin', step.bin),
    step.args,
    {
      cwd,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
      stdio: 'inherit',
    },
  );
  if (result.status !== 0) {
    throw new Error(`${step.bin} failed in ${step.cwd}`);
  }
}
