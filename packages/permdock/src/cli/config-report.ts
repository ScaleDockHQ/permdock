import type { PermDockConfig } from "./types.ts";

import { PERMDOCK_SCHEMA } from "../supabase/sources.ts";
import { catalogPath } from "./catalog-path.ts";
import { barrelFile, guessPermissions } from "./collect.ts";
import { DEFAULT_SENSITIVE_ACTIONS } from "./doctor-collect.ts";
import { MIGRATION_DIRS } from "./doctor-project.ts";
import { defaultSrcPath, rel } from "./files.ts";
import { CONFIG_REPORT_SCHEMA } from "./version.ts";

/** The config as written and the value each command uses where it is unset. */
export type ConfigReport = {
  readonly $schema: typeof CONFIG_REPORT_SCHEMA;
  readonly file: string | null;
  readonly config: PermDockConfig;
  readonly resolved: {
    readonly permissions: string | null;
    readonly policy: string | null;
    readonly srcPath: readonly string[];
    readonly catalog: string;
    readonly barrel: string | false;
    readonly migrations: readonly string[];
    readonly sensitiveActions: readonly string[];
    readonly rlsSchema: string;
  };
  readonly warnings: readonly string[];
};

function configReport(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly file: string | undefined;
  readonly warnings: readonly string[];
}): ConfigReport {
  const { cwd, config } = input;
  const srcPath = config.collect?.srcPath ?? defaultSrcPath();
  const barrel = config.collect?.barrel;
  return {
    $schema: CONFIG_REPORT_SCHEMA,
    file: input.file === undefined ? null : rel(cwd, input.file),
    config,
    resolved: {
      permissions: config.permissions ?? guessPermissions(cwd, srcPath) ?? null,
      policy: config.policy ?? null,
      srcPath,
      catalog: rel(cwd, catalogPath(config, cwd)),
      barrel:
        barrel === undefined || barrel === false ? false : barrelFile(barrel),
      migrations: config.doctor?.migrations ?? MIGRATION_DIRS,
      sensitiveActions:
        config.doctor?.sensitiveActions ?? DEFAULT_SENSITIVE_ACTIONS,
      rlsSchema:
        config.rls?.schema ?? config.rls?.rbac?.schema ?? PERMDOCK_SCHEMA,
    },
    warnings: input.warnings,
  };
}

/** `permdock config`: the config's warnings, or with `--print` or `--json` the effective config. */
export function runConfig(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly file: string | undefined;
  readonly warnings: readonly string[];
  readonly print: boolean;
  readonly json: boolean;
  readonly strict: boolean;
}): { readonly code: 0 | 1; readonly output: string } {
  const report = configReport(input);
  const code = input.strict && report.warnings.length > 0 ? 1 : 0;
  if (input.print || input.json) {
    return { code, output: `${JSON.stringify(report, null, 2)}\n` };
  }
  const lines = [
    report.file === null
      ? "no permdock.config file; every option takes its default"
      : `${report.file}: ${report.warnings.length === 0 ? "ok" : `${String(report.warnings.length)} warning${report.warnings.length === 1 ? "" : "s"}`}`,
    ...report.warnings.map((warning) => `  warn ${warning}`),
  ];
  return { code, output: `${lines.join("\n")}\n` };
}
