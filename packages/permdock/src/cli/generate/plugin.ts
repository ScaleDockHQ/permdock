import type { Policy } from "../../core/policy-types.ts";
import type { PermDockConfig } from "../types.ts";
import type { ProjectContext } from "./context.ts";
import type { PolicyModel } from "./model.ts";

/**
 * The loaded project. Built-in plugins use it to call the current generators. A
 * third-party plugin ignores it; `emit` stays a function of `task` and `model`
 * when this is absent, which is how a worker runs it.
 */
export type EmitSource = {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly policy: Policy;
  /** `--db-url-stdin`. Index suggestions and hook helper checks read it. */
  readonly db?: string;
};

/** One unit of emit. `out` is the file the task owns, relative to the project. */
export type PluginTask = { readonly id: string; readonly out: string };

export type EmittedFile = { readonly path: string; readonly contents: string };

/**
 * Files plus lines the command prints, such as a doctor code or an index
 * suggestion.
 */
export type NotedFiles = readonly EmittedFile[] & {
  readonly notes?: readonly string[];
};

export type PluginEmit = NotedFiles;

/** Output sink for the generators a plugin calls; the pipeline prints the notes. */
export const quietIo = {
  stdout(): void {
    return undefined;
  },
  stderr(): void {
    return undefined;
  },
};

/** An array the existing callers can map, with `notes` for the command to print. */
export function noted(
  files: readonly EmittedFile[],
  notes: readonly string[],
): NotedFiles {
  if (notes.length === 0) {
    return files;
  }
  return Object.assign([...files], { notes });
}

export type PluginInputs = {
  readonly files: readonly string[];
  readonly options: unknown;
};

/** One doctor finding a plugin reports from the model. */
export type PluginFinding = {
  readonly code: string;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
};

/**
 * A command a plugin adds to the CLI. Declared on the plugin and listed by
 * `permdock generate --help`, and run as `permdock <name>` when no built-in
 * command has that name.
 */
export type PluginCommand = {
  readonly name: string;
  readonly summary: string;
  /**
   * Runs `permdock <name> ...args` in the project. The output goes to stdout
   * and the code is the exit code.
   */
  readonly run?: (input: {
    readonly cwd: string;
    readonly config: PermDockConfig;
    readonly args: readonly string[];
  }) => PluginCommandResult | Promise<PluginCommandResult>;
};

export type PluginCommandResult = {
  readonly code: 0 | 1;
  readonly output: string;
};

/**
 * A generate plugin. `emit` is pure in `task` and `model`: it reads no project
 * files except what `inputs` named. `after` is ordering only. `seeds` returns
 * seed files the plugin owns, written with the emitted files. `doctor` reports
 * findings about the model; the run prints them after the Generated line.
 * `commands` names commands the plugin adds.
 */
export type PermDockPlugin = {
  readonly name: string;
  readonly version: string;
  readonly after: readonly string[];
  /** Names of plugins that write the same output; configuring both throws. */
  readonly conflicts?: readonly string[];
  readonly inputs: (
    ctx: ProjectContext,
  ) => PluginInputs | Promise<PluginInputs>;
  readonly plan: (
    model: PolicyModel,
    ctx: ProjectContext,
  ) => readonly PluginTask[] | Promise<readonly PluginTask[]>;
  readonly emit: (
    task: PluginTask,
    model: PolicyModel,
    source?: EmitSource,
  ) => PluginEmit | Promise<PluginEmit>;
  readonly seeds?: (
    model: PolicyModel,
    ctx: ProjectContext,
  ) => readonly EmittedFile[] | Promise<readonly EmittedFile[]>;
  readonly doctor?: (
    model: PolicyModel,
    ctx: ProjectContext,
  ) => readonly PluginFinding[] | Promise<readonly PluginFinding[]>;
  readonly commands?: readonly PluginCommand[];
};

