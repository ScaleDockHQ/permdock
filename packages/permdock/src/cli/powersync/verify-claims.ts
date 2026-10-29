import type { CustomRole, Policy } from "../../index.ts";
import type { ClaimsChangeFixture } from "../fixtures.ts";
import type { PermDockConfig } from "../types.ts";
import type { PowerSyncPlan, PowerSyncStream } from "./streams.ts";

import { isRecord } from "../../core/compact.ts";
import {
  findPermission,
  getPermDock,
  memoryCustomRoleSource,
} from "../../index.ts";
import { fixtureSubject } from "../fixtures.ts";
import { canFixture } from "../rls/verify.ts";

type Query = (sql: string, values: unknown[]) => Promise<readonly unknown[]>;

function text(row: unknown, key: string): string | undefined {
  const value = isRecord(row) ? row[key] : undefined;
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
    ? String(value)
    : undefined;
}

function changedClaims(fixture: ClaimsChangeFixture): ReadonlySet<string> {
  const before = fixture.subject.claims ?? {};
  const after = fixture.after.claims ?? before;
  return new Set(
    [...Object.keys(before), ...Object.keys(after)].filter(
      (name) => JSON.stringify(before[name]) !== JSON.stringify(after[name]),
    ),
  );
}

/** The rows the stream syncs to the user with these claims, by id. */
async function rowsFor(
  query: Query,
  stream: PowerSyncStream,
  user: string,
  claims: Readonly<Record<string, unknown>>,
): Promise<ReadonlyMap<string, unknown>> {
  const rows = new Map<string, unknown>();
  for (const sql of stream.queries) {
    // Every parameter is typed in the outer query, so a stream query that uses none still prepares.
    for (const row of await query(
      `select q.* from (${sql}) q where $1::text is not null and $2::jsonb is not null`,
      [user, JSON.stringify(claims)],
    )) {
      const id = text(row, stream.id);
      if (id !== undefined) {
        rows.set(id, row);
      }
    }
  }
  return rows;
}

/**
 * Check a claims change against every stream that reads a changed claim, or the
 * fixture's `stream`.
 */
export async function verifyClaimsChange(input: {
  readonly policy: Policy;
  readonly config: PermDockConfig;
  readonly customRoles: readonly CustomRole[];
  readonly plan: PowerSyncPlan;
  readonly fixture: ClaimsChangeFixture;
  readonly root: string | undefined;
  readonly query: Query;
  readonly mismatches: string[];
}): Promise<void> {
  const { fixture, plan, mismatches } = input;
  const label = `claims change for ${fixture.subject.id}`;
  const changed = changedClaims(fixture);
  const streams =
    fixture.stream === undefined
      ? plan.streams.filter((stream) =>
          stream.claims.some((name) => changed.has(name)),
        )
      : plan.streams.filter((stream) => stream.name === fixture.stream);
  if (streams.length === 0) {
    mismatches.push(
      fixture.stream === undefined
        ? `${label}: no stream reads a changed claim`
        : `${label}: no stream named ${fixture.stream}`,
    );
    return;
  }
  const action = input.config.powersync?.action ?? "read";
  const subject = { ...fixture.subject, ...fixture.after };
  for (const stream of streams) {
    const before = await rowsFor(
      input.query,
      stream,
      fixture.subject.id,
      fixture.subject.claims ?? {},
    );
    const after = await rowsFor(
      input.query,
      stream,
      fixture.subject.id,
      subject.claims ?? {},
    );
    if (
      before.size === after.size &&
      [...before.keys()].every((id) => after.has(id))
    ) {
      mismatches.push(
        `${label}: stream ${stream.name} syncs the same rows before and after the change`,
      );
    }
    const permission = findPermission(
      input.policy.permissions,
      `${stream.resource}.${action}`,
    );
    if (permission === undefined) {
      continue;
    }
    for (const [id, row] of after) {
      // A stream holds rows of every organization the user belongs to, so the
      // policy is asked with the row's own organization active.
      const tenant =
        input.root === undefined ? undefined : text(row, input.root);
      const permdock = await getPermDock(
        input.policy,
        fixtureSubject({
          ...subject,
          ...(tenant === undefined ? {} : { tenant }),
        }),
        { customRoles: memoryCustomRoleSource(input.customRoles) },
      );
      if (!canFixture(permdock, permission, row)) {
        mismatches.push(
          `${label}: stream ${stream.name} syncs ${stream.table} row ${id} after the change, which the policy denies`,
        );
      }
    }
  }
}
