import type { Permission, PermissionTree } from "./permission-types.ts";
import type {
  ActivationOption,
  ActivationSpec,
  AssuranceRequirement,
  Grant,
  RoleBinding,
  RoleOptions,
  RoleScope,
} from "./policy-types.ts";

import { activationApproval } from "./approval-normalize.ts";
import { compact } from "./compact.ts";
import { freezeDeep } from "./freeze.ts";
import { flattenGrants, flattenPermissions } from "./grant-builders.ts";
import { asGrantee, flattenGrantee, roleScopeOf } from "./grantee.ts";
import { isForbiddenKey } from "./paths.ts";
import { assertDuration } from "./time.ts";
import { type Role as RoleLeaf, isRole } from "./vocabulary.ts";

function resolveRoleScope(on: RoleScope | undefined): Grant["scope"] {
  if (on === undefined) {
    return "global";
  }
  if (typeof on === "string") {
    if (on === "global" || on === "resource") {
      throw new Error(`PermDock: role on: '${on}' is not a scope name`);
    }
    return on;
  }
  // SAFETY: strings returned above; flattenPermissions recurses, so trees inside an array work.
  const permissions = flattenPermissions(
    on as Permission | PermissionTree | readonly Permission[],
  );
  const names = new Set(permissions.map((permission) => permission.resource));
  const [resource] = names;
  if (names.size !== 1 || resource === undefined) {
    throw new Error(
      "PermDock: role on: resource must name exactly one resource",
    );
  }
  return { resource };
}

type RoleGrants = readonly (
  | Omit<Grant, "role" | "scope">
  | readonly Omit<Grant, "role" | "scope">[]
)[];

/**
 * A role held at a named scope: `on` is checked against `definePolicy({ scopes
 * })`.
 */
export function role<const S extends string>(
  name: string | RoleLeaf,
  grants: RoleGrants,
  options: RoleOptions<S> & { readonly on: S },
): RoleBinding<S>;

/** A global role, or one held on a resource. */
export function role(
  name: string | RoleLeaf,
  grants: RoleGrants,
  options?: RoleOptions<never>,
): RoleBinding<never>;

/** Options built at runtime: the scope name is only checked by `definePolicy`. */
export function role(
  name: string | RoleLeaf,
  grants: RoleGrants,
  options?: RoleOptions,
): RoleBinding;

export function role(
  name: string | RoleLeaf,
  grants: RoleGrants,
  options?: RoleOptions,
): RoleBinding {
  if (options !== undefined && Object.hasOwn(options, "restricted")) {
    throw new Error(`PermDock: role option 'restricted' is reserved`);
  }
  const leaf = isRole(name) ? name : undefined;
  // SAFETY: the right side runs only when name is not a role leaf, so it is the string form.
  const roleName = leaf?.key ?? (name as string);
  const scope = resolveRoleScope(options?.on ?? leaf?.on);
  const assignable =
    options?.assignable ?? leaf?.assignable ?? scope !== "global";
  const rules = roleRules(roleName, scope, options);
  const activation = normalizeActivation(roleName, options?.activation);
  const roleGrantee = asGrantee(
    freezeDeep({ kind: "role" as const, role: roleName, scope }),
  );
  const normalised = flattenGrants(grants).map((grant) => {
    const items = flattenGrantee(grant.to);
    const first = items[0];
    const roleTo = items.length === 1 && first?.kind === "role";
    const to = roleTo ? roleGrantee : grant.to;
    return freezeDeep({
      ...grant,
      to,
      role: roleName,
      scope: roleScopeOf(to, scope),
    });
  });
  return freezeDeep(
    compact<RoleBinding>({
      name: roleName,
      grants: normalised,
      on: options?.on ?? leaf?.on,
      assignable,
      exclusiveWith: options?.exclusiveWith,
      ...rules,
      meta: options?.meta ?? leaf?.meta,
      activation,
    }),
  );
}

function normalizeActivation(
  roleName: string,
  option: ActivationOption | undefined,
): ActivationSpec | undefined {
  if (option === undefined) {
    return undefined;
  }
  const justification = option.justification ?? "optional";
  if (justification !== "required" && justification !== "optional") {
    throw new Error(
      `PermDock: role '${roleName}' activation justification must be 'required' or 'optional'`,
    );
  }
  if (option.maxDuration !== undefined) {
    assertDuration(
      option.maxDuration,
      `activation.maxDuration on role '${roleName}'`,
    );
  }
  return compact<ActivationSpec>({
    maxDuration: option.maxDuration,
    justification,
    approval: activationApproval(option.approval, roleName),
    assurance: normalizeAssurance(option.assurance),
  });
}

export function normalizeAssurance(
  input: AssuranceRequirement | undefined,
): AssuranceRequirement | undefined {
  if (input === undefined) {
    return undefined;
  }
  const acr =
    input.acr === undefined || input.acr.length === 0
      ? undefined
      : Object.freeze([...input.acr]);
  const amr =
    input.amr === undefined || input.amr.length === 0
      ? undefined
      : Object.freeze([...input.amr]);
  const maxAge =
    typeof input.maxAge === "number" && input.maxAge >= 0
      ? input.maxAge
      : undefined;
  if (acr === undefined && amr === undefined && maxAge === undefined) {
    return undefined;
  }
  return compact<AssuranceRequirement>({ maxAge, acr, amr });
}

type RoleRules = Pick<
  RoleBinding,
  "min" | "max" | "transferOnly" | "assigns" | "for"
>;

function nameList(
  roleName: string,
  option: string,
  value: unknown,
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.some(
      (item) => typeof item !== "string" || item === "" || isForbiddenKey(item),
    )
  ) {
    throw new Error(
      `PermDock: role '${roleName}' ${option} must be a list of names`,
    );
  }
  // SAFETY: the check above throws unless value is an array of non-empty, safe strings.
  return [...new Set(value as readonly string[])];
}

function holderCount(
  roleName: string,
  option: string,
  value: unknown,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `PermDock: role '${roleName}' ${option} must be a whole number of holders`,
    );
  }
  return value;
}

/**
 * Ownership rules count holders per scope instance, so they need a named-scope
 * role.
 */
function roleRules(
  roleName: string,
  scope: Grant["scope"],
  options: RoleOptions | undefined,
): RoleRules {
  const min = holderCount(roleName, "min", options?.min);
  const max = holderCount(roleName, "max", options?.max);
  const transferOnly = options?.transferOnly;
  if (transferOnly !== undefined && typeof transferOnly !== "boolean") {
    throw new Error(
      `PermDock: role '${roleName}' transferOnly must be a boolean`,
    );
  }
  if (max !== undefined && max < 1) {
    throw new Error(`PermDock: role '${roleName}' max must be at least 1`);
  }
  if (min !== undefined && max !== undefined && min > max) {
    throw new Error(`PermDock: role '${roleName}' min must not exceed max`);
  }
  const counted =
    (min !== undefined && min > 0) ||
    max !== undefined ||
    transferOnly === true;
  if (counted && (typeof scope !== "string" || scope === "global")) {
    throw new Error(
      `PermDock: role '${roleName}' min, max and transferOnly need on: '<scope>'`,
    );
  }
  return compact<RoleRules>({
    min,
    max,
    transferOnly,
    assigns: nameList(roleName, "assigns", options?.assigns),
    for: nameList(roleName, "for", options?.for),
  });
}
