import type { EmittedFile, EmitSource, PluginTask } from "../plugin.ts";
import type { RlsPluginOptions } from "./rls.ts";

import { CliError } from "../../core/errors.ts";
import { runRlsGenerate } from "../../rls/generate.ts";

const io = {
  stdout(): void {
    return undefined;
  },
  stderr(): void {
    return undefined;
  },
};

/**
 * The SQL `rls generate` would write, without writing it. The pipeline writes
 * the file.
 */
export async function filesForRls(
  task: PluginTask,
  options: RlsPluginOptions,
  source: EmitSource | undefined,
): Promise<readonly EmittedFile[]> {
  if (source === undefined) {
    return [];
  }
  const { out, ...rls } = options;
  const outcome = await runRlsGenerate({
    cwd: source.cwd,
    config: { ...source.config, rls: { ...source.config.rls, ...rls } },
    target: "sql",
    dialect: rls.dialect ?? source.config.rls?.dialect ?? "supabase",
    out: out ?? task.out,
    rbac: false,
    check: false,
    skipClosures: false,
    inlineFunctions: rls.inlineFunctions === true,
    write: false,
    io,
  });
  if (outcome.code !== 0) {
    throw new CliError(
      outcome.code === 2 ? "usage" : "failed",
      outcome.output,
      { code: outcome.code === 2 ? "config_invalid" : "check_failed" },
    );
  }
  return [{ path: task.out, contents: outcome.text }];
}
