import type { Decision, ExplainedDecision } from "./decision.ts";
import type { Snapshot, SnapshotAssignable } from "./interfaces.ts";
import type { DecideOptions, PermDock, SimulateOptions } from "./permdock.ts";
import type { Permission } from "./permissions.ts";
import type { Membership } from "./subject.ts";
import type { Role } from "./vocabulary.ts";

import { isArazzoSimulateInput, simulateArazzo } from "./arazzo.ts";
import { compact } from "./compact.ts";
import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
  approvalMessage,
  deniedMessage,
} from "./errors.ts";
import { pickVisible } from "./fields.ts";
import { freezeDeep } from "./freeze.ts";
import { listPermissions } from "./permissions.ts";
import { normalizeMemberships, scopeList } from "./scopes.ts";
import {
  evaluateSnapshot,
  rowId,
  whereFromSnapshot,
} from "./snapshot-evaluate.ts";
import { heldRoleNames, subjectFromSnapshot } from "./snapshot-subject.ts";
import { findRole, listRoles, synthesiseRole } from "./vocabulary.ts";

function resourceRef(
  permission: Permission,
  data: unknown,
): { readonly type: string; readonly id?: string } {
  const id = permission.kind === "collection" ? undefined : rowId(data);
  return id === undefined || id === "*"
    ? { type: permission.resource }
    : { type: permission.resource, id };
}

function assignableEntry(
  snapshot: Snapshot,
  tenant: string | undefined,
): SnapshotAssignable | undefined {
  if (tenant === undefined) {
    return undefined;
  }
  return snapshot.assignable?.find((entry) => entry.tenant === tenant);
}

