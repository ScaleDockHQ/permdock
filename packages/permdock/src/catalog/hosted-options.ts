import type { Grantee } from "../core/grantee.ts";
import type { ResourceNode } from "../core/permission-types.ts";
import type { ApprovalRequirement, Policy } from "../core/policy-types.ts";

import { isRecord } from "../core/compact.ts";
import { freezeDeep } from "../core/freeze.ts";
import { codeApprovals, declaredGrantee } from "../core/hosted.ts";
import { findPermission, getResource } from "../core/permission-registry.ts";
import { declaredRoleNames } from "../core/policy.ts";
import { isSelfParented } from "../core/resource-relations.ts";
import { findRole, listPlans } from "../core/vocabulary.ts";

/**
 * The declared roles held at one scope: a scope name as declared, `resource`,
 * or `global` for a role with no `on`.
 */
export type HostedGrantRoleOption = {
  readonly scope: string;
  readonly roles: readonly string[];
};

export type HostedGrantRelationOption = {
  readonly relation: string;
  /** Present when the grant may walk the resource's own parent chain. */
  readonly through?: "parent";
};

/**
 * What a hosted grant on one hostable permission may say; any other value is
 * dropped by `mergeHostedGrants`.
 */
export type HostedGrantOption = {
  readonly permission: string;
  readonly resource: string;
  readonly scope: string;
  readonly effects: readonly ("allow" | "deny")[];
  readonly grantees: {
    readonly roles: readonly HostedGrantRoleOption[];
    readonly plans: readonly string[];
    readonly relations: readonly HostedGrantRelationOption[];
  };
  readonly approval: {
    /**
     * `true` when a code allow carries an approval: a hosted allow without one
     * at least as strict is dropped (`weaker-approval`).
     */
    readonly required: boolean;
    /** The approvals code allows carry; a hosted allow must meet each. */
    readonly meets: readonly ("human" | ApprovalRequirement)[];
    /**
     * `human` is `approval: 'human'`; `any` is the object form, any one
     * approver per approval. `all` and `sequential` stages are never accepted.
     */
    readonly modes: readonly ("human" | "any")[];
    /** The object-form fields a hosted approval may set. */
    readonly fields: readonly string[];
    /** The grantee kinds `by` and `escalation.to` may name. */
    readonly approvers: readonly ("role" | "plan" | "authenticated")[];
  };
  readonly conditions: {
    /** `where` and `check` accept the portable condition subset only. */
    readonly portable: true;
    /**
     * The resource's top-level fields, from its JSON Schema; `null` when the
     * schema exposes none.
     */
    readonly fields: readonly string[] | null;
  };
};

function roleScope(policy: Policy, name: string): string {
  const on =
    policy.rolesByName.get(name)?.on ??
    findRole(policy.vocabulary.roles, name)?.on;
  if (on === undefined) {
    return "global";
  }
  return typeof on === "string" ? on : "resource";
}

function schemaFields(
  node: ResourceNode | undefined,
): readonly string[] | null {
  // SAFETY: every member is optional and checked with ?. and typeof before output() is called.
  const schema = node?.schema as
    | {
        readonly "~standard"?: {
          readonly jsonSchema?: {
            readonly output?: (options: { readonly target: string }) => unknown;
          };
        };
      }
    | undefined;
  const output = schema?.["~standard"]?.jsonSchema?.output;
  if (typeof output !== "function") {
    return null;
  }
  try {
    const json: unknown = output({ target: "draft-2020-12" });
    const properties = isRecord(json) ? json["properties"] : undefined;
    return isRecord(properties) ? Object.keys(properties).toSorted() : null;
  } catch {
    return null;
  }
}

function optionFor(policy: Policy, key: string): HostedGrantOption | null {
  const leaf = findPermission(policy.permissions, key);
  if (leaf === undefined) {
    return null;
  }
  const accepts = (grantee: Grantee): boolean =>
    declaredGrantee(policy, grantee, leaf.resource);
  const byScope = new Map<string, string[]>();
  for (const role of declaredRoleNames(policy)) {
    const scope = roleScope(policy, role);
    if (accepts({ kind: "role", role, scope })) {
      byScope.set(scope, [...(byScope.get(scope) ?? []), role]);
    }
  }
  const plans = listPlans(policy.vocabulary.plans)
    .map((plan) => plan.key)
    .filter((plan) => accepts({ kind: "plan", plan }));
  const node = getResource(policy.permissions, leaf.resource);
  const relations = Object.keys(node?.relations ?? {})
    .toSorted()
    .flatMap((relation): HostedGrantRelationOption[] => {
      const direct: Grantee = {
        kind: "relation",
        resource: leaf.resource,
        relation,
      };
      if (!accepts(direct)) {
        return [];
      }
      return isSelfParented(node) && accepts({ ...direct, through: "parent" })
        ? [{ relation, through: "parent" }]
        : [{ relation }];
    });
  const meets = codeApprovals(policy, key).filter(
    (approval) => approval !== undefined,
  );
  return {
    permission: key,
    resource: leaf.resource,
    scope: leaf.scope,
    effects: ["allow", "deny"],
    grantees: {
      roles: [...byScope].map(([scope, roles]) => ({ scope, roles })),
      plans,
      relations,
    },
    approval: {
      required: meets.length > 0,
      meets,
      modes: ["human", "any"],
      fields: [
        "by",
        "distinct",
        "escalation",
        "quorum",
        ...(node?.version === undefined ? [] : ["staleOn"]),
        "ttl",
      ],
      approvers: [
        ...(byScope.size > 0 ? (["role"] as const) : []),
        ...(plans.length > 0 ? (["plan"] as const) : []),
        "authenticated",
      ],
    },
    conditions: { portable: true, fields: schemaFields(node) },
  };
}

/**
 * What a hosted grant may say on each permission the policy marks `hostable`,
 * in `hostable` order: the grantees, approval forms and conditions
 * `mergeHostedGrants` accepts. For an authoring form; every grant it builds
 * from these still goes through `checkHostedGrant`.
 */
export function hostedGrantOptions(
  policy: Policy,
): readonly HostedGrantOption[] {
  return freezeDeep(
    policy.hostable.flatMap((key) => {
      const option = optionFor(policy, key);
      return option === null ? [] : [option];
    }),
  );
}
