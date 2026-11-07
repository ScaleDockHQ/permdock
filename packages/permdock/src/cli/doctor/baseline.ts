import type { Ignore } from "../core/ignores.ts";
import type { DoctorFinding, ReportedFinding } from "../shared/doctor-types.ts";
import type { PermDockConfig } from "../types.ts";

import { isRecord } from "../../core/compact.ts";
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
 * PD017 waivers, keyed by finding id. A waiver that matches nothing stays a
 * finding.
 */
function waiverReasons(config: PermDockConfig): ReadonlyMap<string, string> {
  const reasons = new Map<string, string>();
  const entries: unknown = config.doctor?.waivers ?? [];
  if (!Array.isArray(entries)) {
    return reasons;
  }
  for (const entry of entries) {
    if (
      isRecord(entry) &&
      entry["code"] === "PD017" &&
      typeof entry["key"] === "string" &&
      typeof entry["reason"] === "string" &&
      entry["reason"].trim() !== ""
    ) {
      reasons.set(`PD017:${entry["key"]}`, entry["reason"]);
    }
  }
  return reasons;
}

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
  const waivers = waiverReasons(config);
  const kept: ReportedFinding[] = [];
  const waived: IgnoredFinding[] = [];
  for (const item of split.kept) {
    const reason = waivers.get(item.id);
    if (item.code === "PD017" && reason !== undefined) {
      waived.push({ id: item.id, reason, message: item.message });
    } else {
      kept.push(item);
    }
  }
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
    findings: [...kept, ...stale],
    ignored: [
      ...split.ignored.map((entry) => ({
        id: entry.id,
        reason: entry.reason,
        message: entry.item.message,
      })),
      ...waived,
    ],
  };
}
