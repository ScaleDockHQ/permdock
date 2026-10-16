import type { CatalogDelegation, CatalogGrant } from "../types.ts";
import type { CatalogDiff } from "./diff.ts";

import { canonicalJson } from "../../core/canonical-json.ts";

export function describeGrant(grant: CatalogGrant): string {
  const role = grant.role === null ? "top-level" : `role ${grant.role}`;
  const scope =
    grant.scope === "global"
      ? ""
      : typeof grant.scope === "string"
        ? ` in ${grant.scope}`
        : ` on ${grant.scope.resource}`;
  return `${grant.effect} ${grant.permission} (${role}${scope})`;
}

export function describeDelegation(delegation: CatalogDelegation): string {
  const narrowed = delegation.to.id ?? delegation.to.client;
  const to =
    narrowed === undefined
      ? delegation.to.kind
      : `${delegation.to.kind} ${narrowed}`;
  return `delegation ${canonicalJson(delegation.from)} → ${to} (${delegation.permissions.join(", ")})`;
}

export function formatText(diff: CatalogDiff): string {
  const lines: string[] = [];
  const section = (
    title: string,
    added: readonly string[],
    removed: readonly string[],
    changed: readonly string[] = [],
  ): void => {
    if (added.length === 0 && removed.length === 0 && changed.length === 0) {
      return;
    }
    lines.push(title);
    for (const item of added) {
      lines.push(`  + ${item}`);
    }
    for (const item of removed) {
      lines.push(`  - ${item}`);
    }
    for (const item of changed) {
      lines.push(`  ~ ${item}`);
    }
  };
  section(
    "permissions",
    diff.permissions.added,
    diff.permissions.removed,
    diff.permissions.renamed.map(
      (rename) => `${rename.from} → ${rename.to} (renamed)`,
    ),
  );
  section(
    "levels",
    diff.levels.added.map((item) => `${item.permission}@${item.level}`),
    diff.levels.removed.map((item) => `${item.permission}@${item.level}`),
  );
  section("scopes", diff.scopes.added, diff.scopes.removed);
  section(
    "roles",
    diff.roles.added,
    diff.roles.removed,
    diff.roles.changed.map((name) => `${name}: declaration changed`),
  );
  if (diff.grants === undefined) {
    lines.push(
      "grants: not compared (a catalog was built without its policy; run `permdock collect` with `policy` configured)",
    );
  } else {
    section(
      "grants",
      diff.grants.added.map(describeGrant),
      diff.grants.removed.map(describeGrant),
      diff.grants.changed.map(
        (change) =>
          `${describeGrant(change.after)}: ${change.changes.join(", ")}`,
      ),
    );
  }
  if (diff.delegations !== undefined) {
    section(
      "delegations",
      diff.delegations.added.map(describeDelegation),
      diff.delegations.removed.map(describeDelegation),
      diff.delegations.changed.map(
        (change) =>
          `${describeDelegation(change.after)}: ${change.changes.join(", ")}`,
      ),
    );
  }
  section(
    "operations",
    [],
    [],
    diff.operations.map(
      (finding) =>
        `${[finding.operation, `(${finding.permission})`].join(" ")}: ${
          finding.code === "operation-risk-raised"
            ? `risk ${[finding.previous, finding.risk].join(" → ")}`
            : "approval no longer required"
        }`,
    ),
  );
  if (diff.impact !== undefined) {
    lines.push(
      diff.impact.length === 0
        ? "impact: no fixture changes outcome"
        : `impact (${String(diff.impact.length)} fixture(s) change outcome)`,
    );
    for (const row of diff.impact) {
      const where = row.tenant === undefined ? "" : ` in ${row.tenant}`;
      lines.push(
        `  ${row.subject}${where} ${row.action}: ${row.before} → ${row.after}`,
      );
    }
  }
  if (lines.length === 0) {
    lines.push("no changes");
  }
  if (diff.breaking.length > 0) {
    lines.push(`breaking (${String(diff.breaking.length)})`);
    for (const change of diff.breaking) {
      lines.push(`  ${change.kind}: ${change.detail}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
