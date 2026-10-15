import type { Decision, ExplainedDecision } from "./decision.ts";
import type { AuthEvent } from "./event-types.ts";
import type {
  DecideOptions,
  DeriveOptions,
  PermDock,
  SimulateOptions,
  SnapshotOptions,
  WhereResult,
} from "./permdock.ts";
import type { Permission } from "./permission-types.ts";
import type { Policy } from "./policy-types.ts";
import type { Snapshot } from "./snapshot-types.ts";
import type { Membership, Principal, Subject } from "./subject.ts";
import type { Role } from "./vocabulary.ts";

import { assertDecision } from "./assert-decision.ts";
import { type Assignable, assignableIn } from "./assignable.ts";
import { compact, isReadonlyArray } from "./compact.ts";
import { customGrantsFor } from "./custom-roles.ts";
import { decideForTarget } from "./decide-for.ts";
import { evaluate } from "./evaluate/index.ts";
import { type EvalEnv, emitSafe, emptyListeners, finish } from "./events.ts";
import { pickVisible } from "./fields.ts";
import { freezeDeep } from "./freeze.ts";
import { heldRoleNames, roleLeaf } from "./held-roles.ts";
import { type InstanceEnv, deriveEnv } from "./instance-env.ts";
import { snapshotOf } from "./instance-snapshot.ts";
import { attachInternals } from "./internals.ts";
import { mayUse, permittedIds } from "./may-use.ts";
import { getResource, listPermissions } from "./permission-registry.ts";
import {
  type RelationCache,
  pendingRelations,
  relationReader,
} from "./relations.ts";
import { audiencesOf } from "./role-rank.ts";
import { scopeList } from "./scopes.ts";
import {
  type SimulatePreview,
  previewSubject,
  simulateEvent,
} from "./simulate-preview.ts";
import { collectSnapshotGrants, whereGrant } from "./snapshot-grants.ts";
import { signSnapshot } from "./snapshot-sign.ts";
import { snapshotGrant } from "./snapshot.ts";
import {
  nowSeconds,
  relatesTo,
  scopeField,
  resolveActiveTenant,
  tenantsOf,
} from "./tenancy.ts";
import { isThenable } from "./thenable.ts";
import { whereFromGrants } from "./where-scope.ts";

/** Each round reads one more layer: link hops, then the chain, then nested groups. */
const LOAD_ROUNDS = 48;

