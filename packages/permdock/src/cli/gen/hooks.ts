import { dirname, extname, relative } from "node:path";

import { GENERATED } from "./schemas.ts";

export type HookKind = "react" | "vue" | "svelte" | "solid";

type Binding = {
  readonly entry: string;
  /** The adapter's instance getter, bound to the policy's vocabulary. */
  readonly instance: string;
  /** The held-roles reader, whose `scope` option narrows to the policy's scopes. */
  readonly roles: string;
  /** The roles reader's parameter, around `AppRolesOptions`. */
  readonly rolesParam: string;
  /** The framework type the parameter needs, if any. */
  readonly frameworkType?: string;
};

const BINDINGS: Readonly<Record<HookKind, Binding>> = {
  react: {
    entry: "permdock/react",
    instance: "usePermDock",
    roles: "useRoles",
    rolesParam: "AppRolesOptions",
  },
  vue: {
    entry: "permdock/vue",
    instance: "usePermDock",
    roles: "useRoles",
    rolesParam: "MaybeRefOrGetter<AppRolesOptions>",
    frameworkType: 'import type { MaybeRefOrGetter } from "vue";',
  },
  svelte: {
    entry: "permdock/svelte",
    instance: "getPermDock",
    roles: "roles",
    rolesParam: "() => AppRolesOptions",
  },
  solid: {
    entry: "permdock/solid",
    instance: "usePermDock",
    roles: "useRoles",
    rolesParam: "Accessor<AppRolesOptions>",
    frameworkType: 'import type { Accessor } from "solid-js";',
  },
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
 * call sites need no generic; every other export passes through. It reaches the
 * policy through `import type` only, so the client bundle never includes it.
 */
export function hooksModule(kind: HookKind, specifier: string): string {
  const binding = BINDINGS[kind];
  return `${[
    GENERATED,
    `import type { ScopeNameOf, VocabularyOf } from "permdock";
import type { ClientPermDock, RolesOptions } from "${binding.entry}";${binding.frameworkType === undefined ? "" : `\n${binding.frameworkType}`}

import {
  ${binding.instance} as ${binding.instance}Of,
  ${binding.roles} as ${binding.roles}Of,
} from "${binding.entry}";

import type * as source from ${JSON.stringify(specifier)};`,
    `type AppPolicy = typeof source extends { readonly policy: infer P }
  ? P
  : typeof source extends { readonly default: infer P }
    ? P
    : never;`,
    `/** The configured policy's vocabulary: its permissions, roles and plans. */
export type AppVocabulary = VocabularyOf<AppPolicy>;`,
    `/** A scope the configured policy declares. */
export type AppScope = ScopeNameOf<AppPolicy>;`,
    `export type AppRolesOptions = Omit<RolesOptions, "scope"> & {
  readonly scope?: AppScope;
};`,
    fitted(
      `export const ${binding.instance}: () => ClientPermDock<AppVocabulary> =`,
      `${binding.instance}Of;`,
    ),
    `export const ${binding.roles}: (
  options?: ${binding.rolesParam},
) => ReturnType<typeof ${binding.roles}Of> = ${binding.roles}Of;`,
    `export * from "${binding.entry}";`,
  ].join("\n\n")}\n`;
}
