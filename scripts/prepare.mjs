import { execFileSync } from 'node:child_process';
import { env } from 'node:process';

// CI and Vercel builds never commit, so they skip the git hooks.
if (!Object.hasOwn(env, 'CI') && !Object.hasOwn(env, 'VERCEL')) {
  execFileSync('lefthook', ['install'], { stdio: 'inherit' });
}
