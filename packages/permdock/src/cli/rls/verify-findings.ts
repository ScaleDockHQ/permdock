import type { CommandResult, Finding } from "../core/result.ts";
import type { PermDockConfig } from "../types.ts";

import { isRecord } from "../../core/compact.ts";
import { configError } from "../core/errors.ts";
import { DOCS_BASE } from "../core/manifest.ts";

const VERIFY_DOCS = `${DOCS_BASE}/rls#verify`;

/**
 * One difference `rls verify` reports. `table` and `key` make its id stable
 * across runs.
 */
export type RlsFinding = {
  readonly code: string;
  readonly table: string;
  /** The policy, key, role privilege or fixture the finding is about. */
  readonly key: string;
  readonly message: string;
  /** `error` fails the run; `warning` and `info` never do. */
  readonly severity: Finding["severity"];
};

export function rlsFinding(
  code: string,
  table: string,
  key: string,
  message: string,
  severity: Finding["severity"] = "error",
): RlsFinding {
  return { code, table, key, message, severity };
}

/** `<code>:<table>:<key>`: what `--ignore` and `rls.verify.ignore` name. */
export function findingId(finding: RlsFinding): string {
  return `${finding.code}:${finding.table}:${finding.key}`;
}

/** An accepted finding: `rls.verify.ignore` entries, plus one per `--ignore` id. */
export type VerifyIgnore = { readonly id: string; readonly reason: string };

/** `rls.verify.ignore`, checked, then one entry per `--ignore` id. */
export function verifyIgnores(
  config: PermDockConfig,
  flags: readonly string[] = [],
): readonly VerifyIgnore[] {
  const entries: unknown = config.rls?.verify?.ignore ?? [];
  if (!Array.isArray(entries)) {
    throw configError(
      "PermDock CLI: rls.verify.ignore must be a list of { id, reason }",
    );
  }
  const out: VerifyIgnore[] = [];
  for (const [index, entry] of entries.entries()) {
    if (
      !isRecord(entry) ||
      typeof entry["id"] !== "string" ||
      entry["id"] === "" ||
      typeof entry["reason"] !== "string" ||
      entry["reason"].trim() === ""
    ) {
      throw configError(
        `PermDock CLI: rls.verify.ignore[${String(index)}] needs an id and a non-empty reason`,
      );
    }
    out.push({ id: entry["id"], reason: entry["reason"] });
  }
  for (const id of flags) {
    out.push({ id, reason: "--ignore" });
  }
  return out;
}

export type VerifyReport = {
  readonly findings: readonly (RlsFinding & { readonly id: string })[];
  readonly ignored: readonly (VerifyIgnore & { readonly message: string })[];
  /** Ignore entries no finding matched: the baseline can shrink. */
  readonly stale: readonly VerifyIgnore[];
};

/**
 * Splits `findings` by `ignores`; an id listed twice counts once, with its
 * first reason.
 */
function applyIgnores(
  findings: readonly RlsFinding[],
  ignores: readonly VerifyIgnore[],
): VerifyReport {
  const reasons = new Map<string, string>();
  for (const entry of ignores) {
    if (!reasons.has(entry.id)) {
      reasons.set(entry.id, entry.reason);
    }
  }
  const matched = new Set<string>();
  const kept: (RlsFinding & { readonly id: string })[] = [];
  const ignored: (VerifyIgnore & { readonly message: string })[] = [];
  for (const finding of findings) {
    const id = findingId(finding);
    const reason = reasons.get(id);
    if (reason === undefined) {
      kept.push({ ...finding, id });
    } else {
      matched.add(id);
      ignored.push({ id, reason, message: finding.message });
    }
  }
  const stale = [...reasons]
    .filter(([id]) => !matched.has(id))
    .map(([id, reason]) => ({ id, reason }));
  return { findings: kept, ignored, stale };
}

function prefixOf(severity: Finding["severity"]): string {
  switch (severity) {
    case "error":
      return "";
    case "warning":
      return "warning: ";
    case "info":
      return "info: ";
    default: {
      const never: never = severity;
      return never;
    }
  }
}

/**
 * The `rls verify` result: exit 1 when an error finding is left after the
 * ignores. Text lines carry each finding's id; `--json` data is `{ findings,
 * ignored, stale }`; `--format github|sarif` renders `findings`.
 */
export function verifyResult(input: {
  readonly findings: readonly RlsFinding[];
  readonly ignore: readonly VerifyIgnore[];
  /**
   * Lines printed after the findings that are not findings, such as `verified
   * through twin`.
   */
  readonly notes?: readonly string[];
  /** The last line when nothing fails. */
  readonly summary: string;
}): CommandResult {
  const report = applyIgnores(input.findings, input.ignore);
  const failed = report.findings.some((item) => item.severity === "error");
  const lines = [
    ...report.findings.map(
      (item) => `${prefixOf(item.severity)}${item.message} [${item.id}]`,
    ),
    ...report.ignored.map((item) => `ignored ${item.id}: ${item.reason}`),
    ...report.stale.map(
      (item) =>
        `warning: ignore entry ${item.id} matches no finding; remove it from rls.verify.ignore`,
    ),
    ...(failed ? [] : [input.summary]),
    ...(input.notes ?? []),
  ];
  return {
    code: failed ? 1 : 0,
    output: lines.join("\n"),
    data: report,
    findings: [
      ...report.findings.map((item): Finding => ({
        code: item.code,
        id: item.id,
        severity: item.severity,
        message: item.message,
        docs: VERIFY_DOCS,
      })),
      ...report.stale.map((item): Finding => ({
        code: "ignore-stale",
        id: `ignore-stale:${item.id}`,
        severity: "warning",
        message: `ignore entry ${item.id} matches no finding`,
        fix: "remove it from rls.verify.ignore",
        docs: VERIFY_DOCS,
      })),
    ],
  };
}
