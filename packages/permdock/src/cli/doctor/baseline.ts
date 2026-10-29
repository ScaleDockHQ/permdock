import type { Ignore } from "../core/ignores.ts";
import type { DoctorFinding, ReportedFinding } from "../shared/doctor-types.ts";
import type { PermDockConfig } from "../types.ts";

import { parseIgnores, splitIgnored } from "../core/ignores.ts";

const LOCATION = /^([^\s:]+\.[A-Za-z0-9]+):(\d+)\b/u;

/**
 * The finding's target: the one its check set, else the `file:line` its message
 * opens with, else the message's first word when it is a path or a key, else
 * `project`.
 */
function targetOf(finding: DoctorFinding): string {
  if (finding.target !== undefined) {
    return finding.target;
  }
  const match = LOCATION.exec(finding.message);
  if (match?.[0] !== undefined) {
    return match[0];
  }
  const first = finding.message.split(/\s+/u)[0] ?? "";
  return /[./]/u.test(first) ? first : "project";
}

export function reported(finding: DoctorFinding): ReportedFinding {
  const target = targetOf(finding);
  return { ...finding, target, id: `${finding.code}:${target}` };
}

export type IgnoredFinding = Ignore & { readonly message: string };

/**
 * Splits `findings` by `doctor.ignore` and `--ignore`. An entry that matches no
 * finding comes back as an `ignore-stale` warning so the baseline can shrink.
 */
export function applyDoctorIgnores(
  findings: readonly ReportedFinding[],
  config: PermDockConfig,
  flags: readonly string[],
): {
  readonly findings: readonly ReportedFinding[];
  readonly ignored: readonly IgnoredFinding[];
} {
  const ignores = parseIgnores(config.doctor?.ignore, "doctor.ignore", flags);
  const split = splitIgnored(findings, (item) => item.id, ignores);
  const stale = split.stale
    .filter((entry) => entry.reason !== "--ignore")
    .map((entry) =>
      reported({
        code: "ignore-stale",
        severity: "warning",
        target: entry.id,
        message: `ignore entry ${entry.id} matches no finding`,
        fix: "remove it from doctor.ignore",
      }),
    );
  return {
    findings: [...split.kept, ...stale],
    ignored: split.ignored.map((entry) => ({
      id: entry.id,
      reason: entry.reason,
      message: entry.item.message,
    })),
  };
}
