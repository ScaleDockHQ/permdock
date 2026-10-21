import type { ResolvedNames } from "../sql/resolve-names.ts";
import type { RlsStorageBucket } from "../types.ts";
import type { GenModel } from "./model.ts";

import { configError } from "../core/errors.ts";
import { camelCase } from "./model.ts";
import { GENERATED } from "./schemas.ts";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const PLACEHOLDER = /\{([^{}]+)\}/gu;

function key(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function read(name: string): string {
  return IDENTIFIER.test(name)
    ? `params.${name}`
    : `params[${JSON.stringify(name)}]`;
}

/** Text for inside a template literal. */
function templateText(text: string): string {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("${", "\\${");
}

function builder(params: readonly string[], body: string): string {
  const fields = params.map((name) => `readonly ${key(name)}: string`);
  return `(params: { ${fields.join("; ")} }): string => \`${body}\``;
}

function distinct(
  kind: string,
  entries: readonly (readonly [string, string, string])[],
): string {
  const seen = new Map<string, string>();
  const lines: string[] = [];
  for (const [ident, source, code] of entries) {
    const other = seen.get(ident);
    if (other !== undefined) {
      throw configError(
        `PermDock CLI: ${kind} '${other}' and '${source}' both generate the builder '${ident}'; rename one of them`,
      );
    }
    seen.set(ident, source);
    lines.push(`  ${key(ident)}: ${code},`);
  }
  return lines.length === 0 ? "{}" : `{\n${lines.join("\n")}\n}`;
}

/**
 * `org:{organization}:quotes` to `orgQuotes`, building
 * `org:${organization}:quotes`.
 */
function topicBuilder(topic: string): readonly [string, string, string] {
  const params = [...topic.matchAll(PLACEHOLDER)].map((match) =>
    String(match[1]),
  );
  const fixed = topic.replaceAll(PLACEHOLDER, " ");
  const camel = camelCase(fixed);
  const ident = camel === "" ? camelCase(topic) : camel;
  let body = "";
  let last = 0;
  for (const match of topic.matchAll(PLACEHOLDER)) {
    body += `${templateText(topic.slice(last, match.index))}\${${read(String(match[1]))}}`;
    last = match.index + match[0].length;
  }
  body += templateText(topic.slice(last));
  return [ident, topic, builder([...new Set(params)], body)];
}

/**
 * A bucket's object path: `folder - 1` leading segments, the scope id, then
 * `name`, as `storage.foldername(name)` reads it.
 */
function pathBuilder(
  bucket: string,
  config: RlsStorageBucket,
): readonly [string, string, string] {
  const leading = Array.from(
    { length: Math.max(0, (config.folder ?? 1) - 1) },
    (_, index) => `segment${String(index + 1)}`,
  );
  const params = [...leading, config.scope, "name"];
  const body = params.map((name) => `\${${read(name)}}`).join("/");
  return [camelCase(bucket), bucket, builder(params, body)];
}

function qualify(schema: string, name: string): string {
  return name.includes(".") ? name : `${schema}.${name}`;
}

/** Every helper name schema-qualified; tables and views keep their own schema. */
function sqlNames(names: ResolvedNames): Record<string, unknown> {
  const fn = (name: string): string => qualify(names.schema, name);
  const map = (
    entries: Readonly<Record<string, Readonly<Record<string, string>>>>,
    keep: ReadonlySet<string>,
  ): Record<string, Record<string, string>> =>
    Object.fromEntries(
      Object.entries(entries).map(([name, helpers]) => [
        name,
        Object.fromEntries(
          Object.entries(helpers).map(([field, value]) => [
            field,
            keep.has(field) ? value : fn(value),
          ]),
        ),
      ]),
    );
  return {
    schema: names.schema,
    claims: names.claims,
    scopes: map(names.scopes, new Set()),
    resources: map(names.resources, new Set(["table", "visible"])),
  };
}

function list(name: string, type: string, values: readonly string[]): string {
  return `export const ${name} = ${JSON.stringify(values)} as const;
export type ${type} = (typeof ${name})[number];`;
}

/** `constants`: scope and role names, topic and path builders, SQL names. */
export function constantsModule(model: GenModel): string {
  const blocks = [
    GENERATED,
    list(
      "scopes",
      "ScopeName",
      model.scopes.map((scope) => scope.name),
    ),
    list("roles", "RoleName", model.roles),
    `/** \`rls.realtime.topics\`: the channel names the realtime policies match. */
export const topics = ${distinct("topic", model.topics.map(topicBuilder))} as const;`,
    `/** \`rls.storage.buckets\`: object paths that start with a scope id. */
export const paths = ${distinct(
      "bucket",
      model.buckets.map(([bucket, config]) => pathBuilder(bucket, config)),
    )} as const;`,
    `/** The SQL helpers \`rls generate\` writes. */
export const sqlNames = ${JSON.stringify(sqlNames(model.names), null, 2)} as const;`,
  ];
  return `${blocks.join("\n\n")}\n`;
}
