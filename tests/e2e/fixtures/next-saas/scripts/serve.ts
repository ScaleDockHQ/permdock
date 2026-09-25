import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cwd = join(dirname(fileURLToPath(import.meta.url)), '..');
const next = join(cwd, 'node_modules/.bin/next');
const base: NodeJS.ProcessEnv = {
  ...process.env,
  NEXT_E2E: '1',
  NEXT_TELEMETRY_DISABLED: '1',
};

export const servers = [
  { port: 3490, env: { MEMBERSHIP_MODE: 'jwt' } },
  { port: 3491, env: { MEMBERSHIP_MODE: 'database' } },
  {
    port: 3492,
    env: { MEMBERSHIP_MODE: 'jwt', PERMDOCK_E2E_NO_PRIVATE_CACHE: '1' },
  },
] as const;

if (process.env.SKIP_BUILD !== '1') {
  const build = spawnSync(next, ['build'], {
    cwd,
    env: base,
    encoding: 'utf8',
  });
  const log = `${build.stdout}\n${build.stderr}`;
  mkdirSync(join(cwd, '.e2e'), { recursive: true });
  writeFileSync(join(cwd, '.e2e/build.log'), log);
  if (build.status !== 0) {
    process.stderr.write(log);
    throw new Error('next build failed; see .e2e/build.log');
  }
}

const children: ChildProcess[] = servers.map((server) =>
  spawn(next, ['start', '-p', String(server.port), '-H', '127.0.0.1'], {
    cwd,
    env: { ...base, ...server.env },
    stdio: 'inherit',
  }),
);

function stop(): void {
  for (const child of children) {
    child.kill('SIGTERM');
  }
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
for (const child of children) {
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      process.exitCode = code;
      stop();
    }
  });
}
