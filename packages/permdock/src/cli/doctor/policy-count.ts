import type { DoctorFinding, DoctorInput } from "../shared/doctor-types.ts";

import { isRecord } from "../../core/compact.ts";
import { betterSupabaseConfig } from "../project/better-supabase.ts";
import { POLICIES_MAX, policiesFor, rlsReport } from "../rls/report.ts";
import { SqlSyntaxError } from "../sql/ast.ts";

const COMMANDS = ["select", "insert", "update", "delete"] as const;

/**
 * Whether better-supabase's doctor runs PermDock's through BS705, where BS641
 * reports the same count.
 */
async function underBetterSupabaseDoctor(input: DoctorInput): Promise<boolean> {
  const config = await betterSupabaseConfig({
    cwd: input.cwd,
    ...(input.files === undefined ? {} : { files: input.files }),
    ...(input.config.betterSupabase?.config === undefined
      ? {}
      : { path: input.config.betterSupabase.config }),
  });
  const authorization: unknown = config?.["authorization"];
  const doctor: unknown = isRecord(authorization)
    ? authorization["doctor"]
    : undefined;
  return isRecord(doctor) && Array.isArray(doctor["command"]);
}

/**
 * PD131: a table with more than `doctor.policies.max` policies for one command
 * and `authenticated`, better-supabase BS641's count and default.
 */
export async function pd131(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
  if (await underBetterSupabaseDoctor(input)) {
    return [];
  }
  const max = input.config.doctor?.policies?.max ?? POLICIES_MAX;
  let report: Awaited<ReturnType<typeof rlsReport>>;
  try {
    report = await rlsReport({ cwd: input.cwd, config: input.config });
  } catch (error) {
    if (error instanceof SqlSyntaxError) {
      return [];
    }
    throw error;
  }
  return report.tables.flatMap((table) =>
    COMMANDS.flatMap((command) => {
      const policies = policiesFor(table, command);
      if (policies.length <= max) {
        return [];
      }
      const listed = policies
        .map(
          (policy) =>
            `${policy.name} (${policy.permissive ? "permissive" : "restrictive"}, ${policy.origin})`,
        )
        .join(", ");
      return [
        {
          code: "PD131",
          severity: "warning" as const,
          target: `${table.table}:${command}`,
          message: `${table.table} has ${String(policies.length)} ${command} policies for authenticated, more than doctor.policies.max (${String(max)}): ${listed}`,
          fix: "fold the provider or app policies into fewer conditions; permdock rls report lists the helper calls each one adds per statement",
        },
      ];
    }),
  );
}
