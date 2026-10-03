import { spawnSync } from 'node:child_process';
import path from 'node:path';

const cwd = path.join(import.meta.dirname, '..');
const bin = (name: string) => path.join(cwd, 'node_modules/.bin', name);

/**
 * Runs `better-supabase doctor --strict` against this project's running local
 * stack (`pnpm supabase:start`). The URL goes over stdin, never argv.
 */
const status = spawnSync(
  bin('supabase'),
  ['status', '--output-format', 'json'],
  {
    cwd,
    encoding: 'utf8',
  },
);
if (status.status !== 0) {
  throw new Error(`supabase status failed: ${status.stderr}`);
}
const parsed: unknown = JSON.parse(status.stdout);
const url =
  typeof parsed === 'object' &&
  parsed !== null &&
  'env' in parsed &&
  typeof parsed.env === 'object' &&
  parsed.env !== null &&
  'DB_URL' in parsed.env &&
  typeof parsed.env.DB_URL === 'string'
    ? parsed.env.DB_URL
    : '';
if (url === '') {
  throw new Error(
    'supabase status printed no env.DB_URL; is the local stack running?',
  );
}
const doctor = spawnSync(
  bin('better-supabase'),
  ['doctor', '--db-url-stdin', '--strict'],
  { cwd, input: url, stdio: ['pipe', 'inherit', 'inherit'] },
);
process.exitCode = doctor.status ?? 1;
