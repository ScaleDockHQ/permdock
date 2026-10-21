import type { DoctorFinding, DoctorInput } from "../shared/doctor-types.ts";
import type { PermDockConfig } from "../types.ts";

import { listPermissions } from "../../index.ts";
import { describeError } from "../core/errors.ts";
import { resolveNames } from "../sql/resolve-names.ts";
import { policyOf } from "./inputs.ts";

const PLACEHOLDER = /\{([^{}]*)\}/gu;

/** The scope aliases `ScopeNames` admits next to the declared names. */
const ALIASES = ["tenant", "team"] as const;

type Kind = "scope" | "resource" | "action";

type Named = {
  readonly where: string;
  readonly kind: Kind;
  readonly name: string;
};

function keysOf(record: object | undefined): readonly string[] {
  return record === undefined ? [] : Object.keys(record);
}

function named(
  where: string,
  kind: Kind,
  names: readonly string[],
): readonly Named[] {
  return names.map((name) => ({ where, kind, name }));
}

function namedIn(config: PermDockConfig): readonly Named[] {
  const rls = config.rls;
  return [
    ...named("rls.tables", "resource", keysOf(rls?.tables)),
    ...named("rls.scopeTypes", "scope", keysOf(rls?.scopeTypes)),
    ...named("rls.actions", "action", keysOf(rls?.actions)),
    ...named(
      "rls.memberships.scopes",
      "scope",
      keysOf(rls?.memberships?.scopes),
    ),
    ...named("rls.suspension.scopes", "scope", keysOf(rls?.suspension?.scopes)),
    ...Object.keys(rls?.realtime?.topics ?? {}).flatMap((pattern) =>
      named(
        `rls.realtime.topics['${pattern}']`,
        "scope",
        [...pattern.matchAll(PLACEHOLDER)].map((match) => match[1] ?? ""),
      ),
    ),
    ...Object.entries(rls?.storage?.buckets ?? {}).flatMap(([name, bucket]) =>
      named(`rls.storage.buckets.${name}.scope`, "scope", [bucket.scope]),
    ),
    ...named(
      "powersync.resources",
      "resource",
      config.powersync?.resources ?? [],
    ),
    ...named(
      "powersync.action",
      "action",
      config.powersync?.action === undefined ? [] : [config.powersync.action],
    ),
  ];
}

/**
 * PD077: a config key or value names a scope, resource or action the policy
 * does not declare, such as a Realtime topic `{organisation}` placeholder for
 * the scope `organization`. `defineConfig` with the policy value reports the
 * same names at compile time. Also a SQL helper name `resolveNames` rejects:
 * two sources sharing one, or one Postgres cannot hold.
 */
export async function pd077(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
  if (input.config.policy === undefined) {
    return [];
  }
  const policy = await policyOf(input);
  if (policy === undefined) {
    return [];
  }
  const leaves = listPermissions(policy.vocabulary.permissions);
  const declared: Readonly<Record<Kind, ReadonlySet<string>>> = {
    scope: new Set([...policy.scopes.map((scope) => scope.name), ...ALIASES]),
    resource: new Set(leaves.map((leaf) => leaf.resource)),
    action: new Set(leaves.map((leaf) => leaf.action)),
  };
  const unknown = namedIn(input.config)
    .filter((entry) => !declared[entry.kind].has(entry.name))
    .map((entry): DoctorFinding => ({
      code: "PD077",
      severity: "error",
      message: `${entry.where} names the ${entry.kind} '${entry.name}', which the policy does not declare`,
      fix: `use one of ${[...declared[entry.kind]].toSorted().join(", ")}, or pass the policy value to defineConfig to catch this at compile time`,
    }));
  return [...unknown, ...helperNames(policy, input.config)];
}

function helperNames(
  policy: Parameters<typeof resolveNames>[0],
  config: PermDockConfig,
): readonly DoctorFinding[] {
  try {
    resolveNames(policy, config);
    return [];
  } catch (cause) {
    return [
      {
        code: "PD077",
        severity: "error",
        message: describeError(cause).replace(/^PermDock CLI: /u, ""),
        fix: "rename the scope or resource so each generated SQL helper has its own name of at most 63 bytes",
      },
    ];
  }
}