export function buildInstance(
  policy: Policy,
  subject: Subject,
  envBase: InstanceEnv,
  team?: string,
): PermDock {
  const listeners = emptyListeners();
  const queuedAuth = [...envBase.queuedAuth];
  const queuedErrors = [...(envBase.queuedErrors ?? [])];
  const customGrants = customGrantsFor(policy, envBase.customRoles);
  const relationCache: RelationCache = envBase.relationCache ?? new Map();
  const relations = relationReader(
    envBase.relations,
    relationCache,
    policy.resources,
  );
  const assignableAt = (tenant: string | undefined): Assignable =>
    assignableIn(
      policy,
      subject,
      envBase.customRoles,
      customGrants,
      tenant,
      tenant === undefined ? undefined : envBase.assignable?.get(tenant),
    );
  const assignableGlobal = (): Assignable =>
    assignableIn(
      policy,
      subject,
      envBase.customRoles,
      customGrants,
      undefined,
      undefined,
      nowSeconds(),
      true,
    );
  const envFor = (emit: boolean, skipAlternatives = false): EvalEnv => ({
    emit,
    simulated: envBase.simulated,
    skipAlternatives,
    customRoles: envBase.customRoles,
    customGrants,
    listeners,
    sink: envBase.sink,
    limits: envBase.limits,
    limitCache: envBase.limitCache,
    team,
    relations,
    ...(envBase.approvalPolicies === undefined
      ? {}
      : { approvalPolicies: envBase.approvalPolicies }),
  });

  const decideImpl = (
    permission: Permission,
    data?: unknown,
    options?: DecideOptions,
  ): Decision =>
    evaluate(
      policy,
      subject,
      permission,
      data,
      options ?? {},
      envFor(options?.call !== "simulate", options?.call === "can"),
    );

  const explainImpl = (
    permission: Permission,
    data?: unknown,
    options?: Omit<DecideOptions, "explain">,
  ): ExplainedDecision => {
    const decision = decideImpl(permission, data, {
      ...options,
      call: options?.call ?? "explain",
      explain: true,
    });
    // SAFETY: evaluate attaches a trace to every decision made with explain: true.
    return decision as ExplainedDecision;
  };

  const canImpl = (
    permission: Permission,
    data?: unknown,
    options?: DecideOptions,
  ): boolean => {
    try {
      return (
        decideImpl(permission, data, {
          ...options,
          call: options?.call ?? "can",
        }).outcome === "granted"
      );
    } catch {
      return false;
    }
  };

  const assertImpl = (
    permission: Permission,
    data?: unknown,
    options?: DecideOptions,
  ): Extract<Decision, { readonly outcome: "granted" }> => {
    const decision = decideImpl(permission, data, {
      ...options,
      call: options?.call ?? "assert",
    });
    return assertDecision(
      policy,
      subject,
      permission,
      data,
      decision,
      options?.onDenied ?? policy.onDenied,
    );
  };

  // SAFETY: canImpl, decideImpl, assertImpl and explainImpl each implement every overload of their member.
  const instance: PermDock = {
    can: canImpl as PermDock["can"],
    decide: decideImpl as PermDock["decide"],
    decideEach(
      permission: Permission,
      rows: readonly unknown[],
      options?: DecideOptions,
    ): readonly Decision[] {
      return Object.freeze(
        rows.map((row) => decideImpl(permission, row, options)),
      );
    },
    decideFor(
      principalId: string,
      permission: Permission,
      row?: unknown,
    ): Promise<Decision> {
      return decideForTarget(
        subject,
        envBase.principals,
        envBase.targets,
        principalId,
        permission,
        row,
      );
    },
    assert: assertImpl as PermDock["assert"],
    explain: explainImpl as PermDock["explain"],
    permissions: policy.permissions,
    roles: policy.vocabulary?.roles ?? {},
    plans: policy.vocabulary?.plans ?? {},
    filter<T>(
      permission: Permission<string, T, "instance">,
      rows: readonly T[],
      options?: DecideOptions,
    ): T[] {
      const allowed: T[] = [];
      let granted = 0;
      let denied = 0;
      let approvalRequired = 0;
      const quiet: EvalEnv = { ...envFor(false, true), outcomeOnly: true };
      const trusted = options?.trusted ?? true;
      const decideOptions: DecideOptions = {
        ...options,
        call: "filter",
        trusted,
      };
      for (const row of rows) {
        const decision = evaluate(
          policy,
          subject,
          permission,
          row,
          decideOptions,
          quiet,
        );
        if (decision.outcome === "granted") {
          allowed.push(row);
          granted += 1;
        } else if (decision.outcome === "approval-required") {
          approvalRequired += 1;
        } else {
          denied += 1;
        }
      }
      const summary: Decision =
        granted > 0
          ? freezeDeep({
              outcome: "granted",
              subject,
              matched: {
                role: "*",
                permission: permission.key,
              },
              token: "pd1.filter",
            })
          : freezeDeep({
              outcome: "denied",
              permission: permission.key,
              denials: [{ role: null, reason: "no-grant" }],
              alternatives: [],
            });
      finish(
        policy,
        subject,
        permission,
        rows[0],
        summary,
        decideOptions,
        { ...quiet, emit: true },
        trusted,
        undefined,
        { granted, denied, approvalRequired },
      );
      return allowed;
    },
    pick<T>(
      permission: Permission<string, T, "instance">,
      row: T,
      options?: DecideOptions,
    ): Partial<T> {
      if (row === null || typeof row !== "object") {
        return {};
      }
      if (canImpl(permission, row, options) !== true) {
        return {};
      }
      return pickVisible(row, (field) => {
        const next = compact<DecideOptions>({ ...options, field });
        return canImpl(permission, row, next) === true;
      });
    },
    where(permission: Permission): WhereResult {
      const grants = collectSnapshotGrants(
        policy,
        subject,
        envBase.customRoles,
        nowSeconds(),
        customGrants,
      )
        .filter((item) => item.grant.permission.key === permission.key)
        .map((item) => snapshotGrant(whereGrant(item.grant), item.membership));
      return whereFromGrants(
        grants,
        compact({
          resource: permission.resource,
          resources: policy.resources,
          graph: envBase.relations !== undefined,
          scopes: scopeList(policy.scopes),
          partitioned: (name: string, key: string) =>
            relatesTo(
              getResource(policy.permissions, permission.resource),
              key,
              name,
              scopeList(policy.scopes),
            ),
          fieldOf: (name: string) =>
            scopeField(
              getResource(policy.permissions, permission.resource),
              name,
              scopeList(policy.scopes),
            ),
          tenant: subject.principal?.tenant,
          team,
          now: nowSeconds(),
          subject,
        }),
      );
    },
    actions(
      resource: Permission | { readonly [key: string]: unknown },
      data: unknown,
      options?: DecideOptions,
    ): Permission[] {
      // SAFETY: actions takes a leaf or a resource node, the shapes listPermissions walks.
      const fromTree = listPermissions(resource as never);
      const leaves =
        fromTree.length > 0
          ? fromTree
          : "resource" in resource && typeof resource.resource === "string"
            ? listPermissions(policy.permissions).filter(
                (item) => item.resource === resource.resource,
              )
            : [];
      return leaves.filter((item) => canImpl(item, data, options) === true);
    },
    async loadRelations(
      permission: Permission,
      rows: readonly unknown[],
    ): Promise<void> {
      if (envBase.relations === undefined) {
        return;
      }
      const quiet: EvalEnv = {
        ...envFor(false),
        simulated: true,
        skipAlternatives: true,
      };
      for (let round = 0; round < LOAD_ROUNDS; round += 1) {
        for (const row of rows) {
          evaluate(
            policy,
            subject,
            permission,
            row,
            { call: "simulate", trusted: true },
            quiet,
          );
        }
        const pending = pendingRelations(relationCache);
        if (pending.length === 0) {
          return;
        }
        // oxlint-disable-next-line no-await-in-loop -- each round's reads depend on the answers of the one before
        await Promise.all(pending);
      }
    },
    // SAFETY: the implementation returns the result type of each simulate overload for its input.
    simulate: ((
      input:
        | readonly (readonly [Permission, unknown?])[]
        | {
            readonly roles?: readonly (string | Role)[];
            readonly memberships?: readonly Membership[];
            readonly tenant?: string;
          },
      options?: SimulateOptions,
    ): Decision[] | PermDock => {
      const evaluated: (readonly [Permission, unknown, Decision])[] = [];
      const quietly = (permission: Permission, data: unknown): Decision => {
        const decision = evaluate(
          policy,
          subject,
          permission,
          data,
          compact<DecideOptions>({
            call: "simulate",
            trusted: true,
            now: options?.now,
          }),
          envFor(false),
        );
        evaluated.push([permission, data, decision]);
        return decision;
      };
      if (isReadonlyArray(input)) {
        const decisions = input.map(([permission, data]) =>
          quietly(permission, data),
        );
        simulateEvent(policy, subject, envFor(false), evaluated);
        return decisions;
      }
      // SAFETY: arrays returned above, so the rest of the union is the preview.
      const preview = input as SimulatePreview;
      return buildInstance(
        policy,
        previewSubject(policy, subject, preview),
        { ...envBase, simulated: true, relationCache },
        team,
      );
    }) as PermDock["simulate"],
    // SAFETY: the body returns a Promise exactly when options.signer is set, which is what the overloads say.
    snapshot: ((options?: SnapshotOptions): Snapshot | Promise<string> => {
      const snapshot = snapshotOf(
        policy,
        subject,
        compact<Parameters<typeof snapshotOf>[2]>({
          customRoles: envBase.customRoles,
          customGrants,
          assignable: envBase.assignable,
          include: options?.include,
          tenants: options?.tenants,
          simulated: envBase.simulated,
        }),
      );
      if (options?.signer !== undefined) {
        return signSnapshot(snapshot, options.signer, options.audience);
      }
      return snapshot;
    }) as PermDock["snapshot"],
    on(event, handler) {
      // SAFETY: on() types handler by event name, so each set only receives matching handlers.
      const set = listeners[event] as Set<(payload: unknown) => void>;
      set.add(handler);
      if (event === "auth") {
        for (const queued of queuedAuth) {
          try {
            // SAFETY: event is 'auth' here, so handler is the auth handler on() was typed with.
            (handler as (payload: AuthEvent) => void)(queued);
          } catch (error) {
            emitSafe(listeners.error, error, listeners);
          }
        }
      }
      if (event === "error") {
        for (const queued of queuedErrors) {
          try {
            handler(queued);
          } catch {
            // An error handler that throws has nowhere left to report.
          }
        }
      }
      return (): void => {
        set.delete(handler);
      };
    },
    tenant(id: string): PermDock {
      if (subject.principal === null) {
        return buildInstance(
          policy,
          subject,
          { ...envBase, relationCache },
          team,
        );
      }
      const next = freezeDeep(
        compact<Subject>({
          ...subject,
          principal: compact<Principal>({
            ...subject.principal,
            tenant: resolveActiveTenant(
              subject.principal,
              id,
              scopeList(policy.scopes),
            ),
          }),
        }),
      );
      return buildInstance(policy, next, { ...envBase, relationCache }, team);
    },
    team(id: string): PermDock {
      return buildInstance(policy, subject, { ...envBase, relationCache }, id);
    },
    memberships(): readonly Membership[] {
      return subject.principal?.memberships ?? [];
    },
    tenants(): readonly string[] {
      return tenantsOf(subject.principal, scopeList(policy.scopes));
    },
    heldRoles(options?: {
      readonly tenant?: string;
      readonly scope?: string;
      readonly id?: string;
    }): readonly Role[] {
      const names = heldRoleNames(
        policy,
        subject,
        options?.tenant ?? subject.principal?.tenant,
        options?.scope === undefined
          ? undefined
          : compact({ scope: options.scope, id: options.id }),
      );
      return names.map((name) => roleLeaf(policy, name));
    },
    audiences(): readonly string[] {
      return audiencesOf(
        policy,
        heldRoleNames(policy, subject, subject.principal?.tenant),
      );
    },
    assignableRoles(options?: {
      readonly tenant?: string;
      readonly scope?: "global";
    }): readonly Role[] {
      if (options?.scope === "global") {
        return assignableGlobal().roles.filter((leaf) => leaf.on === undefined);
      }
      return assignableAt(options?.tenant ?? subject.principal?.tenant).roles;
    },
    assignablePermissions(options?: {
      readonly tenant?: string;
      readonly scope?: "global";
    }): readonly Permission[] {
      if (options?.scope === "global") {
        return assignableGlobal().permissions;
      }
      const tenant = options?.tenant ?? subject.principal?.tenant;
      return tenant === undefined ? [] : assignableAt(tenant).permissions;
    },
    assignableLevels(
      permission: Permission,
      options?: { readonly tenant?: string; readonly scope?: "global" },
    ): readonly string[] {
      const of = (found: Assignable): readonly string[] =>
        (Object.hasOwn(found.levels, permission.key)
          ? found.levels[permission.key]
          : undefined) ?? [];
      if (options?.scope === "global") {
        return of(assignableGlobal());
      }
      const tenant = options?.tenant ?? subject.principal?.tenant;
      return tenant === undefined ? [] : of(assignableAt(tenant));
    },
    mayUse(permission) {
      return mayUse(instance, permission);
    },
    permittedIds(permission, scope, options) {
      return permittedIds(instance, permission, scope, options);
    },
    derive(options: DeriveOptions): PermDock | Promise<PermDock> {
      const derived = deriveEnv(
        policy,
        subject,
        envBase,
        relationCache,
        options,
      );
      return isThenable(derived)
        ? Promise.resolve(derived).then((env) =>
            buildInstance(policy, subject, env, team),
          )
        : buildInstance(policy, subject, derived, team);
    },
    subject,
  };
  attachInternals(instance, {
    instance,
    policy,
    subject,
    env: envBase,
    team,
    customGrants,
    relations,
    relationCache,
    assignable: (tenant) =>
      tenant === undefined ? assignableGlobal() : assignableAt(tenant),
    now: () => nowSeconds(),
    simulateWith: (run) => {
      const evaluated: (readonly [Permission, unknown, Decision])[] = [];
      const result = run((permission, data) => {
        const decision = evaluate(
          policy,
          subject,
          permission,
          data,
          { call: "simulate", trusted: true },
          envFor(false),
        );
        evaluated.push([permission, data, decision]);
        return decision;
      });
      simulateEvent(policy, subject, envFor(false), evaluated);
      return result;
    },
  });
  return Object.freeze(instance);
}
