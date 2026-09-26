import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Command = {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
};

export type ServeOptions = {
  /** The fixture root; the build log lands in `<cwd>/.e2e/build.log`. */
  readonly cwd: string;
  readonly build?: Command;
  /** One production server per entry. */
  readonly servers: readonly (Command & { readonly port: number })[];
};

/**
 * Builds once (unless `SKIP_BUILD=1`), then serves each production server
 * until SIGTERM. A server that exits non-zero stops the rest.
 */
export function serve(options: ServeOptions): void {
  const base: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' };
  if (options.build !== undefined && process.env.SKIP_BUILD !== '1') {
    const build = spawnSync(options.build.command, options.build.args, {
      cwd: options.cwd,
      env: { ...base, ...options.build.env },
      encoding: 'utf8',
      shell: false,
    });
    const log = `${build.stdout}\n${build.stderr}`;
    mkdirSync(join(options.cwd, '.e2e'), { recursive: true });
    writeFileSync(join(options.cwd, '.e2e/build.log'), log);
    if (build.status !== 0) {
      process.stderr.write(log);
      throw new Error('build failed; see .e2e/build.log');
    }
  }
  const children: ChildProcess[] = options.servers.map((server) =>
    spawn(server.command, server.args, {
      cwd: options.cwd,
      env: {
        ...base,
        HOST: '127.0.0.1',
        PORT: String(server.port),
        ...server.env,
      },
      stdio: 'inherit',
    }),
  );
  const stop = (): void => {
    for (const child of children) {
      child.kill('SIGTERM');
    }
  };
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
}
