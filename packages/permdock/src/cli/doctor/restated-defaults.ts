import type { DoctorFinding } from "../shared/doctor-types.ts";
import type { PermDockConfig } from "../types.ts";

import { restatedDefaults } from "../project/resolve-config.ts";

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