export type PluginInit = {
  readonly name: string;
  readonly version: string;
  readonly after?: readonly string[];
  readonly conflicts?: readonly string[];
  readonly inputs?: PermDockPlugin["inputs"];
  readonly plan: PermDockPlugin["plan"];
  readonly emit: PermDockPlugin["emit"];
  readonly seeds?: PermDockPlugin["seeds"];
  readonly doctor?: PermDockPlugin["doctor"];
  readonly commands?: PermDockPlugin["commands"];
};

/**
 * Inputs for a plugin that reads the schema directory: the directory feeds the
 * cache key, so a changed schema file is a miss.
 */
export function schemaInputs(
  ctx: ProjectContext,
  options: unknown,
): PluginInputs {
  return { files: ctx.schemaDir === undefined ? [] : [ctx.schemaDir], options };
}

function emptyInputs(): PluginInputs {
  return { files: [], options: undefined };
}

/** Freezes a plugin. The factory records options; `emit` loads the work. */
export function definePlugin(init: PluginInit): PermDockPlugin {
  return Object.freeze({
    name: init.name,
    version: init.version,
    after: Object.freeze([...(init.after ?? [])]),
    ...(init.conflicts === undefined
      ? {}
      : { conflicts: Object.freeze([...init.conflicts]) }),
    inputs: init.inputs ?? emptyInputs,
    plan: init.plan,
    emit: init.emit,
    ...(init.seeds === undefined ? {} : { seeds: init.seeds }),
    ...(init.doctor === undefined ? {} : { doctor: init.doctor }),
    ...(init.commands === undefined
      ? {}
      : { commands: Object.freeze([...init.commands]) }),
  });
}

export function isPermDockPlugin(value: unknown): value is PermDockPlugin {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const name: unknown = Reflect.get(value, "name");
  const version: unknown = Reflect.get(value, "version");
  const plan: unknown = Reflect.get(value, "plan");
  const emit: unknown = Reflect.get(value, "emit");
  return (
    typeof name === "string" &&
    name !== "" &&
    typeof version === "string" &&
    typeof plan === "function" &&
    typeof emit === "function"
  );
}

/**
 * Plugins in `after` order. Ties keep the input order. An `after` name that is
 * not configured is skipped: ordering only, and emit does not require it. A
 * cycle throws; nothing is written when this throws.
 */
export function orderPlugins(
  plugins: readonly PermDockPlugin[],
): readonly PermDockPlugin[] {
  const byName = new Map<
    string,
    { readonly plugin: PermDockPlugin; left: number }
  >();
  for (const plugin of plugins) {
    if (byName.has(plugin.name)) {
      throw new Error(`PermDock: duplicate plugin '${plugin.name}'`);
    }
    byName.set(plugin.name, { plugin, left: 0 });
  }
  for (const plugin of plugins) {
    const clash = (plugin.conflicts ?? []).find((name) => byName.has(name));
    if (clash !== undefined) {
      throw new Error(
        `PermDock: plugin '${plugin.name}' already emits what '${clash}' emits; remove one of them`,
      );
    }
  }
  const dependents = new Map<
    string,
    { readonly plugin: PermDockPlugin; left: number }[]
  >();
  const nodes = [...byName.values()];
  for (const node of nodes) {
    const present = node.plugin.after.filter((name) => byName.has(name));
    node.left = present.length;
    for (const dep of present) {
      const list = dependents.get(dep) ?? [];
      list.push(node);
      dependents.set(dep, list);
    }
  }
  const ready = nodes.filter((node) => node.left === 0);
  const ordered: PermDockPlugin[] = [];
  for (const node of ready) {
    ordered.push(node.plugin);
    for (const next of dependents.get(node.plugin.name) ?? []) {
      next.left -= 1;
      if (next.left === 0) {
        ready.push(next);
      }
    }
  }
  if (ordered.length !== plugins.length) {
    throw new Error("PermDock: plugin after edges cycle");
  }
  return ordered;
}
