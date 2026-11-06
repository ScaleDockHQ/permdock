import type { ResolvedNames } from "../sql/resolve-names.ts";
import type { RlsStorageBucket } from "../types.ts";
import type { GenModel } from "./model.ts";

import { configError } from "../core/errors.ts";
import { camelCase, pascalCase } from "./model.ts";

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
  doc: string,
): readonly string[] {
  const seen = new Map<string, string>();
  const lines: string[] = [];
  for (const [ident, source, code] of entries) {
    const other = seen.get(ident);
    if (other !== undefined) {
      throw configError(
        `PermDock CLI: ${kind} '${other}' and '${source}' both generate the export '${ident}'; rename one of them`,
      );
    }
    seen.set(ident, source);
    lines.push(
      `/** ${doc} \`${source}\`. */\nexport const ${ident} = ${code};`,
    );
  }
  return lines;
}

/**
 * `org:{organization}:quotes` to `orgQuotesTopic`, building
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
  return [`${ident}Topic`, topic, builder([...new Set(params)], body)];
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
  return [`${camelCase(bucket)}Path`, bucket, builder(params, body)];
}

function qualify(schema: string, name: string): string {
  return name.includes(".") ? name : `${schema}.${name}`;
}

const KEEP_FIELDS: ReadonlySet<string> = new Set(["table", "visible"]);

function unqualified(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? name : name.slice(dot + 1);
}

/**
 * One `export const` per SQL helper, so a module that needs one name does not
 * keep the rest. A function is named after its SQL name in camel case; a table
 * or view after its resource.
 */
function sqlExports(names: ResolvedNames): readonly string[] {
  const exports: string[] = [];
  const seen = new Set<string>();
  const add = (ident: string, value: string): void => {
    if (seen.has(ident)) {
      throw configError(
        `PermDock CLI: two SQL names both generate the export '${ident}'; rename one of them`,
      );
    }
    seen.add(ident);
    exports.push(`export const ${ident} = ${JSON.stringify(value)} as const;`);
  };
  const groups: readonly Readonly<
    Record<string, Readonly<Record<string, string | undefined>>>
  >[] = [names.scopes, names.resources];
  for (const group of groups) {
    for (const [name, helpers] of Object.entries(group)) {
      for (const [field, value] of Object.entries(helpers)) {
        if (value === undefined || field === "idType") {
          continue;
        }
        if (KEEP_FIELDS.has(field)) {
          add(`${camelCase(name)}${pascalCase(field)}`, value);
        } else {
          add(camelCase(unqualified(value)), qualify(names.schema, value));
        }
      }
    }
  }
  return exports;
}

function union(name: string, values: readonly string[]): string {
  return `export type ${name} = ${values.length === 0 ? "never" : values.map((value) => JSON.stringify(value)).join(" | ")};`;
}

function tuple(
  name: string,
  type: string,
  values: readonly string[],
): readonly string[] {
  return [
    union(type, values),
    `export const ${name} = ${JSON.stringify(values)} as const satisfies readonly ${type}[];`,
  ];
}

/**
 * `constants.ts`: scope, role, permission and operation names, topic and path
 * builders. Both sides of the app import it; it holds no state and no server
 * name.
 */
export function constantsModule(model: GenModel, header: string): string {
  const parts = [
    header,
    tuple(
      "scopeNames",
      "ScopeName",
      model.scopes.map((scope) => scope.name),
    ).join("\n"),
    tuple("roleNames", "RoleName", model.roles).join("\n"),
    tuple(
      "permissionKeys",
      "PermissionKey",
      model.labels.permissions.map(([permission]) => permission),
    ).join("\n"),
  ];
  if (model.plans.length > 0) {
    parts.push(tuple("planNames", "PlanName", model.plans).join("\n"));
  }
  if (model.operations.length > 0) {
    parts.push(
      tuple(
        "operationNames",
        "OperationName",
        model.operations.map((operation) => operation.name),
      ).join("\n"),
    );
  }
  parts.push(
    ...distinct(
      "topic",
      model.topics.map(topicBuilder),
      "The `rls.realtime.topics` channel",
    ),
    ...distinct(
      "bucket",
      model.buckets.map(([bucket, config]) => pathBuilder(bucket, config)),
      "The `rls.storage.buckets` object path for",
    ),
  );
  return `${parts.join("\n\n")}\n`;
}

/**
 * `sql.ts`: the SQL helper names `rls generate` writes, one export each. The
 * module is server-only: helper names are a server concern.
 */
export function sqlModule(model: GenModel, header: string): string {
  const claims = `/** The claim names the generated helpers read. */
export const claimNames = ${JSON.stringify(model.names.claims, null, 2)} as const;`;
  return `${[
    header,
    'import "server-only";',
    `/** The schema the generated helpers live in. */
export const helperSchema = ${JSON.stringify(model.names.schema)} as const;`,
    claims,
    ...sqlExports(model.names),
  ].join("\n\n")}\n`;
}
