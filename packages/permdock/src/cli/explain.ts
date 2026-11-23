import type { MatchedGrant, TraceSkip } from "../core/decision.ts";
import type { Policy } from "../index.ts";
import type { CommandResult } from "./core/result.ts";

import {
  findPermission,
  getPermDock,
  memoryCustomRoleSource,
} from "../index.ts";
import { configError } from "./core/errors.ts";
import { fixtureRow, fixtureSubject, loadFixtures } from "./fixtures.ts";

type ExplainGrant = {
  readonly role: string | null;
  readonly permission: string;
  readonly name?: string;
};

type ExplainRow = {
  readonly subject: string;
  readonly tenant?: string;
  readonly outcome: "granted" | "denied" | "approval-required";
  /** The fixture's `expected`, when it differs from `outcome`. */
  readonly expected?: "granted" | "denied";
  /** The allow that granted or asked for approval. */
  readonly matched?: ExplainGrant;
  readonly denials?: readonly string[];
  readonly evaluated: number;
  readonly allows: readonly ExplainGrant[];
  readonly denies: readonly ExplainGrant[];
  readonly skipped: readonly TraceSkip[];
};

export type ExplainReport = {
  readonly action: string;
  readonly rows: readonly ExplainRow[];
};

function grantOf(grant: MatchedGrant): ExplainGrant {
  return {
    role: grant.role,
    permission: grant.permission,
    ...(grant.name === undefined ? {} : { name: grant.name }),
  };
}

function describe(grant: ExplainGrant): string {
  const label = grant.name === undefined ? "" : ` "${grant.name}"`;
  return `${grant.role ?? "(direct)"}${label}`;
}

/**
 * Every fixture for `action`, decided with `explain: true` against `policy`:
 * which grants matched, which deny won and which grants were passed over.
 */
async function explainAction(input: {
  readonly cwd: string;
  readonly policy: Policy;
  readonly action: string;
  readonly fixtures: string;
  readonly now: Date;
}): Promise<ExplainReport> {
  const permission = findPermission(input.policy.permissions, input.action);
  if (permission === undefined) {
    throw configError(
      `PermDock CLI: explain: the policy declares no permission '${input.action}'`,
    );
  }
  const { fixtures, customRoles } = await loadFixtures(
    input.cwd,
    input.fixtures,
  );
  const now = {
    epochMilliseconds: Math.floor(input.now.getTime() / 1000) * 1000,
  };
  const rows: ExplainRow[] = [];
  for (const fixture of fixtures) {
    if (fixture.action !== input.action) {
      continue;
    }
    const permdock = await getPermDock(
      input.policy,
      fixtureSubject(fixture.subject),
      { customRoles: memoryCustomRoleSource(customRoles) },
    );
    const decision = permdock.explain(
      permission,
      fixtureRow(fixture, permission.kind),
      { now },
    );
    const matched =
      decision.outcome === "granted"
        ? decision.matched
        : decision.outcome === "approval-required"
          ? decision.grant
          : undefined;
    rows.push({
      subject: fixture.subject.id,
      ...(fixture.subject.tenant === undefined
        ? {}
        : { tenant: fixture.subject.tenant }),
      outcome: decision.outcome,
      ...(fixture.expected === undefined ||
      fixture.expected === decision.outcome
        ? {}
        : { expected: fixture.expected }),
      ...(matched === undefined ? {} : { matched: grantOf(matched) }),
      ...(decision.outcome === "denied"
        ? { denials: decision.denials.map((denial) => denial.reason) }
        : {}),
      evaluated: decision.trace.evaluated,
      allows: decision.trace.allows.map(grantOf),
      denies: decision.trace.denies.map(grantOf),
      skipped: decision.trace.skipped,
    });
  }
  return { action: input.action, rows };
}

function formatExplain(report: ExplainReport): string {
  if (report.rows.length === 0) {
    return `explain: no fixture checks ${report.action}`;
  }
  const lines = [`${report.action}: ${String(report.rows.length)} fixture(s)`];
  for (const row of report.rows) {
    const who =
      row.tenant === undefined
        ? row.subject
        : `${row.subject} in ${row.tenant}`;
    const by = row.matched === undefined ? "" : ` by ${describe(row.matched)}`;
    const reasons =
      row.denials === undefined ? "" : ` (${row.denials.join(", ")})`;
    const mismatch =
      row.expected === undefined ? "" : `, expected ${row.expected}`;
    lines.push(
      `${who}: ${row.outcome}${by}${reasons}${mismatch}; ${String(row.evaluated)} grant(s) evaluated`,
    );
    for (const deny of row.denies) {
      lines.push(`  deny matched: ${describe(deny)}`);
    }
    const matched = row.matched === undefined ? "" : describe(row.matched);
    for (const allow of row.allows) {
      if (describe(allow) !== matched) {
        lines.push(`  allow matched: ${describe(allow)}`);
      }
    }
    for (const skipped of row.skipped) {
      lines.push(
        `  passed over: ${skipped.role ?? "(direct)"} ${skipped.effect} (${skipped.why})`,
      );
    }
  }
  return lines.join("\n");
}

export async function runExplain(input: {
  readonly cwd: string;
  readonly policy: Policy;
  readonly action: string;
  readonly fixtures: string;
  readonly json: boolean;
  readonly now: Date;
}): Promise<CommandResult> {
  const report = await explainAction(input);
  return {
    code: 0,
    output: input.json ? JSON.stringify(report) : formatExplain(report),
    data: report,
  };
}
