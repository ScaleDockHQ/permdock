import { dirname, extname, relative } from "node:path";

export type HookKind = "react" | "vue" | "svelte" | "solid";

type Binding = {
  readonly entry: string;
  /** The adapter's instance getter, bound to the policy's vocabulary. */
  readonly instance: string;
  /** The held-roles reader, whose `scope` option narrows to the policy's scopes. */
  readonly roles: string;
  /** The roles reader's parameter, around `RolesOptions`. */
  readonly rolesParam: string;
  /** The framework type the parameter needs, if any. */
  readonly frameworkType?: string;
};

const BINDINGS: Readonly<Record<HookKind, Binding>> = {
  react: {
    entry: "permdock/react",
    instance: "usePermDock",
    roles: "useRoles",
    rolesParam: "RolesOptions",
  },
  vue: {
    entry: "permdock/vue",
    instance: "usePermDock",
    roles: "useRoles",
    rolesParam: "MaybeRefOrGetter<RolesOptions>",
    frameworkType: 'import type { MaybeRefOrGetter } from "vue";',
  },
  svelte: {
    entry: "permdock/svelte",
    instance: "getPermDock",
    roles: "roles",
    rolesParam: "() => RolesOptions",
  },
  solid: {
    entry: "permdock/solid",
    instance: "usePermDock",
    roles: "useRoles",
    rolesParam: "Accessor<RolesOptions>",
    frameworkType: 'import type { Accessor } from "solid-js";',
  },
};

/**
 * The value exports of each UI entry, in the order `tests/bundle` records them.
 * A named list keeps the module's export set static for bundlers and knip;
 * `tests/bundle` fails when an entry gains or loses a name.
 */
export const HOOK_EXPORTS: Readonly<Record<HookKind, readonly string[]>> = {
  react: [
    "PermDockProvider",
    "Protected",
    "approvalHeaders",
    "authzChangeRefresh",
    "broadcastChannelRefresh",
    "describe",
    "eventSourceRefresh",
    "focusRefresh",
    "onlineRefresh",
    "requiredPlans",
    "useApproval",
    "useAssignablePermissions",
    "useAssignableRoles",
    "useDecision",
    "useDescribe",
    "useFilter",
    "useGate",
    "useMemberships",
    "usePermDock",
    "usePermission",
    "usePermissions",
    "useProtectedAction",
    "useRefreshOn",
    "useRoles",
    "useSubject",
    "useTenant",
    "visibilityRefresh",
  ],
  vue: [
    "PermissionBoundary",
    "Protected",
    "approvalHeaders",
    "authzChangeRefresh",
    "broadcastChannelRefresh",
    "describe",
    "eventSourceRefresh",
    "focusRefresh",
    "permdockPlugin",
    "requiredPlans",
    "useApproval",
    "useAssignablePermissions",
    "useAssignableRoles",
    "useDescribe",
    "useFilter",
    "useGate",
    "useMemberships",
    "usePermDock",
    "usePermission",
    "usePermissionBoundary",
    "usePermissions",
    "useProtectedAction",
    "useRoles",
    "useSubject",
    "useTenant",
    "visibilityRefresh",
  ],
  svelte: [
    "PermissionBoundary",
    "Protected",
    "approval",
    "approvalHeaders",
    "assignable",
    "assignablePermissions",
    "authzChangeRefresh",
    "broadcastChannelRefresh",
    "describe",
    "eventSourceRefresh",
    "filtered",
    "focusRefresh",
    "gate",
    "getDescribe",
    "getPermDock",
    "memberships",
    "permission",
    "permissions",
    "protectedAction",
    "requiredPlans",
    "roles",
    "setPermDock",
    "subject",
    "tenant",
    "visibilityRefresh",
  ],
  solid: [
    "PermDockProvider",
    "PermissionBoundary",
    "Protected",
    "approvalHeaders",
    "authzChangeRefresh",
    "broadcastChannelRefresh",
    "describe",
    "eventSourceRefresh",
    "focusRefresh",
    "requiredPlans",
    "useApproval",
    "useAssignablePermissions",
    "useAssignableRoles",
    "useDescribe",
    "useFilter",
    "useGate",
    "useMemberships",
    "usePermDock",
    "usePermission",
    "usePermissionBoundary",
    "usePermissions",
    "useProtectedAction",
    "useRoles",
    "useSubject",
    "useTenant",
    "visibilityRefresh",
  ],
};

const JS_EXTENSION: Readonly<Record<string, string>> = {
  ".ts": ".js",
  ".tsx": ".js",
  ".mts": ".mjs",
  ".cts": ".cjs",
};

/**
 * The specifier from the generated file to the policy module. A `.ts` source is
 * named by its `.js` output, which both `bundler` and `nodenext` resolution map
 * back to the source.
 */
export function policySpecifier(outFile: string, policy: string): string {
  const extension = extname(policy);
  const target = `${policy.slice(0, policy.length - extension.length)}${JS_EXTENSION[extension] ?? extension}`;
  const path = relative(dirname(outFile), target).split("\\").join("/");
  return path.startsWith(".") ? path : `./${path}`;
}

/** One line when it fits the formatter's 80 columns, else a wrapped tail. */
function fitted(head: string, tail: string): string {
  const line = `${head} ${tail}`;
  return line.length <= 80 ? line : `${head}\n  ${tail}`;
}

/**
 * A typed hook file for a UI adapter: the instance getter bound to
 * `VocabularyOf<typeof policy>` and the roles reader narrowed to its scopes, so
 * call sites need no generic; every other export passes through by name. It
 * reaches the policy through `import type` only, so the client bundle never
 * includes it, and carries `"use client"` because the entries it re-exports are
 * client modules.
 */
export function hooksModule(
  kind: HookKind,
  specifier: string,
  header: string,
): string {
  const binding = BINDINGS[kind];
  const passed = HOOK_EXPORTS[kind].filter(
    (name) => name !== binding.instance && name !== binding.roles,
  );
  return `${[
    header,
    `"use client";`,
    `import type { VocabularyOf } from "permdock";
import type { ClientPermDock, RolesOptions as BaseRolesOptions } from "${binding.entry}";${binding.frameworkType === undefined ? "" : `\n${binding.frameworkType}`}
import type { ScopeName } from "./constants.ts";

import {
  ${binding.instance} as ${binding.instance}Of,
  ${binding.roles} as ${binding.roles}Of,
} from "${binding.entry}";

import type * as source from ${JSON.stringify(specifier)};`,
    `type Policy = typeof source extends { readonly policy: infer P }
  ? P
  : typeof source extends { readonly default: infer P }
    ? P
    : never;`,
    `/** The configured policy's vocabulary: its permissions, roles and plans. */
export type Vocabulary = VocabularyOf<Policy>;`,
    `export type RolesOptions = Omit<BaseRolesOptions, "scope"> & {
  readonly scope?: ScopeName;
};`,
    fitted(
      `export const ${binding.instance}: () => ClientPermDock<Vocabulary> =`,
      `${binding.instance}Of;`,
    ),
    `export const ${binding.roles}: (
  options?: ${binding.rolesParam},
) => ReturnType<typeof ${binding.roles}Of> = ${binding.roles}Of;`,
    `export {\n${passed.map((name) => `  ${name},`).join("\n")}\n} from "${binding.entry}";`,
  ].join("\n\n")}\n`;
}
