import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ReportedFinding } from "../shared/doctor-types.ts";

import { isRecord } from "../../core/compact.ts";
import { configError } from "../core/errors.ts";
import { byCodeUnit } from "../shared/compare.ts";

/** One accepted finding: its code, its target and why it stays. */
export type BaselineEntry = {
  readonly code: string;
  readonly target: string;
  readonly reason: string;
};

/**
 * The grouped form better-supabase's `doctor --update-baseline` writes: one
 * entry per code and reason.
 */
export type BaselineGroup = {
  readonly code: string;
  readonly reason: string;
  readonly targets: readonly string[];
};

const text = (value: unknown): value is string => typeof value === "string";

/**
 * Parses a baseline file: grouped `{ code, reason, targets }` entries, or `{
 * code, target, reason }` entries, in any mix, as better-supabase reads it. A
 * missing reason reads as `""`, which `applyBaseline` reports.
 *
 * @throws {CliError} `config_invalid` naming the first entry that is neither.
 */
export function parseBaseline(
  contents: string,
  path: string,
): readonly BaselineEntry[] {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw configError(
      `PermDock CLI: ${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(value)) {
    throw configError(
      `PermDock CLI: ${path} must be an array of { code, reason, targets } entries`,
    );
  }
  return value.flatMap((entry: unknown, index): BaselineEntry[] => {
    if (!isRecord(entry) || !text(entry["code"]) || entry["code"] === "") {
      throw configError(
        `PermDock CLI: ${path} entry ${String(index)} needs a string code`,
      );
    }
    const code = entry["code"];
    const reason = text(entry["reason"]) ? entry["reason"] : "";
    const targets = entry["targets"];
    if (Array.isArray(targets) && targets.every(text)) {
      return targets.map((target) => ({ code, target, reason }));
    }
    if (text(entry["target"])) {
      return [{ code, target: entry["target"], reason }];
    }
    throw configError(
      `PermDock CLI: ${path} entry ${String(index)} needs targets, a list of strings`,
    );
  });
}

/** The entries of `doctor.baseline`; none when the file does not exist yet. */
export function readBaseline(
  cwd: string,
  path: string,
): readonly BaselineEntry[] {
  const file = resolve(cwd, path);
  return existsSync(file)
    ? parseBaseline(readFileSync(file, "utf8"), path)
    : [];
}

const idOf = (code: string, target: string): string => `${code}:${target}`;

export type AcceptedFinding = {
  readonly id: string;
  readonly reason: string;
  readonly message: string;
};

/**
 * Leaves out the findings the baseline lists. An entry without a reason that
 * accepts a finding, and an entry for a check this run judged that matches no
 * finding, each come back as an error, so the file only holds explained,
 * current entries.
 */
export function applyBaseline(
  findings: readonly ReportedFinding[],
  entries: readonly BaselineEntry[],
  judged: (code: string) => boolean,
  path: string,
): {
  readonly findings: readonly ReportedFinding[];
  readonly accepted: readonly AcceptedFinding[];
} {
  const reasons = new Map<string, string>();
  for (const entry of entries) {
    const id = idOf(entry.code, entry.target);
    if (!reasons.has(id)) {
      reasons.set(id, entry.reason);
    }
  }
  const matched = new Set<string>();
  const kept: ReportedFinding[] = [];
  const accepted: AcceptedFinding[] = [];
  for (const finding of findings) {
    const reason = reasons.get(finding.id);
    if (reason === undefined) {
      kept.push(finding);
    } else {
      matched.add(finding.id);
      accepted.push({ id: finding.id, reason, message: finding.message });
    }
  }
  const problems: ReportedFinding[] = [];
  for (const [id, reason] of reasons) {
    const code = id.slice(0, id.indexOf(":"));
    if (matched.has(id) && reason.trim() === "") {
      problems.push({
        code: "baseline-reason",
        severity: "error",
        target: id,
        id: `baseline-reason:${id}`,
        message: `${path} accepts ${id} without a reason`,
        fix: `say in ${path} why the finding is accepted`,
      });
    } else if (!matched.has(id) && judged(code)) {
      problems.push({
        code: "baseline-stale",
        severity: "error",
        target: id,
        id: `baseline-stale:${id}`,
        message: `${path} accepts ${id}, which doctor no longer reports`,
        fix: "remove the entry, or run permdock doctor --update-baseline",
      });
    }
  }
  return { findings: [...kept, ...problems], accepted };
}

/**
 * The baseline that accepts every error and warning of this run. An entry keeps
 * its reason, a new entry takes the reason of another entry with its code or
 * `""`, and entries for checks this run did not judge stay.
 */
export function updatedBaseline(
  findings: readonly ReportedFinding[],
  entries: readonly BaselineEntry[],
  judged: (code: string) => boolean,
): readonly BaselineEntry[] {
  const reasons = new Map(
    entries.map((entry) => [idOf(entry.code, entry.target), entry.reason]),
  );
  const byCode = new Map<string, string>();
  for (const entry of entries) {
    if (entry.reason.trim() !== "" && !byCode.has(entry.code)) {
      byCode.set(entry.code, entry.reason);
    }
  }
  const next = new Map<string, BaselineEntry>();
  for (const finding of findings) {
    if (finding.severity === "info") {
      continue;
    }
    next.set(finding.id, {
      code: finding.code,
      target: finding.target,
      reason: reasons.get(finding.id) ?? byCode.get(finding.code) ?? "",
    });
  }
  for (const entry of entries) {
    const id = idOf(entry.code, entry.target);
    if (!judged(entry.code) && !next.has(id)) {
      next.set(id, entry);
    }
  }
  return [...next.values()];
}

/**
 * The entries as grouped `{ code, reason, targets }`, sorted by code, reason
 * and target so a rewrite only shows what changed.
 */
export function groupBaseline(
  entries: readonly BaselineEntry[],
): readonly BaselineGroup[] {
  const groups = new Map<
    string,
    { code: string; reason: string; targets: string[] }
  >();
  for (const entry of entries) {
    const key = `${entry.code}\u0000${entry.reason}`;
    const group = groups.get(key) ?? {
      code: entry.code,
      reason: entry.reason,
      targets: [],
    };
    if (!group.targets.includes(entry.target)) {
      group.targets.push(entry.target);
    }
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, targets: group.targets.toSorted(byCodeUnit) }))
    .toSorted(
      (a, b) => byCodeUnit(a.code, b.code) || byCodeUnit(a.reason, b.reason),
    );
}

/** The file text `--update-baseline` writes. */
export function baselineText(entries: readonly BaselineEntry[]): string {
  return `${JSON.stringify(groupBaseline(entries), null, 2)}\n`;
}
