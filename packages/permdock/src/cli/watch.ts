import type { FSWatcher } from "node:fs";

import { statSync, watch } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";

import type { CliContext } from "./core/context.ts";
import type { CommandResult } from "./core/result.ts";
import type { CollectConfig, PermDockPluginOptions } from "./types.ts";

import { dateAt } from "../core/time.ts";
import { runCollect } from "./collect.ts";
import { describeError } from "./core/errors.ts";
import { defaultSrcPath } from "./files.ts";
import { isConfigFile, loadConfig } from "./project/config.ts";

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
  /** The time each collect stamps; defaults to the system clock. */
  readonly now?: () => Date;
};

export async function collectOnce(
  cwd: string,
  options: PermDockPluginOptions | undefined,
  check: boolean,
  fresh: boolean,
  configFile?: string,
  now: () => Date = () => dateAt(),
): Promise<CollectRun> {
  const config = await loadConfig(cwd, configFile, { fresh });
  const collect = { ...config.collect, ...options?.collect };
  const result = await runCollect({
    cwd,
    config,
    collect,
    check,
    now: now(),
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

export type ChangeCycle = {
  readonly message: string | undefined;
  readonly written: readonly string[];
  readonly sources: readonly string[];
  readonly inputs: readonly string[];
};

export type ChangeScheduler = {
  /** Runs one cycle now. `"run"` is a direct call; `"change"` is a file change. */
  readonly run: () => Promise<string | undefined>;
  /** Schedules a cycle for a changed file, unless the last cycle wrote it. */
  readonly changed: (file: string | undefined) => void;
  /** Watches the source folders and the input files the last cycle named. */
  readonly watch: () => void;
  readonly close: () => void;
};

/**
 * One debounce, one pending bit and one running drain. `collect --watch`,
 * `generate --watch`, the Next plugin and the unplugin all use it.
 */
export function createChangeScheduler(options: {
  readonly cwd: string;
  readonly cycle: (reason: "run" | "change") => Promise<ChangeCycle>;
  readonly report?: (message: string | undefined) => void;
  readonly initialSources?: readonly string[];
}): ChangeScheduler {
  const log = options.report ?? report;
  let ignored: ReadonlySet<string> = new Set();
  let inputs: readonly string[] = [];
  let sources: readonly string[] = [...(options.initialSources ?? [])];
  let running = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchingSince = 0;
  const watchers: FSWatcher[] = [];

  const tempSuffix = `.permdock-${String(process.pid)}.tmp`;

  /** The file itself, or the temp name `writeFileEnsuringDir` renames onto it. */
  function ownWrite(file: string): boolean {
    if (ignored.has(file)) {
      return true;
    }
    return (
      file.endsWith(tempSuffix) &&
      ignored.has(file.slice(0, -tempSuffix.length))
    );
  }

  function apply(result: ChangeCycle): string | undefined {
    ignored = new Set(result.written.map((file) => resolve(options.cwd, file)));
    inputs = result.inputs;
    sources = result.sources;
    return result.message;
  }

  async function run(): Promise<string | undefined> {
    return apply(await options.cycle("run"));
  }

  async function drain(): Promise<void> {
    running = true;
    while (pending) {
      pending = false;
      try {
        log(apply(await options.cycle("change")));
      } catch (error) {
        log(describeError(error));
      }
    }
    running = false;
  }

  function changed(file: string | undefined): void {
    if (file !== undefined) {
      const resolved = resolve(options.cwd, file);
      if (ownWrite(resolved) || unchangedSinceWatch(resolved)) {
        return;
      }
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

  /**
   * FSEvents can report a write that finished before `watch()` ran. The file's
   * mtime is then older than the watcher, so it is not a new edit.
   */
  function unchangedSinceWatch(file: string): boolean {
    if (watchingSince === 0) {
      return false;
    }
    try {
      return statSync(file).mtimeMs < watchingSince;
    } catch {
      return false;
    }
  }

  function startWatch(): void {
    if (watchers.length > 0) {
      return;
    }
    watchingSince = Date.now();
    for (const dir of sources) {
      watchDir(dir, true, () => true);
    }
    const loose = inputs.filter((file) => !within(sources, file));
    const dirs = new Set([options.cwd, ...loose.map((file) => dirname(file))]);
    for (const dir of dirs) {
      watchDir(
        dir,
        false,
        (file) =>
          loose.includes(file) ||
          (dir === options.cwd && isConfigFile(basename(file))),
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

export function createCollectScheduler(
  cwd: string,
  options: PermDockPluginOptions | undefined,
  settings?: CollectSettings,
): CollectScheduler {
  let loaded = false;
  let check = false;
  const scheduler = createChangeScheduler({
    cwd,
    initialSources: (options?.collect?.srcPath ?? defaultSrcPath()).map(
      (entry) => watchRoot(cwd, entry),
    ),
    ...(settings?.report === undefined ? {} : { report: settings.report }),
    cycle: async (reason) => {
      const fresh = loaded;
      loaded = true;
      const result = await collectOnce(
        cwd,
        options,
        reason === "run" ? check : false,
        fresh,
        settings?.configFile,
        settings?.now,
      );
      return {
        message: result.message,
        written: result.written,
        sources: result.sources,
        inputs: result.inputs,
      };
    },
  });
  return {
    run: (next) => {
      check = next;
      return scheduler.run();
    },
    changed: scheduler.changed,
    watch: scheduler.watch,
    close: scheduler.close,
  };
}

/**
 * `collect --watch`: one collect now, then one per change until Ctrl-C. Under
 * `--json` each collect is an NDJSON event on stdout; otherwise a line on
 * stderr.
 */
export async function watchCollect(
  ctx: CliContext,
  overrides: CollectConfig,
): Promise<CommandResult> {
  const emit = (status: "success" | "error", message: string): void => {
    if (ctx.json) {
      ctx.io.stdout(
        `${JSON.stringify({ event: "collect", status, message, at: dateAt().toISOString() })}\n`,
      );
    } else {
      ctx.log(message);
    }
  };
  const scheduler = createCollectScheduler(
    ctx.cwd,
    { collect: overrides },
    {
      ...(ctx.configFile === undefined ? {} : { configFile: ctx.configFile }),
      report: (message) => {
        emit(
          message === undefined ? "success" : "error",
          message ?? "catalog updated",
        );
      },
    },
  );
  try {
    const message = await scheduler.run(false);
    emit(
      message === undefined ? "success" : "error",
      message ?? "catalog written",
    );
  } catch (error) {
    emit("error", describeError(error));
  }
  scheduler.watch();
  ctx.signal.addEventListener("abort", () => {
    scheduler.close();
  });
  ctx.log("watching for changes; Ctrl-C to stop");
  return { code: 0, output: "", streamed: true };
}
