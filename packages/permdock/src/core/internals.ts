import type { Assignable } from "./assignable.ts";
import type { CustomGrant } from "./custom-roles.ts";
import type { Decision } from "./decision.ts";
import type { InstanceEnv } from "./instance-env.ts";
import type { PermDock } from "./permdock.ts";
import type { Permission } from "./permission-types.ts";
import type { Policy } from "./policy-types.ts";
import type { RelationCache, RelationReader } from "./relations.ts";
import type { Subject } from "./subject.ts";

/**
 * What a feature function needs from a server instance beyond its public
 * members: the policy, the environment it was built with and its caches.
 * Feature functions (`decideCredential(permdock, …)`, `whoCan(permdock, …)`)
 * read it, so `createPermDock` never references their modules and a
 * bundler drops every feature an app does not call.
 */
export type InstanceInternals = {
  /** The server instance itself, which a wrapper (the PDP adapter) forwards. */
  readonly instance: PermDock;
  readonly policy: Policy;
  readonly subject: Subject;
  readonly env: InstanceEnv;
  readonly team: string | undefined;
  readonly customGrants: readonly CustomGrant[];
  readonly relations: RelationReader;
  readonly relationCache: RelationCache;
  /** What the subject may hand out in a tenant, or globally for `undefined`. */
  readonly assignable: (tenant: string | undefined) => Assignable;
  /** The decision clock in epoch seconds. */
  readonly now: () => number;
  /**
   * Runs `run` with a decide function that evaluates quietly, as
   * `simulate` does, and emits one simulate event for every check it made.
   */
  readonly simulateWith: <T>(
    run: (decide: (permission: Permission, data: unknown) => Decision) => T,
  ) => T;
};

/**
 * Any instance a feature function accepts: a server `PermDock`, one built
 * from a snapshot, or an adapter's wrapper such as `PdpPermDock`.
 */
export type InstanceHandle = { readonly subject: Subject };

// Symbol.for: one key across copies of this module, so a free function
// imported from one entry reads an instance built by another.
const INTERNALS = Symbol.for("permdock.internals");

/** Attaches `internals` to `instance` as a non-enumerable member; call before freezing. */
export function attachInternals(
  instance: object,
  internals: InstanceInternals,
): void {
  Object.defineProperty(instance, INTERNALS, { value: internals });
}

/**
 * The internals of a server instance, or `undefined` for an instance built
 * from a snapshot or one that is not PermDock's. A feature function treats
 * `undefined` as a check it cannot answer and denies with `unsupported`.
 */
export function internalsOf(
  permdock: InstanceHandle,
): InstanceInternals | undefined {
  const value: unknown = Reflect.get(permdock, INTERNALS);
  // SAFETY: attachInternals is the only writer of INTERNALS and stores an InstanceInternals.
  return value === undefined ? undefined : (value as InstanceInternals);
}
