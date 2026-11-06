import type { EmittedFile, EmitSource, PluginTask } from "../plugin.ts";
import type { RlsPluginOptions } from "./rls.ts";

import { CliError } from "../../core/errors.ts";
import { runRlsGenerate } from "../../rls/generate.ts";
import { applyRlsPlugin } from "./rls-options.ts";

const io = {
  stdout(): void {
    return undefined;
  },
  stderr(): void {
    return undefined;
  },
};

/**
 * The SQL `rls()` would write, without writing it. The pipeline writes the
 * files.
 */
export async function filesForRls(
  task: PluginTask,
  options: RlsPluginOptions,
  source: EmitSource | undefined,
): Promise<readonly EmittedFile[]> {
  if (source === undefined) {
    return [];
  }
  const applied = applyRlsPlugin(source.config.rls, options);
  const outcome = await runRlsGenerate({
    cwd: source.cwd,
    config: { ...source.config, rls: applied.config },
    target: applied.target,
    dialect: applied.dialect ?? "supabase",
    out: applied.out ?? task.out,
    rbac: applied.rbac,
    check: false,
    skipClosures: false,
    inlineFunctions: applied.config.inlineFunctions === true,
    force: applied.config.force === true,
    policyPerRole: applied.config.policyPerRole === true,
    customRoles: applied.config.customRoles === true,
    capabilities: applied.config.capabilities === true,
    helpersOnly: applied.config.helpersOnly === true,
    shims: applied.config.shims === true,
    revokeColumns: applied.config.revokeColumns === true,
    write: false,
    listFiles: true,
    io,
    ...(applied.split === undefined ? {} : { split: applied.split }),
    ...(applied.schemas === undefined ? {} : { schemas: applied.schemas }),
    ...(applied.seedsOut === undefined ? {} : { seedsOut: applied.seedsOut }),
    ...(applied.backfillOut === undefined
      ? {}
      : { backfillOut: applied.backfillOut }),
    ...(applied.noSeeds ? { noSeeds: true } : {}),
    ...(applied.grantsOut === undefined
      ? {}
      : { grantsOut: applied.grantsOut }),
    ...(applied.config.fields === undefined
      ? {}
      : { fields: applied.config.fields }),
    ...(applied.config.gucPrefix === undefined
      ? {}
      : { gucPrefix: applied.config.gucPrefix }),
    ...(applied.config.policyName === undefined
      ? {}
      : { policyName: applied.config.policyName }),
  });
  if (outcome.code !== 0) {
    throw new CliError(
      outcome.code === 2 ? "usage" : "failed",
      outcome.output,
      { code: outcome.code === 2 ? "config_invalid" : "check_failed" },
    );
  }
  return (
    outcome.files ?? [{ path: applied.out ?? task.out, contents: outcome.text }]
  );
}
