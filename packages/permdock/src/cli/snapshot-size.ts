import { gzipSync } from "node:zlib";

import type { Membership, Policy, Principal, Subject } from "../index.ts";
import type { CommandResult } from "./core/result.ts";

import { scopeList } from "../core/scopes.ts";
import { snapshotFor } from "../index.ts";

/** The default budget of the PD112 doctor rule, in bytes of JSON. */
export const SNAPSHOT_BUDGET_BYTES = 65_536;

export type SnapshotPart = {
  readonly part: string;
  readonly bytes: number;
  readonly gzip: number;
};

export type SnapshotSizeReport = {
  readonly role: string;
  readonly scope: string | null;
  readonly tenants: number;
  readonly grants: number;
  readonly parts: readonly SnapshotPart[];
  readonly total: SnapshotPart;
  readonly largest: string;
  /**
   * Bytes of `grants` and `static` per membership of a scoped role; null for a
   * global role.
   */
  readonly perMembership: number | null;
};

const PARTS = [
  "grants",
  "static",
  "conditions",
  "vocabulary",
  "tenants",
  "assignable",
  "subject",
] as const;

function measure(part: string, value: unknown): SnapshotPart {
  const text = JSON.stringify(value);
  return { part, bytes: Buffer.byteLength(text), gzip: gzipSync(text).length };
}

function subjectOf(
  policy: Policy,
  role: string,
  tenants: number,
): { readonly subject: Subject; readonly scope: string | null } | string {
  const binding = policy.roles.find((item) => item.name === role);
  if (binding === undefined) {
    return `unknown role '${role}'; the policy declares ${policy.roles.map((item) => item.name).join(", ")}`;
  }
  const base = { id: "snapshot-size-probe" };
  if (binding.on === undefined) {
    const principal: Principal = { ...base, roles: [role] };
    return { subject: { principal, context: {} }, scope: null };
  }
  if (typeof binding.on !== "string") {
    return `role '${role}' is held on a resource, which snapshot size does not model`;
  }
  const scopes = scopeList(policy.scopes);
  const root = String(scopes[0]?.name);
  const scope = binding.on;
  const memberships: Membership[] = Array.from(
    { length: tenants },
    (_, index) => {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      return scope === root
        ? { scope, id, roles: [role] }
        : { scope, id, within: { [root]: id }, roles: [role] };
    },
  );
  const principal: Principal = { ...base, memberships };
  return { subject: { principal, context: {} }, scope };
}

/**
 * The size of the compact snapshot a probe subject holding `role` gets. The
 * parts are the top-level keys of the wire form; the total is
 * `JSON.stringify(snapshot)`.
 */
export function snapshotSize(input: {
  readonly policy: Policy;
  readonly role: string;
  readonly tenants: number;
  readonly omitAssignable: boolean;
  readonly omitStatic?: boolean;
}): SnapshotSizeReport | string {
  const built = subjectOf(input.policy, input.role, input.tenants);
  if (typeof built === "string") {
    return built;
  }
  const snapshot = snapshotFor(input.policy, built.subject, {
    ...(input.omitAssignable ? { omitAssignable: true } : {}),
    ...(input.omitStatic === true ? { omitStatic: true } : {}),
    ...(built.scope === null ? {} : { tenants: "all" as const }),
  });
  const record: Readonly<Record<string, unknown>> = { ...snapshot };
  const parts = PARTS.filter((name) => record[name] !== undefined).map((name) =>
    measure(name, record[name]),
  );
  let largest: SnapshotPart = { part: "none", bytes: -1, gzip: 0 };
  for (const item of parts) {
    if (item.bytes > largest.bytes) {
      largest = item;
    }
  }
  const repeated = parts
    .filter((item) => item.part === "grants" || item.part === "static")
    .reduce((sum, item) => sum + item.bytes, 0);
  return {
    role: input.role,
    scope: built.scope,
    tenants: built.scope === null ? 0 : input.tenants,
    grants: snapshot.grants.length,
    parts,
    total: measure("total", snapshot),
    largest: largest.part,
    perMembership:
      built.scope === null || input.tenants === 0
        ? null
        : Math.round(repeated / input.tenants),
  };
}

export function runSnapshotSize(input: {
  readonly policy: Policy;
  readonly role: string | undefined;
  readonly tenants: number;
  readonly omitAssignable: boolean;
  readonly omitStatic?: boolean;
  readonly budget: number;
  readonly json: boolean;
}): CommandResult {
  const role = input.role ?? mostPrivilegedRole(input.policy);
  if (role === undefined) {
    return {
      code: 2,
      output: "snapshot size: the policy declares no role to measure",
    };
  }
  const report = snapshotSize({ ...input, role });
  if (typeof report === "string") {
    return { code: 2, output: `snapshot size: ${report}` };
  }
  const over = report.total.bytes > input.budget;
  const lines = [
    `snapshot of ${report.role}: ${String(report.grants)} grants${report.scope === null ? "" : `, ${String(report.tenants)} ${report.scope} memberships`}`,
    ...[...report.parts, report.total].map(
      (item) =>
        `${item.part.padEnd(12)} ${String(item.bytes).padStart(9)} bytes ${String(item.gzip).padStart(9)} gzip`,
    ),
    ...(report.perMembership === null
      ? []
      : [
          `${String(report.perMembership)} bytes of grants per ${report.scope ?? "scope"} membership`,
        ]),
    over
      ? `over the ${String(input.budget)} byte budget; the largest part is ${report.largest}`
      : `within the ${String(input.budget)} byte budget`,
  ];
  return {
    code: 0,
    output: input.json ? JSON.stringify(report) : lines.join("\n"),
    data: { ...report, budget: input.budget, overBudget: over },
  };
}

/** The role with the most grants: the heaviest snapshot the policy can produce. */
export function mostPrivilegedRole(policy: Policy): string | undefined {
  let best: { readonly name: string; readonly grants: number } | undefined;
  for (const role of policy.roles) {
    if (best === undefined || role.grants.length > best.grants) {
      best = { name: role.name, grants: role.grants.length };
    }
  }
  return best?.name;
}
