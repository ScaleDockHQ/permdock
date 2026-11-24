import { resolve } from "node:path";

import type { DoctorFinding, ReportedFinding } from "../shared/doctor-types.ts";
import type { PermDockConfig } from "../types.ts";
import type { AcceptedFinding, BaselineEntry } from "./baseline-file.ts";

import { CliError } from "../core/errors.ts";
import { applyFiles } from "../core/files.ts";
import { splitIgnored } from "../core/ignores.ts";
import {
  applyBaseline,
  baselineText,
  readBaseline,
  updatedBaseline,
} from "./baseline-file.ts";

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

export type IgnoredFinding = AcceptedFinding;

/**
 * Applies `doctor.baseline` and `--ignore` to one run. With `update` it first
 * rewrites the baseline to accept this run's errors and warnings, and `wrote`
 * names the file.
 */
export function settleBaseline(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly findings: readonly ReportedFinding[];
  readonly judged: (code: string) => boolean;
  readonly ignore: readonly string[];
  readonly update: boolean;
}): {
  readonly findings: readonly ReportedFinding[];
  readonly ignored: readonly IgnoredFinding[];
  readonly wrote?: string;
} {
  const path = input.config.doctor?.baseline;
  if (path === undefined) {
    if (input.update) {
      throw new CliError(
        "usage",
        "--update-baseline rewrites doctor.baseline; set it to a file such as doctor-baseline.json first",
      );
    }
    return applyDoctorBaseline(
      input.findings,
      { path: "doctor.baseline", entries: [] },
      input.judged,
      input.ignore,
    );
  }
  let entries = readBaseline(input.cwd, path);
  if (input.update) {
    entries = updatedBaseline(input.findings, entries, input.judged);
    applyFiles(input.cwd, [
      { path: resolve(input.cwd, path), text: baselineText(entries) },
    ]);
  }
  const applied = applyDoctorBaseline(
    input.findings,
    { path, entries },
    input.judged,
    input.ignore,
  );
  return input.update ? { ...applied, wrote: path } : applied;
}

/**
 * Splits `findings` by the `doctor.baseline` entries, then by `--ignore` for
 * this run. A stale or unexplained baseline entry comes back as an error.
 */
export function applyDoctorBaseline(
  findings: readonly ReportedFinding[],
  baseline: {
    readonly path: string;
    readonly entries: readonly BaselineEntry[];
  },
  judged: (code: string) => boolean,
  flags: readonly string[],
): {
  readonly findings: readonly ReportedFinding[];
  readonly ignored: readonly IgnoredFinding[];
} {
  const applied = applyBaseline(
    findings,
    baseline.entries,
    judged,
    baseline.path,
  );
  const split = splitIgnored(
    applied.findings,
    (item) => item.id,
    flags.map((id) => ({ id, reason: "--ignore" })),
  );
  return {
    findings: split.kept,
    ignored: [
      ...applied.accepted,
      ...split.ignored.map((entry) => ({
        id: entry.id,
        reason: entry.reason,
        message: entry.item.message,
      })),
    ],
  };
}
