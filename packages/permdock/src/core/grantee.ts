import type { Condition } from "../conditions/ast.ts";
import type { DenialReason } from "./decision.ts";
import type { Permission, PermissionTree } from "./permission-types.ts";

import { compact } from "./compact.ts";
import { freezeDeep } from "./freeze.ts";
import {
  isPermission as isPermissionLeaf,
  listPermissions,
} from "./permission-registry.ts";
import { type Plan, type Role, isPlan, isRole } from "./vocabulary.ts";

export type RoleGrantee = {
  readonly kind: "role";
  readonly role: string;
  /** `'global'`, a scope name, or one resource. */
  readonly scope: string | { readonly resource: string };
};

export type AnyoneGrantee = { readonly kind: "anyone" };
export type AuthenticatedGrantee = { readonly kind: "authenticated" };
export type RelationGrantee = {
  readonly kind: "relation";
  readonly resource: string;
  readonly relation: string;
  /**
   * `'parent'`: follow the row's `parent` chain upward to `resource`, then its
   * own parents. A list of link names: follow those to-one links from the row
   * to `resource`, then walk its parents only when `depth` is set.
   */
  readonly through?: "parent" | readonly string[];
  /**
   * Parent hops walked above the first `resource` instance; absent means
   * `DEFAULT_RELATION_DEPTH` for `'parent'` and `0` for links.
   */
  readonly depth?: number;
};

export const DEFAULT_RELATION_DEPTH = 16;
export const MAX_RELATION_DEPTH = 32;
export type PlanGrantee = { readonly kind: "plan"; readonly plan: string };
export type ActorGrantee = { readonly kind: "actor"; readonly actor: string };
export type AssuranceGrantee = {
  readonly kind: "assurance";
  readonly acr?: readonly string[];
  readonly amr?: readonly string[];
  readonly maxAge?: number;
};

export type InheritGrantee = {
  readonly kind: "inherit";
  readonly permission: string;
  readonly resource: string;
  readonly through: "parent" | readonly string[];
};

export type Grantee =
  | RoleGrantee
  | InheritGrantee
  | AnyoneGrantee
  | AuthenticatedGrantee
  | RelationGrantee
  | PlanGrantee
  | ActorGrantee
  | AssuranceGrantee;

export type GranteeInput =
  | Grantee
  | Role
  | Plan
  | string
  | readonly GranteeInput[];

export type GranteeMatch = {
  readonly matched: boolean;
  readonly where?: Condition;
  readonly reason?: DenialReason;
  /** The grantee kind is unknown to this build. */
  readonly unknown?: true;
};

function isGrantee(value: unknown): value is Grantee {
  return (
    value !== null &&
    typeof value === "object" &&
    "kind" in value &&
    typeof value.kind === "string"
  );
}

export function anyone(): AnyoneGrantee {
  return freezeDeep({ kind: "anyone" as const });
}

export function authenticated(): AuthenticatedGrantee {
  return freezeDeep({ kind: "authenticated" as const });
}

export function relation(
  resource: Permission | PermissionTree,
  name: string,
  options?: {
    readonly through?: "parent" | readonly string[];
    readonly depth?: number;
  },
): RelationGrantee {
  const leaves = listPermissions(resource);
  const resourceName = leaves[0]?.resource;
  if (resourceName === undefined) {
    throw new Error("PermDock: relation() requires a resource tree");
  }
  const through = options?.through;
  if (Array.isArray(through)) {
    if (through.length === 0) {
      throw new Error("PermDock: relation() through needs at least one link");
    }
    // SAFETY: a widening to unknown, so each link from untyped callers is checked below.
    for (const link of through as readonly unknown[]) {
      if (typeof link !== "string" || link === "" || link === "parent") {
        throw new Error(
          "PermDock: relation() through lists link names; walk parents with through: 'parent' or depth",
        );
      }
    }
  } else if (through !== undefined && through !== "parent") {
    throw new Error(
      `PermDock: relation() through must be 'parent' or a list of link names (got '${String(through)}')`,
    );
  }
  const depth = options?.depth;
  if (depth !== undefined) {
    if (through === undefined) {
      throw new Error(
        "PermDock: relation() depth needs through: 'parent' or a link list",
      );
    }
    const hops = Array.isArray(through) ? through.length : 0;
    if (
      !Number.isInteger(depth) ||
      depth < 0 ||
      depth + hops > MAX_RELATION_DEPTH
    ) {
      throw new Error(
        `PermDock: relation() depth must be an integer from 0 to ${MAX_RELATION_DEPTH}, counting each link`,
      );
    }
  }
  // SAFETY: every link was checked to be a non-empty string other than 'parent' above.
  return freezeDeep(
    compact<RelationGrantee>({
      kind: "relation" as const,
      resource: resourceName,
      relation: name,
      through:
        through === undefined || through === "parent"
          ? through
          : [...(through as readonly string[])],
      depth,
    }),
  );
}

