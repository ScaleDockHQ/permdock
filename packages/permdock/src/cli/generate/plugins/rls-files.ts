import type { EmittedFile, EmitSource, PluginTask } from "../plugin.ts";
import type { RlsPluginOptions } from "./rls.ts";

import { isSeeds } from "../../../core/seeds.ts";
import { dateAt } from "../../../core/time.ts";
import { CliError } from "../../core/errors.ts";
import { seedsMigration } from "../../core/output-files.ts";
import {
  DEFAULTS_MARKER,
  FIXTURES_PATH,
  defaultsSeedSql,
  fixturesPresent,
  fixturesSeedSql,
} from "../../rls/emit/seed-sql.ts";
import { runRlsGenerate } from "../../rls/generate.ts";
import { noted } from "../plugin.ts";
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
    // Split without an out uses the schema layout. A single file uses the task path.
    ...(applied.out !== undefined || applied.split === undefined
      ? { out: applied.out ?? task.out }
      : {}),
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
    ...(applied.tenantType === undefined
      ? {}
      : { tenantType: applied.tenantType }),
    ...(source.db === undefined ? {} : { db: source.db }),
  });
  if (outcome.code !== 0) {
    throw new CliError(
      outcome.code === 2 ? "usage" : "failed",
      outcome.output,
      { code: outcome.code === 2 ? "config_invalid" : "check_failed" },
    );
  }
  const files: EmittedFile[] = [
    ...(outcome.files ?? [
      { path: applied.out ?? task.out, contents: outcome.text },
    ]),
  ];
  const seeds = source.config.seeds;
  if (!isSeeds(seeds)) {
    return files;
  }
  const schema = applied.config.schema ?? "permdock";
  const mode = applied.config.seeds;
  if (
    !applied.noSeeds &&
    mode !== "function" &&
    mode !== "view" &&
    seeds.defaults.roles.length > 0
  ) {
    const text = defaultsSeedSql(seeds, schema);
    const planned = seedsMigration(
      source.cwd,
      "supabase/migrations",
      DEFAULTS_MARKER,
      text,
      dateAt(),
      "defaults",
    );
    if (!planned.current) {
      files.push({ path: planned.rel, contents: text });
    }
  }
  if (fixturesPresent(seeds)) {
    files.push({ path: FIXTURES_PATH, contents: fixturesSeedSql(seeds) });
  }
  return noted(files, outcome.output === "" ? [] : outcome.output.split("\n"));
}
