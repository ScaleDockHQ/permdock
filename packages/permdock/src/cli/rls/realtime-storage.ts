import type { Policy } from "../../index.ts";
import type { CompiledPolicy, SqlCommand } from "../sql/compile.ts";
import type { RlsSqlContext } from "../sql/context.ts";
import type {
  RlsPermissionRef,
  RlsRealtime,
  RlsStorage,
  RlsStorageBucket,
} from "../types.ts";

import { configError } from "../core/errors.ts";
import { idTypeOf, scopeTypeOf } from "../sql/columns.ts";
import { tableFor } from "../sql/compile.ts";
import { graphSqlName } from "../sql/names.ts";
import { qualified, quoteLiteral, quoteQualified } from "../sql/quote.ts";
import { permittedByPermissionHelper } from "./permission-keys.ts";

/**
 * What the policies may name: the declared scopes and the permission keys with
 * and without row conditions.
 */
export type HelperTableFacts = {
  readonly scopes: ReadonlySet<string>;
  readonly keys: ReadonlySet<string>;
  readonly rowConditions: ReadonlySet<string>;
};

const SCOPE_SEGMENT = /^\{([a-z][a-z0-9_]*)\}$/u;
const LITERAL_SEGMENT = /^[^{}:\s]+$/u;
const TOPIC = "(select realtime.topic())";

function policyName(prefix: string, name: string, command: SqlCommand): string {
  const slug = name
    .replaceAll(/[^A-Za-z0-9]+/gu, "_")
    .replaceAll(/^_|_$/gu, "");
  const full = `permdock_${prefix}_${slug}_${command}`;
  if (new TextEncoder().encode(full).length > 63) {
    throw configError(
      `PermDock CLI: the ${prefix} policy name ${full} is longer than Postgres's 63 bytes; shorten '${name}'`,
    );
  }
  return full;
}

function grantKey(
  facts: HelperTableFacts,
  ref: RlsPermissionRef | undefined,
  where: string,
  warnings: string[],
  conditioned: "scope" | "row",
): string | undefined {
  if (ref === undefined) {
    return undefined;
  }
  const key: unknown =
    typeof ref === "object" && ref !== null ? Reflect.get(ref, "key") : ref;
  if (typeof key !== "string" || !facts.keys.has(key)) {
    throw configError(
      `PermDock CLI: ${where} must be a permission reference from the definitions (got ${JSON.stringify(key)})`,
    );
  }
  if (conditioned === "scope" && facts.rowConditions.has(key)) {
    warnings.push(
      `${where} is ${key}, whose grants carry row conditions (a relation, a where or another condition): the policy admits only the instances its role allows without a condition reach, through permitted_<scope>_ids_by_permission`,
    );
  }
  return key;
}

/**
 * Resources a storage bucket calls `can_<resource>(id, permission)` for. Those
 * id helpers have to exist even when `rls.rowHelpers` does not name them.
 */
export function storageResources(
  storage: RlsStorage | undefined,
): readonly string[] {
  if (storage === undefined) {
    return [];
  }
  const names = new Set<string>();
  for (const bucket of Object.values(storage.buckets)) {
    for (const ref of [bucket.read, bucket.write, bucket.delete]) {
      if (ref !== undefined) {
        names.add(resourceOf(ref.key));
      }
    }
  }
  return [...names].toSorted();
}

/** The resource a permission key names, before its action, group and level. */
function resourceOf(key: string): string {
  const base = key.split("#")[0]?.split("@")[0] ?? key;
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? base : base.slice(0, dot);
}

function declaredScope(
  facts: HelperTableFacts,
  scope: string,
  where: string,
): string {
  if (!facts.scopes.has(scope)) {
    throw configError(
      `PermDock CLI: ${where} names the scope '${scope}', which definePolicy({ scopes }) does not declare`,
    );
  }
  return scope;
}