export function fromSnapshot(
  snapshot: Snapshot,
  options: { readonly tenant?: string; readonly team?: string } = {},
): PermDock {
  const subject = subjectFromSnapshot(snapshot, options.tenant);
  const team = options.team;

  const run = (
    permission: Permission,
    data?: unknown,
    decideOptions: DecideOptions = {},
  ): Decision =>
    evaluateSnapshot(snapshot, subject, permission, data, team, decideOptions);

  // SAFETY: one implementation serves every PermDock['decide'] overload; all return a Decision.
  const decide = ((
    permission: Permission,
    data?: unknown,
    decideOptions: DecideOptions = {},
  ): Decision => run(permission, data, decideOptions)) as PermDock["decide"];

  // SAFETY: one implementation serves every PermDock['can'] overload; all return a boolean.
  const can = ((
    permission: Permission,
    data?: unknown,
    decideOptions?: DecideOptions,
  ): boolean =>
    run(permission, data, decideOptions).outcome ===
    "granted") as PermDock["can"];

  // SAFETY: one implementation serves every PermDock['assert'] overload; it returns only a grant.
  const assert = ((
    permission: Permission,
    data?: unknown,
    decideOptions?: DecideOptions,
  ) => {
    const decision = run(permission, data, decideOptions);
    if (decision.outcome === "granted") {
      return decision;
    }
    if (decision.outcome === "approval-required") {
      throw new PermDockApprovalRequiredError({
        decision,
        permission: permission.key,
        scope: permission.scope,
        resource: resourceRef(permission, data),
        message: approvalMessage(
          permission.key,
          decision.reason,
          decision.token,
        ),
      });
    }
    throw new PermDockDeniedError({
      decision,
      permission: permission.key,
      scope: permission.scope,
      resource: resourceRef(permission, data),
      subject,
      message: deniedMessage(
        permission.key,
        subject.principal?.id,
        decision.denials,
        [],
      ),
    });
  }) as PermDock["assert"];

  // SAFETY: one implementation serves every PermDock['explain'] overload; evaluateSnapshot attaches a trace with explain: true.
  const explain = ((
    permission: Permission,
    data?: unknown,
    decideOptions?: Omit<DecideOptions, "explain">,
  ): ExplainedDecision =>
    run(permission, data, {
      ...decideOptions,
      source: decideOptions?.source ?? "explain",
      explain: true,
    }) as ExplainedDecision) as PermDock["explain"];

  const instance: PermDock = {
    can,
    decide,
    assert,
    explain,
    permissions: {},
    roles: snapshot.vocabulary?.roles ?? {},
    plans: snapshot.vocabulary?.plans ?? {},
    filter<T>(
      permission: Permission<string, T, "instance">,
      rows: readonly T[],
      decideOptions?: DecideOptions,
    ): T[] {
      return rows.filter((row) => can(permission, row, decideOptions) === true);
    },
    pick<T>(
      permission: Permission<string, T, "instance">,
      row: T,
      decideOptions?: DecideOptions,
    ): Partial<T> {
      if (row === null || typeof row !== "object") {
        return {};
      }
      if (can(permission, row, decideOptions) !== true) {
        return {};
      }
      return pickVisible(row, (field) => {
        const next = compact<DecideOptions>({ ...decideOptions, field });
        return can(permission, row, next) === true;
      });
    },
    where(permission) {
      return whereFromSnapshot(snapshot, subject, permission, team);
    },
    actions(resource, data, decideOptions) {
      // SAFETY: actions takes a leaf or a resource node, the shapes listPermissions walks.
      return listPermissions(resource as never).filter(
        (item) => run(item, data, decideOptions).outcome === "granted",
      );
    },
    // SAFETY: the implementation returns the result type of each simulate overload for its input.
    simulate: ((input: unknown, simulateOptions?: SimulateOptions) => {
      if (Array.isArray(input)) {
        // SAFETY: the simulate overload that takes an array types it as [permission, data] pairs.
        return (input as readonly (readonly [Permission, unknown?])[]).map(
          ([permission, data]) =>
            run(
              permission,
              data,
              compact<DecideOptions>({ now: simulateOptions?.now }),
            ),
        );
      }
      if (isArazzoSimulateInput(input)) {
        return simulateArazzo(input, input.permissions, (permission, data) =>
          run(permission, data),
        );
      }
      // SAFETY: arrays and Arazzo input returned above; the last overload takes this preview.
      const preview = input as {
        readonly roles?: readonly (string | Role)[];
        readonly memberships?: readonly Membership[];
        readonly tenant?: string;
      };
      const previewRoles = preview.roles?.map((item) =>
        typeof item === "string" ? item : item.key,
      );
      const next: Snapshot = freezeDeep({
        ...snapshot,
        simulated: true as const,
        subject: {
          ...snapshot.subject,
          principal:
            snapshot.subject.principal === null
              ? null
              : compact<NonNullable<Snapshot["subject"]["principal"]>>({
                  ...snapshot.subject.principal,
                  roles: previewRoles ?? snapshot.subject.principal.roles,
                  memberships:
                    preview.memberships === undefined
                      ? snapshot.subject.principal.memberships
                      : normalizeMemberships(
                          preview.memberships,
                          scopeList(snapshot.scopes),
                        ),
                  tenant: preview.tenant ?? snapshot.subject.principal.tenant,
                }),
        },
      });
      return fromSnapshot(next, options);
    }) as PermDock["simulate"],
    snapshot() {
      return snapshot;
    },
    on() {
      return (): void => undefined;
    },
    tenant(id: string): PermDock {
      return fromSnapshot(snapshot, compact({ tenant: id, team }));
    },
    team(id: string): PermDock {
      return fromSnapshot(
        snapshot,
        compact({ tenant: options.tenant, team: id }),
      );
    },
    memberships() {
      return subject.principal?.memberships ?? [];
    },
    tenants() {
      return snapshot.tenants;
    },
    heldRoles(query?: {
      readonly tenant?: string;
      readonly scope?: string;
      readonly id?: string;
    }) {
      const names = heldRoleNames(
        subject,
        query?.tenant ?? subject.principal?.tenant,
        scopeList(snapshot.scopes),
        compact({ scope: query?.scope, id: query?.id, rank: snapshot.roles }),
      );
      const tree = snapshot.vocabulary?.roles;
      return names.map((name) => findRole(tree, name) ?? synthesiseRole(name));
    },
    audiences() {
      const tenant = subject.principal?.tenant;
      if (tenant === snapshot.subject.principal?.tenant) {
        return snapshot.audiences ?? [];
      }
      const tree = snapshot.vocabulary?.roles;
      const out: string[] = [];
      for (const name of heldRoleNames(
        subject,
        tenant,
        scopeList(snapshot.scopes),
        { rank: snapshot.roles },
      )) {
        const audience = findRole(tree, name)?.meta.audience;
        if (typeof audience === "string" && !out.includes(audience)) {
          out.push(audience);
        }
      }
      return out;
    },
    loadRelations() {
      // A snapshot carries no graph: graph grants go to the decision endpoint.
      return Promise.resolve();
    },
    whoCan(permission) {
      return Promise.resolve(
        freezeDeep({
          permission: permission.key,
          holders: [],
          complete: false,
        }),
      );
    },
    decideRoleChange(change) {
      // Role changes are server decisions: the snapshot carries no holder counts or rules.
      return freezeDeep({
        outcome: "denied" as const,
        change,
        denials: [{ role: null, reason: "unsupported" as const }],
      });
    },
    activate() {
      // Activation is a server decision: a snapshot carries no activation rules.
      return freezeDeep({
        outcome: "denied" as const,
        denials: [{ role: null, reason: "unsupported" as const }],
        alternatives: [],
      });
    },
    assignableRoles(query?: { readonly tenant?: string }) {
      const tenant = query?.tenant ?? subject.principal?.tenant;
      const tree = snapshot.vocabulary?.roles;
      if (snapshot.assignable !== undefined) {
        const entry = assignableEntry(snapshot, tenant);
        return (entry?.roles ?? []).map(
          (name) =>
            findRole(tree, name) ?? synthesiseRole(name, { assignable: true }),
        );
      }
      const names = new Set(
        heldRoleNames(subject, tenant, scopeList(snapshot.scopes)),
      );
      return listRoles(tree).filter(
        (leaf) => leaf.assignable && names.has(leaf.key),
      );
    },
    assignablePermissions(query?: {
      readonly tenant?: string;
      readonly scope?: "global";
    }) {
      if (query?.scope === "global") {
        return [];
      }
      const tenant = query?.tenant ?? subject.principal?.tenant;
      return assignableEntry(snapshot, tenant)?.permissions ?? [];
    },
    subject,
  };
  return Object.freeze(instance);
}

export function emptySnapshot(): Snapshot {
  return freezeDeep({
    v: 1 as const,
    issuedAt: 0,
    subject: { principal: null, context: {} },
    roles: [],
    grants: [],
    tenants: [],
  });
}
