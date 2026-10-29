import type { CustomRole, Policy } from "../../index.ts";
import type { FollowedRowFixture } from "../fixtures.ts";
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
import { quoteIdent, quoteQualified } from "../sql/quote.ts";
import { tableNameOf } from "../sql/tables.ts";
import { bare } from "./names.ts";
import { POSTGRES } from "./streams.ts";

/** Check a non-resource row against its own-user rule or readable parents. */
export async function verifyFollowedRow(input: {
  readonly policy: Policy;
  readonly config: PermDockConfig;
  readonly customRoles: readonly CustomRole[];
  readonly plan: PowerSyncPlan;
  readonly fixture: FollowedRowFixture;
  readonly query: (
    sql: string,
    values: unknown[],
  ) => Promise<readonly unknown[]>;
  readonly mismatches: string[];
  readonly synced: (
    stream: PowerSyncStream,
    fixture: FollowedRowFixture,
  ) => Promise<boolean | undefined>;
}): Promise<void> {
  const { fixture, config, policy, mismatches } = input;
  const label = `${fixture.table} for ${fixture.subject.id}`;
  const spec = config.powersync?.tables?.[fixture.table];
  const stream = input.plan.tables.find(
    (item) =>
      item.table ===
      bare(fixture.table, {
        ...POSTGRES,
        names: { renamed: input.plan.devices, seen: new Set() },
      }),
  );
  if (spec === undefined || stream === undefined || !isRecord(fixture.row)) {
    mismatches.push(`${label}: no configured table stream or invalid row`);
    return;
  }
  const row = fixture.row;
  let granted =
    spec.user !== undefined && row[spec.user] === fixture.subject.id;
  for (const follow of spec.follow ?? []) {
    if (
      !Object.entries(follow.match ?? {}).every(
        ([key, value]) => row[key] === value,
      )
    ) {
      continue;
    }
    const permission = findPermission(
      policy.permissions,
      `${follow.resource}.${config.powersync?.action ?? "read"}`,
    );
    const resource = policy.resources.get(follow.resource);
    const parentId = row[follow.field];
    if (
      permission === undefined ||
      resource?.id === undefined ||
      (typeof parentId !== "string" && typeof parentId !== "number")
    ) {
      continue;
    }
    const parents = await input.query(
      `select * from ${quoteQualified(tableNameOf(config.rls?.tables?.[follow.resource], follow.resource))} where ${quoteIdent(resource.id)}::text = $1::text`,
      [String(parentId)],
    );
    for (const parent of parents) {
      const root = policy.scopes.find(
        (scope) => scope.within === undefined,
      )?.key;
      const tenant =
        root !== undefined && isRecord(parent) ? parent[root] : undefined;
      const permdock = await getPermDock(
        policy,
        fixtureSubject({
          ...fixture.subject,
          ...(typeof tenant === "string" ? { tenant } : {}),
        }),
        { customRoles: memoryCustomRoleSource(input.customRoles) },
      );
      granted ||= canFixture(permdock, permission, parent);
    }
  }
  if ((fixture.expected === "granted") !== granted) {
    mismatches.push(
      `${label}: expected ${fixture.expected}, but parent access is ${granted ? "granted" : "denied"}`,
    );
  }
  const holds = await input.synced(
    { ...stream, resource: fixture.table, id: "id", claims: [] },
    fixture,
  );
  if (holds === undefined) {
    mismatches.push(`${label}: fixture row needs id`);
  } else if (holds && !granted) {
    mismatches.push(
      `${label}: stream ${stream.name} syncs a row the policy denies`,
    );
  } else if (!holds && granted) {
    mismatches.push(
      `${label}: granted, but stream ${stream.name} does not sync the row`,
    );
  }
}
