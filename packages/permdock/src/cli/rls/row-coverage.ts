import type { Condition } from "../../conditions/ast.ts";
import type { Grantee } from "../../core/grantee.ts";
import type { Grant, Policy } from "../../core/policy-types.ts";

import { grantHasRowConditions } from "../../core/row-conditions.ts";

const ROW_GRANTEES: ReadonlySet<string> = new Set([
  "relation",
  "plan",
  "actor",
  "assurance",
  "inherit",
]);

/**
 * What a policy expression must show before a helper call for the key is not
 * condition-blind.
 */
export type RowConditionCoverage = {
  /** `field = 'value'` from a `where` of string equalities. */
  readonly equalities: readonly string[];
  /** Scope names whose `member_<scope>_ids()` the expression must call. */
  readonly relations: readonly string[];
};

function granteesOf(to: Grant["to"]): readonly Grantee[] {
  // SAFETY: Array.isArray does not narrow a readonly array; `to` is one grantee or a list of them.
  return Array.isArray(to) ? (to as readonly Grantee[]) : [to as Grantee];
}

/**
 * Coverage for a key whose row conditions are only string equalities in `where`
 * and relation grantees named after a scope. A plan or any other condition
 * leaves the key out: the helpers still cannot apply it.
 */
export function rowConditionCoverage(
  policy: Policy,
): Readonly<Record<string, RowConditionCoverage>> {
  const found = new Map<
    string,
    { equalities: string[]; relations: string[] }
  >();
  const blocked = new Set<string>();
  for (const grant of [
    ...policy.grants,
    ...policy.roles.flatMap((binding) => binding.grants),
  ]) {
    if (grant.hosted !== undefined || !grantHasRowConditions(grant)) {
      continue;
    }
    const parts: { equalities: string[]; relations: string[] } = {
      equalities: [],
      relations: [],
    };
    if (blocksCoverage(policy, grant, parts)) {
      blocked.add(grant.permission.key);
    } else {
      const list = found.get(grant.permission.key) ?? {
        equalities: [],
        relations: [],
      };
      list.equalities.push(...parts.equalities);
      list.relations.push(...parts.relations);
      found.set(grant.permission.key, {
        equalities: [...new Set(list.equalities)],
        relations: [...new Set(list.relations)],
      });
    }
  }
  for (const key of blocked) {
    found.delete(key);
  }
  return Object.fromEntries(found);
}

function blocksCoverage(
  policy: Policy,
  grant: Grant,
  out: { equalities: string[]; relations: string[] },
): boolean {
  for (const grantee of granteesOf(grant.to)) {
    if (!ROW_GRANTEES.has(grantee.kind)) {
      continue;
    }
    if (grantee.kind !== "relation") {
      return true;
    }
    if (
      grantee.through !== undefined ||
      grantee.depth !== undefined ||
      !policy.scopes.some((scope) => scope.name === grantee.relation)
    ) {
      return true;
    }
    out.relations.push(grantee.relation);
  }
  if (
    grant.check !== undefined ||
    grant.closure !== undefined ||
    !grant.portable ||
    grant.fields !== undefined ||
    grant.purpose !== undefined ||
    grant.breakGlass !== undefined ||
    grant.validity !== undefined ||
    grant.requires !== undefined
  ) {
    return true;
  }
  return grant.where !== undefined && !equalitySql(grant.where, out.equalities);
}

function equalitySql(condition: Condition, out: string[]): boolean {
  switch (condition.op) {
    case "eq": {
      if (typeof condition.value !== "string") {
        return false;
      }
      out.push(
        `${condition.field} = '${condition.value.replaceAll("'", "''")}'`,
      );
      return true;
    }
    case "and":
    case "or":
      return condition.conditions.every((child) => equalitySql(child, out));
    case "not":
      return equalitySql(condition.condition, out);
    case "ne":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
    case "contains":
    case "in":
    case "notIn":
    case "isNull":
    case "memberOf":
    case "related":
    case "opaque":
    case "sqlFunction":
    case "liveSession":
      return false;
    default: {
      const exhaustive: never = condition;
      return exhaustive;
    }
  }
}
