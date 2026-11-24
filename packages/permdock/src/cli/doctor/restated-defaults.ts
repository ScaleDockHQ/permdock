import { readFileSync } from "node:fs";

import type { DoctorFinding } from "../shared/doctor-types.ts";
import type { PermDockConfig } from "../types.ts";

import { configFileIn, readParsedConfig } from "../project/config.ts";
import { restatedDefaults } from "../project/resolve-config.ts";
import { configProperty } from "../source/config-paths.ts";

/** PD120: a config key set to the value its command uses when it is unset. */
export function pd120(config: PermDockConfig): readonly DoctorFinding[] {
  return restatedDefaults(config).map((entry) => {
    const name = entry.path.join(".");
    return {
      code: "PD120",
      severity: "warning" as const,
      target: name,
      message: `permdock.config sets ${name} to ${JSON.stringify(entry.value)}, its default`,
      fix: "run permdock codemod config --prune, which removes it after checking that every generated file stays the same",
    };
  });
}

/**
 * PD120 on the config file as written: the loaded config carries values the
 * better-supabase defaults filled, which the file never set.
 */
export async function pd120InProject(
  cwd: string,
): Promise<readonly DoctorFinding[]> {
  const file = configFileIn(cwd);
  if (file === undefined) {
    return [];
  }
  try {
    const text = readFileSync(file, "utf8");
    return pd120((await readParsedConfig(cwd, file)).config).filter(
      (finding) =>
        finding.target === undefined ||
        configProperty(file, text, finding.target.split(".")) !== undefined,
    );
  } catch {
    return [];
  }
}
