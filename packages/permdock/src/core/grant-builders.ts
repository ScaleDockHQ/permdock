import type { AppObligation } from "./decision.ts";
import type {
  Permission,
  PermissionKind,
  PermissionTree,
} from "./permission-types.ts";
import type {
  ClosureGrantFn,
  Grant,
  GrantCondition,
  GrantMeta,
  GrantOptions,
  ObligationInput,
} from "./policy-types.ts";

import { normalizeWhere } from "../conditions/index.ts";
import {
  type AppDataSchema,
  assertAppData,
  assertMetaValue,
  parseAppData,
} from "./app-data.ts";
import { normalizeApproval } from "./approval-normalize.ts";
import { compact, isReadonlyArray, sole } from "./compact.ts";
import { sanitizeFields } from "./fields.ts";
import { freezeDeep } from "./freeze.ts";
import {
  type Grantee,
  asGrantee,
  flattenGrantee,
  roleNameOf,
  roleScopeOf,
} from "./grantee.ts";
import { assertLimit, normalizeLimit } from "./limit-grants.ts";
import { isPermission, listPermissions } from "./permission-registry.ts";
import { normalizeValidity } from "./validity.ts";

function isClosure(value: unknown): value is ClosureGrantFn {
  return typeof value === "function";
}

export function flattenPermissions(
  input: Permission | readonly (Permission | PermissionTree)[] | PermissionTree,
): Permission[] {
  if (isPermission(input)) {
    return [input];
  }
  if (isReadonlyArray(input)) {
    return input.flatMap((item) => flattenPermissions(item));
  }
  // SAFETY: leaves and arrays returned above, so the remaining input is a PermissionTree.
  return [...listPermissions(input as PermissionTree)];
}

const GROUP = /^[a-z][a-z0-9_-]*$/u;

function grantGroup(group: unknown, key: string): string | undefined {
  if (group === undefined) {
    return undefined;
  }
  if (
    typeof group !== "string" ||
    !GROUP.test(group) ||
    group === "break-glass"
  ) {
    throw new Error(
      `PermDock: group '${String(group)}' on ${key} must be lower case letters, digits, _ or -, start with a letter, and not be break-glass`,
    );
  }
  return group;
}

function makeGrant(
  permission: Permission,
  effect: "allow" | "deny",
  condition: GrantOptions | ClosureGrantFn | undefined,
): Omit<Grant, "role" | "scope"> {
  const toInput = isClosure(condition) ? undefined : condition?.to;
  const to =
    toInput === undefined
      ? ({ kind: "role", role: "", scope: "global" } satisfies Grantee)
      : asGrantee(toInput);
  if (isClosure(condition)) {
    return { permission, effect, to, portable: false, closure: condition };
  }
  const whereInput = condition?.where;
  const checkInput = condition?.check;
  if (whereInput !== undefined && permission.kind === "collection") {
    throw new Error(
      `PermDock: where is not allowed on collection action '${permission.key}'`,
    );
  }
  const where =
    whereInput === undefined ? undefined : normalizeWhere(whereInput);
  const check =
    checkInput === undefined ? undefined : normalizeWhere(checkInput);
  assertLimit(condition?.limit, permission.key);
  const purpose =
    condition?.purpose === undefined || condition.purpose.length === 0
      ? undefined
      : Object.freeze([...new Set(condition.purpose)]);
  const portable = condition?.limit === undefined && purpose === undefined;
  const requires = requiredKey(condition?.requires, permission, effect);
  return compact<Omit<Grant, "role" | "scope">>({
    permission,
    effect,
    to,
    where,
    check,
    approval: normalizeApproval(condition?.approval, permission.key),
    portable,
    limit: normalizeLimit(condition?.limit),
    fields: sanitizeFields(condition?.fields),
    name: condition?.name,
    group: grantGroup(condition?.group, permission.key),
    meta: grantMeta(condition?.meta, permission.key, undefined),
    obligations: appObligations(condition?.obligations, permission.key, effect),
    purpose,
    validity: normalizeValidity(condition ?? {}, permission.key),
    requires,
  });
}

/**
 * Checks a grant's `meta`: plain JSON, string `description`, `x` through the
 * schema when given.
 */
function grantMeta(
  meta: unknown,
  key: string,
  schema: AppDataSchema<unknown> | undefined,
): GrantMeta | undefined {
  if (meta === undefined) {
    return undefined;
  }
  assertAppData(meta, `meta of a grant on ${key}`);
  // SAFETY: assertAppData proved meta is a plain JSON object; each field is checked below.
  const { description, x } = meta as GrantMeta;
  if (description !== undefined && typeof description !== "string") {
    throw new TypeError(
      `PermDock: meta.description of a grant on ${key} must be a string`,
    );
  }
  return freezeDeep(
    compact<GrantMeta>({
      description,
      x:
        x === undefined
          ? undefined
          : parseAppData(schema, x, `meta.x of a grant on ${key}`),
    }),
  );
}