/**
 * The ids of `scope` where the subject holds `key` through an allow without a
 * row condition, minus a deny of it, as text: `<value> in (…)`. A relationship
 * or a `where` on the same permission never widens it.
 */
function permitted(
  ctx: RlsSqlContext,
  value: string,
  scope: string,
  key: string,
): string {
  return `${value} in (select x::text from ${qualified(ctx, permittedByPermissionHelper(scope))}(${quoteLiteral(key)}) x)`;
}

function escapeRegex(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

function realtimePolicies(
  ctx: RlsSqlContext,
  facts: HelperTableFacts,
  realtime: RlsRealtime,
  warnings: string[],
): CompiledPolicy[] {
  return Object.entries(realtime.topics).flatMap(([pattern, topic]) => {
    const where = `rls.realtime.topics['${pattern}']`;
    const segments = pattern.split(":");
    const placeholders = segments.flatMap((segment, index) => {
      const match = SCOPE_SEGMENT.exec(segment);
      return match === null ? [] : [{ index, scope: match[1] ?? "" }];
    });
    const [placeholder] = placeholders;
    if (
      placeholder === undefined ||
      placeholders.length > 1 ||
      segments.some(
        (segment, index) =>
          index !== placeholder.index && !LITERAL_SEGMENT.test(segment),
      )
    ) {
      throw configError(
        `PermDock CLI: ${where} must be ':'-separated segments with exactly one '{<scope>}' segment, such as 'org:{organization}:chat'`,
      );
    }
    const scope = declaredScope(facts, placeholder.scope, where);
    const regex = `^${segments.map((segment, index) => (index === placeholder.index ? "[^:]+" : escapeRegex(segment))).join(":")}$`;
    const id = `split_part(${TOPIC}, ':', ${String(placeholder.index + 1)})`;
    const condition = (key: string): string =>
      `extension in ('broadcast', 'presence')
    and ${TOPIC} ~ ${quoteLiteral(regex)}
    and ${permitted(ctx, id, scope, key)}`;
    const read = grantKey(
      facts,
      topic.read,
      `${where}.read`,
      warnings,
      "scope",
    );
    const write = grantKey(
      facts,
      topic.write,
      `${where}.write`,
      warnings,
      "scope",
    );
    if (read === undefined) {
      throw configError(`PermDock CLI: ${where}.read is required`);
    }
    const policies: CompiledPolicy[] = [
      {
        name: policyName("realtime", pattern, "select"),
        table: "realtime.messages",
        command: "select",
        effect: "allow",
        roles: ["authenticated"],
        using: condition(read),
      },
    ];
    if (write !== undefined) {
      policies.push({
        name: policyName("realtime", pattern, "insert"),
        table: "realtime.messages",
        command: "insert",
        effect: "allow",
        roles: ["authenticated"],
        check: condition(write),
      });
    }
    return policies;
  });
}

function folderOf(bucket: RlsStorageBucket, where: string): number {
  const folder = bucket.folder ?? 1;
  if (!Number.isInteger(folder) || folder < 1) {
    throw configError(
      `PermDock CLI: ${where}.folder must be a positive integer (got ${String(folder)})`,
    );
  }
  return folder;
}

/**
 * The column that holds `scope` on `resource`: a `memberOf` relation's field.
 * The folder id is that scope instance, and also the resource id.
 */
function memberField(
  policy: Policy | undefined,
  resource: string,
  scope: string,
): string | undefined {
  const node = policy?.resources.get(resource);
  if (node === undefined) {
    return undefined;
  }
  for (const relation of Object.values(node.relations)) {
    if ("memberOf" in relation && relation.memberOf === scope) {
      return relation.field;
    }
  }
  return undefined;
}

function storagePolicies(
  ctx: RlsSqlContext,
  facts: HelperTableFacts,
  storage: RlsStorage,
  warnings: string[],
  policy: Policy | undefined,
): CompiledPolicy[] {
  return Object.entries(storage.buckets).flatMap(([id, bucket]) => {
    const where = `rls.storage.buckets['${id}']`;
    declaredScope(facts, bucket.scope, `${where}.scope`);
    const folder = folderOf(bucket, where);
    const condition = (key: string): string => {
      const resource = resourceOf(key);
      const sql = graphSqlName(resource);
      if (sql === undefined) {
        throw configError(
          `PermDock CLI: ${where} permission '${key}' does not name a SQL resource`,
        );
      }
      const path = `(storage.foldername(name))[${String(folder)}]`;
      const idType = idTypeOf(ctx, resource);
      const node = policy?.resources.get(resource);
      const idName = node?.id ?? "id";
      const pairs = [`${quoteLiteral(idName)}, ${path}::${idType}`];
      const scopeField = memberField(policy, resource, bucket.scope);
      if (scopeField !== undefined && scopeField !== idName) {
        pairs.push(
          `${quoteLiteral(scopeField)}, ${path}::${scopeTypeOf(ctx, bucket.scope)}`,
        );
      }
      const table = quoteQualified(tableFor(resource, ctx.graph?.tables));
      const row = `json_populate_record(null::${table}, json_build_object(${pairs.join(", ")}))`;
      return `bucket_id = ${quoteLiteral(id)}
    and ${qualified(ctx, `can_${sql}`)}(${row}, ${quoteLiteral(key)}::text)`;
    };
    const commands: readonly [
      SqlCommand,
      RlsPermissionRef | undefined,
      string,
    ][] = [
      ["select", bucket.read, "read"],
      ["insert", bucket.write, "write"],
      ["update", bucket.write, "write"],
      ["delete", bucket.delete, "delete"],
    ];
    const policies = commands.flatMap(([command, ref, field]) => {
      const key = grantKey(facts, ref, `${where}.${field}`, warnings, "row");
      if (key === undefined) {
        return [];
      }
      const expression = condition(key);
      return [
        {
          name: policyName("storage", id, command),
          table: "storage.objects",
          command,
          effect: "allow" as const,
          roles: ["authenticated"],
          ...(command === "insert" ? {} : { using: expression }),
          ...(command === "select" || command === "delete"
            ? {}
            : { check: expression }),
        },
      ];
    });
    if (policies.length === 0) {
      throw configError(`PermDock CLI: ${where} needs read, write or delete`);
    }
    return policies;
  });
}

/**
 * The `realtime.messages` and `storage.objects` policies `rls.realtime` and
 * `rls.storage` describe. A topic admits a row only where the subject holds the
 * permission in the scope instance its segment names, through an allow without
 * a row condition. A bucket builds a row whose id and scope column are the
 * folder, each cast to that column's type, and calls `can_<resource>` so the
 * resource's row conditions apply.
 */
export function realtimeStoragePolicies(
  ctx: RlsSqlContext,
  facts: HelperTableFacts,
  config: { readonly realtime?: RlsRealtime; readonly storage?: RlsStorage },
  warnings: string[] = [],
  policy?: Policy,
): readonly CompiledPolicy[] {
  if (config.realtime === undefined && config.storage === undefined) {
    return [];
  }
  if (ctx.dialect !== "supabase") {
    throw configError(
      `PermDock CLI: rls.realtime and rls.storage need --dialect supabase (got ${ctx.dialect})`,
    );
  }
  const policies = [
    ...(config.realtime === undefined
      ? []
      : realtimePolicies(ctx, facts, config.realtime, warnings)),
    ...(config.storage === undefined
      ? []
      : storagePolicies(ctx, facts, config.storage, warnings, policy)),
  ];
  const seen = new Set<string>();
  for (const { name } of policies) {
    if (seen.has(name)) {
      throw configError(
        `PermDock CLI: two rls.realtime or rls.storage entries both name the policy ${name}; rename one`,
      );
    }
    seen.add(name);
  }
  return policies;
}
