import type { CompiledPolicy, SqlCommand } from "./rls-compile.ts";
import type { RlsSqlContext } from "./rls-sql.ts";
import type {
  RlsPermissionRef,
  RlsRealtime,
  RlsStorage,
  RlsStorageBucket,
} from "./types.ts";

import { qualified } from "./rls-helpers.ts";
import { permittedIdsHelper, quoteLiteral } from "./rls-sql.ts";

/** What the policies may name: the declared scopes and the permission keys with and without row conditions. */
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
    throw new Error(
      `PermDock CLI: the ${prefix} policy name ${full} is longer than Postgres's 63 bytes; shorten '${name}'`,
    );
  }
  return full;
}

function grantKey(
  facts: HelperTableFacts,
  ref: RlsPermissionRef | undefined,
  where: string,
): string | undefined {
  if (ref === undefined) {
    return undefined;
  }
  const key: unknown =
    typeof ref === "object" && ref !== null ? Reflect.get(ref, "key") : ref;
  if (typeof key !== "string" || !facts.keys.has(key)) {
    throw new Error(
      `PermDock CLI: ${where} must be a permission reference from the definitions (got ${JSON.stringify(key)})`,
    );
  }
  if (facts.rowConditions.has(key)) {
    throw new Error(
      `PermDock CLI: ${where} is ${key}, whose grants carry row conditions the policy cannot check; use a permission with rowConditions: false`,
    );
  }
  return key;
}

function declaredScope(
  facts: HelperTableFacts,
  scope: string,
  where: string,
): string {
  if (!facts.scopes.has(scope)) {
    throw new Error(
      `PermDock CLI: ${where} names the scope '${scope}', which definePolicy({ scopes }) does not declare`,
    );
  }
  return scope;
}

/** The ids of `scope` where the subject holds `key`, as text: `<value> in (…)`. */
function permitted(
  ctx: RlsSqlContext,
  value: string,
  scope: string,
  key: string,
): string {
  return `${value} in (select x::text from ${qualified(ctx, permittedIdsHelper(scope))}(${quoteLiteral(key)}) x)`;
}

function escapeRegex(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

function realtimePolicies(
  ctx: RlsSqlContext,
  facts: HelperTableFacts,
  realtime: RlsRealtime,
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
      throw new Error(
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
    const read = grantKey(facts, topic.read, `${where}.read`);
    const write = grantKey(facts, topic.write, `${where}.write`);
    if (read === undefined) {
      throw new Error(`PermDock CLI: ${where}.read is required`);
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
    throw new Error(
      `PermDock CLI: ${where}.folder must be a positive integer (got ${String(folder)})`,
    );
  }
  return folder;
}

function storagePolicies(
  ctx: RlsSqlContext,
  facts: HelperTableFacts,
  storage: RlsStorage,
): CompiledPolicy[] {
  return Object.entries(storage.buckets).flatMap(([id, bucket]) => {
    const where = `rls.storage.buckets['${id}']`;
    const scope = declaredScope(facts, bucket.scope, `${where}.scope`);
    const folder = folderOf(bucket, where);
    const condition = (key: string): string =>
      `bucket_id = ${quoteLiteral(id)}
    and ${permitted(ctx, `(storage.foldername(name))[${String(folder)}]`, scope, key)}`;
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
      const key = grantKey(facts, ref, `${where}.${field}`);
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
      throw new Error(`PermDock CLI: ${where} needs read, write or delete`);
    }
    return policies;
  });
}

/**
 * The `realtime.messages` and `storage.objects` policies `rls.realtime` and
 * `rls.storage` describe. Each one admits a row only where the subject holds
 * the permission in the scope instance its topic segment or folder names, so
 * the helpers' API-key ceiling and suspension rules apply.
 */
export function realtimeStoragePolicies(
  ctx: RlsSqlContext,
  facts: HelperTableFacts,
  config: { readonly realtime?: RlsRealtime; readonly storage?: RlsStorage },
): readonly CompiledPolicy[] {
  if (config.realtime === undefined && config.storage === undefined) {
    return [];
  }
  if (ctx.dialect !== "supabase") {
    throw new Error(
      `PermDock CLI: rls.realtime and rls.storage need --dialect supabase (got ${ctx.dialect})`,
    );
  }
  const policies = [
    ...(config.realtime === undefined
      ? []
      : realtimePolicies(ctx, facts, config.realtime)),
    ...(config.storage === undefined
      ? []
      : storagePolicies(ctx, facts, config.storage)),
  ];
  const seen = new Set<string>();
  for (const { name } of policies) {
    if (seen.has(name)) {
      throw new Error(
        `PermDock CLI: two rls.realtime or rls.storage entries both name the policy ${name}; rename one`,
      );
    }
    seen.add(name);
  }
  return policies;
}
