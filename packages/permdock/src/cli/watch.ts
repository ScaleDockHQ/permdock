import { type FSWatcher, watch } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";

import type { PermDockPluginOptions } from "./types.ts";

import { runCollect } from "./collect.ts";
import { isConfigFile, loadConfig } from "./config.ts";
import { defaultSrcPath } from "./files.ts";

const DEBOUNCE_MS = 50;

export function report(message: string | undefined): void {
  if (message !== undefined) {
    process.stderr.write(`permdock: ${message}\n`);
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function within(dirs: readonly string[], file: string): boolean {
  return dirs.some((dir) => {
    const path = relative(dir, file);
    return path !== "" && !path.startsWith("..") && !path.startsWith(sep);
  });
}

type CollectRun = {
  readonly message: string | undefined;
  readonly written: readonly string[];
  readonly inputs: readonly string[];
  readonly sources: readonly string[];
};

export async function collectOnce(
  cwd: string,
  options: PermDockPluginOptions | undefined,
  check: boolean,
  fresh: boolean,
): Promise<CollectRun> {
  const config = await loadConfig(cwd, undefined, { fresh });
  const collect = { ...config.collect, ...options?.collect };
  const result = await runCollect({
    cwd,
    config,
    collect,
    check,
    now: new Date(),
    fresh,
  });
  const inputs = [config.permissions, config.policy]
    .filter((path) => path !== undefined)
    .map((path) => resolve(cwd, path));
  const sources = (collect.srcPath ?? defaultSrcPath()).map((entry) =>
    resolve(cwd, entry),
  );
  const run = { written: result.written ?? [], inputs, sources };
  if (result.code === 0) {
    return { message: undefined, ...run };
  }
  if (check && options?.onDrift !== "warn" && result.code === 1) {
    throw new Error(result.message);
  }
  return { message: result.message, ...run };
}

export type CollectScheduler = {
  /** Collects now. The first run imports natively; later runs load fresh. */
  readonly run: (check: boolean) => Promise<string | undefined>;
  /** Schedules a collect for a changed file, unless the collect wrote it. */
  readonly changed: (file: string | undefined) => void;
  /** Watches the source folders, the config file and the configured modules. */
  readonly watch: () => void;
};

export function createCollectScheduler(
  cwd: string,
  options: PermDockPluginOptions | undefined,
): CollectScheduler {
  let loaded = false;
  let ignored: ReadonlySet<string> = new Set();
  let inputs: readonly string[] = [];
  let sources: readonly string[] = (
    options?.collect?.srcPath ?? defaultSrcPath()
  ).map((entry) => resolve(cwd, entry));
  let running = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchers: FSWatcher[] = [];

  async function run(check: boolean): Promise<string | undefined> {
    const fresh = loaded;
    loaded = true;
    const result = await collectOnce(cwd, options, check, fresh);
    ignored = new Set(result.written);
    inputs = result.inputs;
    sources = result.sources;
    return result.message;
  }

  async function drain(): Promise<void> {
    running = true;
    while (pending) {
      pending = false;
      try {
        report(await run(false));
      } catch (error) {
        report(describeError(error));
      }
    }
    running = false;
  }

  function changed(file: string | undefined): void {
    if (file !== undefined && ignored.has(resolve(cwd, file))) {
      return;
    }
    pending = true;
    if (running) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      void drain();
    }, DEBOUNCE_MS);
  }

  function watchDir(
    dir: string,
    recursive: boolean,
    accept: (file: string) => boolean,
  ): void {
    try {
      watchers.push(
        watch(dir, { recursive }, (_event, name) => {
          if (name === null) {
            changed(undefined);
            return;
          }
          const file = resolve(dir, name);
          if (accept(file)) {
            changed(file);
          }
        }),
      );
    } catch {
      // A missing folder is not an error in dev; the collect reports it.
    }
  }

  function startWatch(): void {
    if (watchers.length > 0) {
      return;
    }
    for (const dir of sources) {
      watchDir(dir, true, () => true);
    }
    const loose = inputs.filter((file) => !within(sources, file));
    const dirs = new Set([cwd, ...loose.map((file) => dirname(file))]);
    for (const dir of dirs) {
      watchDir(
        dir,
        false,
        (file) =>
          loose.includes(file) || (dir === cwd && isConfigFile(basename(file))),
      );
    }
  }

  return { run, changed, watch: startWatch };
}
