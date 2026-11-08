import type { Decision, ExplainedDecision } from "./decision.ts";
import type {
  DecideOptions,
  PermDock,
  SimulateOptions,
  SnapshotOptions,
} from "./permdock.ts";
import type { Permission } from "./permission-types.ts";
import type {
  ClientBundle,
  ExpandedSnapshot,
  Snapshot,
} from "./snapshot-types.ts";
import type { Membership } from "./subject.ts";
import type { Role } from "./vocabulary.ts";

import { canAllWith, decideAllWith } from "./checks.ts";
import { compact } from "./compact.ts";
import { deniedFor } from "./decide-for.ts";
import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
  approvalMessage,
  deniedMessage,
} from "./errors.ts";
import { pickVisible } from "./fields.ts";
import { freezeDeep } from "./freeze.ts";
import {
  filterIds,
  mayUseOf,
  permittedIds,
  permittedScopeIds,
} from "./may-use.ts";
import { listPermissions } from "./permission-registry.ts";
import { rowIdOf } from "./row-pair.ts";
import { normalizeMemberships, scopeList } from "./scopes.ts";
import { compactSnapshot, expandSnapshot } from "./snapshot-compact.ts";
import { evaluateSnapshot, whereFromSnapshot } from "./snapshot-evaluate.ts";
import { snapshotReads } from "./snapshot-reads.ts";
import { signSnapshot } from "./snapshot-sign.ts";
import { subjectFromSnapshot } from "./snapshot-subject.ts";
import { parseSnapshot } from "./snapshot.ts";
import { subjectInTenant } from "./where-scope.ts";

function resourceRef(
  snapshot: ExpandedSnapshot,
  permission: Permission,
  data: unknown,
): { readonly type: string; readonly id?: string } {
  const id =
    permission.kind === "collection"
      ? undefined
      : rowIdOf(data, snapshot.ids?.[permission.resource]);
  return id === undefined || id === "*"
    ? { type: permission.resource }
    : { type: permission.resource, id };
}

export function fromSnapshot(
  input: Snapshot,
  options: {
    readonly tenant?: string;
    readonly team?: string;
    /** The `clientBundle(policy)` of a snapshot built with `omitStatic`. */
    readonly bundle?: ClientBundle;
  } = {},
): PermDock {
  const wire = parseSnapshot(input);
  const snapshot = expandSnapshot(wire, compact({ bundle: options.bundle }));
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
  ): boolean => {
    try {
      return (
        evaluateSnapshot(
          snapshot,
          subject,
          permission,
          data,
          team,
          decideOptions ?? {},
          true,
        ).outcome === "granted"
      );
    } catch {
      return false;
    }
  }) as PermDock["can"];

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
        resource: resourceRef(snapshot, permission, data),
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
      resource: resourceRef(snapshot, permission, data),
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
      call: decideOptions?.call ?? "explain",
      explain: true,
    }) as ExplainedDecision) as PermDock["explain"];

  let mayUseFor: ((permission: Permission) => boolean) | undefined;
  const instance: PermDock = {
    ...snapshotReads(snapshot, subject),
    can,
    decide,
    canAll: (checks, decideOptions) => canAllWith(can, checks, decideOptions),
    decideAll: (checks, decideOptions) =>
      decideAllWith(decide, checks, decideOptions),
    decideEach(
      permission: Permission,
      rows: readonly unknown[],
      decideOptions?: DecideOptions,
    ) {
      return Object.freeze(
        rows.map((row) => run(permission, row, decideOptions)),
      );
    },
    decideIds(permission, ids) {
      return Promise.resolve(
        Object.freeze(ids.map(() => deniedFor(permission, "unsupported"))),
      );
    },
    decideFor(_principalId, permission) {
      return Promise.resolve(deniedFor(permission, "unsupported"));
    },
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
    where(permission, whereOptions) {
      return whereFromSnapshot(
        snapshot,
        subjectInTenant(subject, whereOptions?.tenant),
        permission,
        team,
      );
    },
    actions(resource, data, decideOptions) {
      // SAFETY: actions takes a leaf or a resource node, the shapes listPermissions walks.
      return listPermissions(resource as never).filter(
        (item) => run(item, data, decideOptions).outcome === "granted",
      );
    },
    // SAFETY: the implementation returns the result type of each simulate overload for its input.
    simulate: ((target: unknown, simulateOptions?: SimulateOptions) => {
      if (Array.isArray(target)) {
        // SAFETY: the simulate overload that takes an array types it as [permission, data] pairs.
        return (target as readonly (readonly [Permission, unknown?])[]).map(
          ([permission, data]) =>
            run(
              permission,
              data,
              compact<DecideOptions>({ now: simulateOptions?.now }),
            ),
        );
      }
      // SAFETY: arrays returned above; the last overload takes this preview.
      const preview = target as {
        readonly roles?: readonly (string | Role)[];
        readonly memberships?: readonly Membership[];
        readonly tenant?: string;
      };
      const previewRoles = preview.roles?.map((item) =>
        typeof item === "string" ? item : item.key,
      );
      // The table answers for the real subject.
      const { typeLevel: _real, ...rest } = snapshot;
      const next: ExpandedSnapshot = freezeDeep({
        ...rest,
        simulated: true as const,
        subject: {
          ...snapshot.subject,
          principal:
            snapshot.subject.principal === null
              ? null
              : compact<NonNullable<ExpandedSnapshot["subject"]["principal"]>>({
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
      return fromSnapshot(compactSnapshot(next), options);
    }) as PermDock["simulate"],
    // SAFETY: the body returns a Promise exactly when signer is set, which is what the overloads say.
    snapshot: ((signing?: SnapshotOptions): Snapshot | Promise<string> => {
      return signing?.signer === undefined
        ? wire
        : signSnapshot(
            wire,
            signing.signer,
            compact({ audience: signing.audience }),
          );
    }) as PermDock["snapshot"],
    on() {
      return (): void => undefined;
    },
    tenant(id: string): PermDock {
      return fromSnapshot(
        wire,
        compact({ tenant: id, team, bundle: options.bundle }),
      );
    },
    team(id: string): PermDock {
      return fromSnapshot(
        wire,
        compact({ tenant: options.tenant, team: id, bundle: options.bundle }),
      );
    },
    grantedPermissions() {
      return [];
    },
    prefetchRelations() {
      // A snapshot carries no graph: graph grants go to the decision endpoint.
      return Promise.resolve();
    },
    mayUse(permission) {
      mayUseFor ??= mayUseOf(instance);
      return mayUseFor(permission);
    },
    mayUseMany(permissions) {
      mayUseFor ??= mayUseOf(instance);
      const use = mayUseFor;
      return permissions.map((permission) => use(permission));
    },
    permittedIds(permission, scope, query) {
      return permittedIds(instance, permission, scope, query);
    },
    permittedScopeIds(permission, scopeOptions) {
      return permittedScopeIds(instance, permission, scopeOptions);
    },
    filterIds(permission, ids) {
      return filterIds(instance, permission, ids);
    },
    derive() {
      // A snapshot carries its grants already resolved: no source applies to it.
      return Promise.resolve(instance);
    },
    subject,
  };
  return Object.freeze(instance);
}

export { emptySnapshot } from "./snapshot-empty.ts";
