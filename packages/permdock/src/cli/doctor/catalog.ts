import type { DoctorFinding, DoctorInput } from "../shared/doctor-types.ts";
import type { CliIo } from "../types.ts";

import { runUsage } from "../usage.ts";
import { collectedOf, policyOf } from "./inputs.ts";

export async function pd002(
  input: DoctorInput & { readonly now: Date; readonly io: CliIo },
): Promise<readonly DoctorFinding[]> {
  const collected = await collectedOf(input);
  if (collected.scan === undefined) {
    return [];
  }
  return collected.scan.unknown.map((usage) => ({
    code: "PD002",
    severity: "error" as const,
    message: `unknown permission ${usage.call} at ${usage.file}:${String(usage.line)}`,
    fix: "use a defined permission reference",
  }));
}

export async function pd003(
  input: DoctorInput & { readonly now: Date; readonly io: CliIo },
): Promise<readonly DoctorFinding[]> {
  if (input.config.policy === undefined) {
    return [];
  }
  const usage = await runUsage({
    cwd: input.cwd,
    config: input.config,
    ignore: [],
    strict: false,
    json: true,
    dynamicAsUsed: false,
    now: input.now,
    io: input.io,
    collected: () => collectedOf(input),
    policy: () => policyOf(input),
  });
  if (usage.code === 2) {
    return [];
  }
  // SAFETY: runUsage with json: true and a code other than 2 prints its report with ungranted.
  const report = JSON.parse(usage.output) as {
    readonly ungranted: readonly {
      readonly key: string;
      readonly detail: string;
    }[];
  };
  return report.ungranted.map((item) => ({
    code: "PD003",
    severity: "warning" as const,
    message: `${item.key} is used but never granted (${item.detail})`,
    fix: "add an allow() with a to: selector, or a role() binding, in definePolicy",
  }));
}

export async function pd004(
  input: DoctorInput & { readonly now: Date; readonly io: CliIo },
): Promise<readonly DoctorFinding[]> {
  const collected = await collectedOf(input);
  if (collected.code === 0) {
    return [];
  }
  if (collected.code === 2) {
    return [];
  }
  return [
    {
      code: "PD004",
      severity: "error",
      message: collected.message,
      fix: "pnpm exec permdock collect",
    },
  ];
}