function appObligations(
  input: readonly ObligationInput[] | undefined,
  key: string,
  effect: "allow" | "deny",
): readonly AppObligation[] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (effect !== "allow") {
    throw new Error(
      `PermDock: obligations are allowed on an allow only; '${key}' is a deny`,
    );
  }
  const list: unknown = input;
  if (!Array.isArray(list)) {
    throw new TypeError(`PermDock: obligations on '${key}' must be a list`);
  }
  const items: readonly unknown[] = list;
  const seen = new Set<string>();
  const out: AppObligation[] = [];
  for (const item of items) {
    const entry: object | undefined =
      typeof item === "object" && item !== null ? item : undefined;
    const name: unknown =
      typeof item === "string"
        ? item
        : entry === undefined
          ? undefined
          : Reflect.get(entry, "name");
    if (typeof name !== "string" || !GROUP.test(name)) {
      throw new Error(
        `PermDock: obligation '${String(name)}' on '${key}' must be lower case letters, digits, _ or -, starting with a letter`,
      );
    }
    if (seen.has(name)) {
      throw new Error(
        `PermDock: obligation '${name}' is listed twice on '${key}'`,
      );
    }
    seen.add(name);
    const detail: unknown =
      entry === undefined ? undefined : Reflect.get(entry, "detail");
    if (detail === undefined) {
      out.push({ kind: "app", name });
      continue;
    }
    assertMetaValue(detail, `detail of obligation '${name}' on '${key}'`);
    out.push({ kind: "app", name, detail });
  }
  return out.length === 0 ? undefined : freezeDeep(out);
}

/**
 * Re-checks every grant's `meta.x` with the policy's grant schema, keeping the
 * schema output.
 */
export function withGrantSchema(
  grant: Grant,
  schema: AppDataSchema<unknown> | undefined,
): Grant {
  const meta = grant.meta;
  if (schema === undefined || meta?.x === undefined) {
    return grant;
  }
  return freezeDeep({
    ...grant,
    meta: grantMeta(meta, grant.permission.key, schema) ?? meta,
  });
}

function requiredKey(
  input: unknown,
  permission: Permission,
  effect: "allow" | "deny",
): readonly string[] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (effect !== "allow") {
    throw new Error(
      `PermDock: requires is allowed on an allow only; '${permission.key}' is a deny`,
    );
  }
  if (permission.kind !== "instance") {
    throw new Error(
      `PermDock: requires on '${permission.key}' needs an instance action; a collection action has no row whose scope it can check`,
    );
  }
  const list: readonly unknown[] = Array.isArray(input) ? input : [input];
  if (list.length === 0 || !list.every(isPermission)) {
    throw new TypeError(
      `PermDock: requires on '${permission.key}' must be a permission leaf or a non-empty list of them`,
    );
  }
  return Object.freeze([...new Set(list.map((leaf) => leaf.key))]);
}

export function allow<T, K extends PermissionKind = PermissionKind>(
  permission: Permission<string, T, K> | readonly Permission<string, T, K>[],
  condition?: GrantCondition<T, K>,
): Omit<Grant, "role" | "scope"> | Omit<Grant, "role" | "scope">[];
/**
 * Every action of a resource (`permissions.post`), of several, or of the whole
 * tree, unconditionally. Each grant is listed in the policy as if written out,
 * and an action added to the resource later is granted too.
 */
export function allow(
  permissions: PermissionTree | readonly (Permission | PermissionTree)[],
): Omit<Grant, "role" | "scope"> | Omit<Grant, "role" | "scope">[];
export function allow(
  permission:
    | Permission
    | readonly (Permission | PermissionTree)[]
    | PermissionTree,
  condition?: unknown,
): Omit<Grant, "role" | "scope"> | Omit<Grant, "role" | "scope">[] {
  const permissions = flattenPermissions(permission);
  // SAFETY: T and K only type the caller's closure and where input; makeGrant takes the erased form.
  const grants = permissions.map((leaf) =>
    makeGrant(
      leaf,
      "allow",
      condition as GrantOptions | ClosureGrantFn | undefined,
    ),
  );
  return sole(grants) ?? grants;
}

export function deny<T, K extends PermissionKind = PermissionKind>(
  permission: Permission<string, T, K> | readonly Permission<string, T, K>[],
  condition?: GrantCondition<T, K>,
): Omit<Grant, "role" | "scope"> | Omit<Grant, "role" | "scope">[];
/**
 * Every action of a resource, of several, or of the whole tree,
 * unconditionally.
 */
export function deny(
  permissions: PermissionTree | readonly (Permission | PermissionTree)[],
): Omit<Grant, "role" | "scope"> | Omit<Grant, "role" | "scope">[];
export function deny(
  permission:
    | Permission
    | readonly (Permission | PermissionTree)[]
    | PermissionTree,
  condition?: unknown,
): Omit<Grant, "role" | "scope"> | Omit<Grant, "role" | "scope">[] {
  const permissions = flattenPermissions(permission);
  // SAFETY: T and K only type the caller's closure and where input; makeGrant takes the erased form.
  const grants = permissions.map((leaf) =>
    makeGrant(
      leaf,
      "deny",
      condition as GrantOptions | ClosureGrantFn | undefined,
    ),
  );
  return sole(grants) ?? grants;
}

export function flattenGrants(
  grants: readonly (
    | Omit<Grant, "role" | "scope">
    | readonly Omit<Grant, "role" | "scope">[]
  )[],
): Omit<Grant, "role" | "scope">[] {
  const out: Omit<Grant, "role" | "scope">[] = [];
  for (const grant of grants) {
    if (Array.isArray(grant)) {
      // SAFETY: Array.isArray does not narrow a readonly array; the array form is a grant list.
      out.push(...(grant as readonly Omit<Grant, "role" | "scope">[]));
    } else {
      // SAFETY: arrays take the branch above, so this is a single grant.
      out.push(grant as Omit<Grant, "role" | "scope">);
    }
  }
  return out;
}

export function completeGrant(grant: Omit<Grant, "role" | "scope">): Grant {
  const to = flattenGrantee(grant.to);
  const first = to[0];
  const placeholder =
    to.length === 1 && first?.kind === "role" && first.role === "";
  if (placeholder) {
    throw new Error("PermDock: grant is missing to");
  }
  return freezeDeep({
    ...grant,
    role: roleNameOf(grant.to),
    scope: roleScopeOf(grant.to),
  });
}