export function inherit(
  permission: Permission,
  options: { readonly through: "parent" | readonly string[] },
): InheritGrantee {
  if (!isPermissionLeaf(permission) || permission.kind === "collection") {
    throw new Error("PermDock: inherit() takes an instance permission leaf");
  }
  const through: unknown = options.through;
  const links: readonly unknown[] | undefined = Array.isArray(through)
    ? through
    : undefined;
  if (
    through !== "parent" &&
    (links === undefined ||
      links.length === 0 ||
      !links.every(
        (link) => typeof link === "string" && link !== "" && link !== "parent",
      ))
  ) {
    throw new Error(
      "PermDock: inherit() through must be 'parent' or a non-empty list of link names",
    );
  }
  return freezeDeep({
    kind: "inherit" as const,
    permission: permission.key,
    resource: permission.resource,
    through: links === undefined ? ("parent" as const) : links.map(String),
  });
}

export function plan(name: Plan | string): PlanGrantee {
  return freezeDeep({
    kind: "plan" as const,
    plan: typeof name === "string" ? name : name.key,
  });
}

export function actor(kind: string): ActorGrantee {
  return freezeDeep({ kind: "actor" as const, actor: kind });
}

export function assurance(options: {
  readonly acr?: string | readonly string[];
  readonly amr?: string | readonly string[];
  readonly maxAge?: number;
}): AssuranceGrantee {
  const acr =
    options.acr === undefined
      ? undefined
      : typeof options.acr === "string"
        ? [options.acr]
        : options.acr;
  const amr =
    options.amr === undefined
      ? undefined
      : typeof options.amr === "string"
        ? [options.amr]
        : options.amr;
  return freezeDeep(
    compact<AssuranceGrantee>({
      kind: "assurance" as const,
      acr,
      amr,
      maxAge: options.maxAge,
    }),
  );
}

function resolveRoleScope(on: Role["on"] | undefined): RoleGrantee["scope"] {
  return typeof on === "string" ? on : "global";
}

export function asGrantee(input: GranteeInput): Grantee | readonly Grantee[] {
  if (Array.isArray(input)) {
    const items: Grantee[] = [];
    // SAFETY: Array.isArray does not narrow a readonly array; the only array form is GranteeInput[].
    for (const item of input as readonly GranteeInput[]) {
      items.push(...flattenGrantee(asGrantee(item)));
    }
    return items;
  }
  if (typeof input === "string") {
    return freezeDeep({
      kind: "role" as const,
      role: input,
      scope: "global" as const,
    });
  }
  if (isRole(input)) {
    return freezeDeep({
      kind: "role" as const,
      role: input.key,
      scope: resolveRoleScope(input.on),
    });
  }
  if (isPlan(input)) {
    return freezeDeep({ kind: "plan" as const, plan: input.key });
  }
  if (isGrantee(input)) {
    return input;
  }
  throw new Error("PermDock: invalid grantee");
}

export function flattenGrantee(
  input: Grantee | readonly Grantee[] | undefined,
): readonly Grantee[] {
  if (input === undefined) {
    return [];
  }
  if (Array.isArray(input)) {
    // SAFETY: Array.isArray does not narrow a readonly array; the only array form is Grantee[].
    return input as readonly Grantee[];
  }
  // SAFETY: undefined and arrays returned above, so input is a single Grantee.
  return [input as Grantee];
}

export function roleNameOf(
  to: Grantee | readonly Grantee[] | undefined,
): string | null {
  for (const item of flattenGrantee(to)) {
    if (item.kind === "role") {
      return item.role;
    }
  }
  return null;
}

export function roleScopeOf(
  to: Grantee | readonly Grantee[] | undefined,
  fallback: RoleGrantee["scope"] = "global",
): RoleGrantee["scope"] {
  for (const item of flattenGrantee(to)) {
    if (item.kind === "role") {
      return item.scope;
    }
  }
  return fallback;
}

export function hasAnyone(
  to: Grantee | readonly Grantee[] | undefined,
): boolean {
  return flattenGrantee(to).some((item) => item.kind === "anyone");
}
