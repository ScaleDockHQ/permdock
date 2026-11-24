import { readFileSync } from "node:fs";

import type { DoctorFinding } from "../shared/doctor-types.ts";
import type { PermDockConfig } from "../types.ts";

import { configFileIn, readParsedConfig } from "../project/config.ts";
import { configProperty } from "../source/config-paths.ts";
import {
  membershipDisagreements,
  restatedFacts,
} from "../sql/derive-memberships.ts";

/**
 * PD121: `rls.memberships` or `rls.suspension` says something the membership
 * sources say differently, or restates what they say.
 */
export function pd121(config: PermDockConfig): readonly DoctorFinding[] {
  const differ = membershipDisagreements(config).map((item) => ({
    code: "PD121",
    severity: "warning" as const,
    target: `rls.memberships.scopes.${item.scope}`,
    message:
      item.derived === undefined
        ? `rls.memberships.scopes.${item.scope} maps ${item.written.table}, and the membership source of ${item.scope} is not a table rls.memberships can describe: the helpers and the token hook read different memberships`
        : `rls.memberships.scopes.${item.scope} maps ${item.written.table} differently from its membership source (${item.derived.table}): the helpers and the token hook read different memberships`,
    fix: `delete rls.memberships.scopes.${item.scope}; permdock derives it from the membership source`,
  }));
  const restated = restatedFacts(config).map((path) => {
    const name = path.join(".");
    return {
      code: "PD121",
      severity: "warning" as const,
      target: name,
      message: `${name} restates what the membership sources and supabase.hook.suspension declare`,
      fix: "run permdock codemod config --prune, which removes it after checking that every generated file stays the same",
    };
  });
  return [...differ, ...restated];
}

/**
 * PD121 on the config file as written: the loaded config already carries the
 * tables derived from the sources.
 */
export async function pd121InProject(
  cwd: string,
): Promise<readonly DoctorFinding[]> {
  const file = configFileIn(cwd);
  if (file === undefined) {
    return [];
  }
  try {
    const text = readFileSync(file, "utf8");
    return pd121((await readParsedConfig(cwd, file)).config).filter(
      (finding) =>
        finding.target === undefined ||
        configProperty(file, text, finding.target.split(".")) !== undefined,
    );
  } catch {
    return [];
  }
}
