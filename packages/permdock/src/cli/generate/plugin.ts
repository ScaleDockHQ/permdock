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
};

/** One unit of emit. `out` is the file the task owns, relative to the project. */
export type PluginTask = { readonly id: string; readonly out: string };

export type EmittedFile = { readonly path: string; readonly contents: string };

export type PluginInputs = {
  readonly files: readonly string[];
  readonly options: unknown;
};

/**
 * A generate plugin. `emit` is pure in `task` and `model`: it reads no project
 * files except what `inputs` named. `after` is ordering only.
 */
export type PermDockPlugin = {
  readonly name: string;
  readonly version: string;
  readonly after: readonly string[];
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
  ) => readonly EmittedFile[] | Promise<readonly EmittedFile[]>;
};

export type PluginInit = {
  readonly name: string;
  readonly version: string;
  readonly after?: readonly string[];
  readonly inputs?: PermDockPlugin["inputs"];
  readonly plan: PermDockPlugin["plan"];
  readonly emit: PermDockPlugin["emit"];
};

function emptyInputs(): PluginInputs {
  return { files: [], options: undefined };
}

/** Freezes a plugin. The factory records options; `emit` loads the work. */
export function definePlugin(init: PluginInit): PermDockPlugin {
  return Object.freeze({
    name: init.name,
    version: init.version,
    after: Object.freeze([...(init.after ?? [])]),
    inputs: init.inputs ?? emptyInputs,
    plan: init.plan,
    emit: init.emit,
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
  const byName = new Map<string, PermDockPlugin>();
  for (const plugin of plugins) {
    if (byName.has(plugin.name)) {
      throw new Error(`PermDock: duplicate plugin '${plugin.name}'`);
    }
    byName.set(plugin.name, plugin);
  }
  const remaining = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const plugin of plugins) {
    const present = plugin.after.filter((name) => byName.has(name));
    remaining.set(plugin.name, present.length);
    for (const dep of present) {
      const list = dependents.get(dep) ?? [];
      list.push(plugin.name);
      dependents.set(dep, list);
    }
  }
  const ready = plugins
    .filter((plugin) => (remaining.get(plugin.name) ?? 0) === 0)
    .map((plugin) => plugin.name);
  const ordered: PermDockPlugin[] = [];
  while (ready.length > 0) {
    const name = ready.shift();
    if (name === undefined) {
      break;
    }
    const plugin = byName.get(name);
    if (plugin === undefined) {
      break;
    }
    ordered.push(plugin);
    for (const next of dependents.get(name) ?? []) {
      const count = (remaining.get(next) ?? 0) - 1;
      remaining.set(next, count);
      if (count === 0) {
        ready.push(next);
      }
    }
  }
  if (ordered.length !== plugins.length) {
    throw new Error("PermDock: plugin after edges cycle");
  }
  return ordered;
}
