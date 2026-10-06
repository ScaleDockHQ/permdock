import { type FSWatcher, watch } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";

import type { PermDockPluginOptions } from "./types.ts";

import { runCollect } from "./collect.ts";
import { isConfigFile, loadConfig } from "./config.ts";
import { describeError } from "./errors.ts";
import { defaultSrcPath } from "./files.ts";

const DEBOUNCE_MS = 50;

export function report(message: string | undefined): void {
  if (message !== undefined) {
    process.stderr.write(`permdock: ${message}\n`);
  }
}

// The folder above a glob's first wildcard segment: `packages/*/src` watches `packages`.
function watchRoot(cwd: string, entry: string): string {
  const wildcard = entry.search(/[*?[{]/u);
  return resolve(
    cwd,
    wildcard === -1 ? entry : dirname(`${entry.slice(0, wildcard)}x`),
  );
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

export type CollectSettings = {
  /** A `--config` path; the default is the first `permdock.config.*` in `cwd`. */
  readonly configFile?: string;
  readonly report?: (message: string | undefined) => void;
};

export async function collectOnce(
  cwd: string,
  options: PermDockPluginOptions | undefined,
  check: boolean,
  fresh: boolean,
  configFile?: string,
): Promise<CollectRun> {
  const config = await loadConfig(cwd, configFile, { fresh });
  const collect = { ...config.collect, ...options?.collect };
  const result = await runCollect({
    cwd,
    config,
    collect,
    check,
    now: new Date(),
    fresh,
  });
  const inputs = [configFile, config.permissions, config.policy]
    .filter((path) => path !== undefined)
    .map((path) => resolve(cwd, path));
  const sources = (collect.srcPath ?? defaultSrcPath()).map((entry) =>
    watchRoot(cwd, entry),
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
  readonly close: () => void;
};

export function createCollectScheduler(
  cwd: string,
  options: PermDockPluginOptions | undefined,
  settings?: CollectSettings,
): CollectScheduler {
  const log = settings?.report ?? report;
  let loaded = false;
  let ignored: ReadonlySet<string> = new Set();
  let inputs: readonly string[] = [];
  let sources: readonly string[] = (
    options?.collect?.srcPath ?? defaultSrcPath()
  ).map((entry) => watchRoot(cwd, entry));
  let running = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchers: FSWatcher[] = [];

  async function run(check: boolean): Promise<string | undefined> {
    const fresh = loaded;
    loaded = true;
    const result = await collectOnce(
      cwd,
      options,
      check,
      fresh,
      settings?.configFile,
    );
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
        log(await run(false));
      } catch (error) {
        log(describeError(error));
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

  function close(): void {
    clearTimeout(timer);
    for (const watcher of watchers.splice(0)) {
      watcher.close();
    }
  }

  return { run, changed, watch: startWatch, close };
}
