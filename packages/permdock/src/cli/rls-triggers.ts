import type { RlsAudit, RlsTrigger } from "./types.ts";

import { CUSTOM_ROLES } from "./rls-shared.ts";
import { quoteIdent, quoteLiteral, quoteTable } from "./rls-sql.ts";

const PREFIX = "PermDock CLI";
const EVENTS = new Set(["insert", "update", "delete", "truncate"]);
const AUDITED = [CUSTOM_ROLES.permissions, CUSTOM_ROLES.includes, "user_roles"];
const IDENT = /^[a-z_][a-z0-9_$]*$/u;

/** The tables `sql` creates in `schema`, by name without the schema. */
export function generatedTables(
  sql: string,
  schema: string,
): readonly string[] {
  const prefix = `create table if not exists ${quoteIdent(schema)}.`;
  const found = new Set<string>();
  for (const line of sql.split("\n")) {
    if (!line.startsWith(prefix)) {
      continue;
    }
    const name = /^"?([A-Za-z_][\w$]*)"?/u.exec(line.slice(prefix.length))?.[1];
    if (name !== undefined) {
      found.add(name);
    }
  }
  return [...found].toSorted();
}

function functionName(name: unknown, label: string): string {
  if (typeof name !== "string" || name.split(".").length !== 2) {
    throw new Error(
      `${PREFIX}: ${label} must be a schema-qualified function such as audit.log_change, got ${JSON.stringify(name)}`,
    );
  }
  return quoteTable(name);
}

function knownTable(
  table: string,
  tables: readonly string[],
  label: string,
): void {
  if (!tables.includes(table)) {
    throw new Error(
      `${PREFIX}: ${label} names ${table}, which rls generate does not create with this config; it creates ${tables.join(", ")}`,
    );
  }
}

function triggerSql(table: string, trigger: RlsTrigger, label: string): string {
  if (
    typeof trigger.name !== "string" ||
    trigger.name === "" ||
    trigger.name.toLowerCase().startsWith("permdock_")
  ) {
    throw new Error(
      `${PREFIX}: ${label}.name must be a name outside permdock_, which generated triggers use, got ${JSON.stringify(trigger.name)}`,
    );
  }
  if (trigger.when !== "before" && trigger.when !== "after") {
    throw new Error(`${PREFIX}: ${label}.when must be before or after`);
  }
  const events: readonly string[] = trigger.events;
  if (events.length === 0 || !events.every((event) => EVENTS.has(event))) {
    throw new Error(
      `${PREFIX}: ${label}.events must list insert, update, delete or truncate`,
    );
  }
  const level = trigger.level ?? "row";
  if (level !== "row" && level !== "statement") {
    throw new Error(`${PREFIX}: ${label}.level must be row or statement`);
  }
  if (level === "row" && events.includes("truncate")) {
    throw new Error(
      `${PREFIX}: ${label} fires on truncate, which Postgres allows only with level: 'statement'`,
    );
  }
  const fn = functionName(trigger.function, `${label}.function`);
  const args = (trigger.args ?? []).map((arg) => quoteLiteral(arg));
  const name = quoteIdent(trigger.name);
  return `drop trigger if exists ${name} on ${table};
create trigger ${name}
  ${trigger.when} ${[...new Set(events)].join(" or ")} on ${table}
  for each ${level} execute function ${fn}(${args.join(", ")});`;
}

/**
 * `rls.triggers`: the application's triggers on generated tables, after the
 * tables. A table this run does not create is an error, so a trigger never
 * silently goes missing.
 */
export function triggersSql(
  triggers: Readonly<Record<string, readonly RlsTrigger[]>> | undefined,
  schema: string,
  tables: readonly string[],
): string {
  if (triggers === undefined) {
    return "";
  }
  const chunks: string[] = [];
  for (const [table, list] of Object.entries(triggers).toSorted(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    knownTable(table, tables, `rls.triggers.${table}`);
    const target = `${quoteIdent(schema)}.${quoteIdent(table)}`;
    for (const [index, trigger] of list.entries()) {
      chunks.push(
        triggerSql(target, trigger, `rls.triggers.${table}[${String(index)}]`),
      );
    }
  }
  return chunks.length === 0
    ? ""
    : `-- rls.triggers: triggers the application owns on generated tables\n${chunks.join("\n")}\n`;
}

/**
 * `rls.audit`: one call of the audit function per generated table, which
 * registers the table with the application's audit module. Statements that
 * run code, so they travel with the seeds.
 */
export function auditSql(
  audit: RlsAudit | undefined,
  schema: string,
  tables: readonly string[],
): string {
  if (audit === undefined) {
    return "";
  }
  const fn = functionName(audit.function, "rls.audit.function");
  const listed = audit.tables;
  if (listed !== undefined) {
    for (const table of listed) {
      knownTable(table, tables, "rls.audit.tables");
    }
  }
  const targets = listed ?? AUDITED.filter((table) => tables.includes(table));
  const args = Object.entries(audit.args ?? {}).map(([name, value]) => {
    if (!IDENT.test(name)) {
      throw new Error(
        `${PREFIX}: rls.audit.args names ${JSON.stringify(name)}, which is not a lower-case parameter name`,
      );
    }
    return `, ${quoteIdent(name)} => ${quoteLiteral(value)}`;
  });
  if (targets.length === 0) {
    return "";
  }
  return `-- rls.audit: generated tables registered with ${audit.function}
${targets
  .map(
    (table) =>
      `select ${fn}(${quoteLiteral(`${quoteIdent(schema)}.${quoteIdent(table)}`)}::regclass${args.join("")});`,
  )
  .join("\n")}
`;
}
