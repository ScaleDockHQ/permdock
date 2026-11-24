import type { DoctorFinding, DoctorInput } from "../shared/doctor-types.ts";

import { isRecord } from "../../core/compact.ts";
import { rel, sqlFiles } from "../files.ts";
import { importFromApp } from "../shared/app-peer.ts";
import { filesOf } from "../shared/doctor-files.ts";
import { SqlSyntaxError, functionArgTypes, parseSqlFile } from "../sql/ast.ts";
import { resolveSchemas } from "../supabase-schemas.ts";
import { tableOf } from "./perf-sql.ts";
import { underBetterSupabaseDoctor } from "./policy-count.ts";

const PG_TOPO = "@supabase/pg-topo";

type TopoRef = {
  readonly kind: string;
  readonly schema?: string;
  readonly name: string;
  readonly signature?: string;
};

type TopoStatementId = {
  readonly filePath: string;
  readonly statementIndex: number;
};

type TopoDiagnostic = {
  readonly code: string;
  readonly message: string;
  readonly statementId?: TopoStatementId;
  readonly objectRefs?: readonly TopoRef[];
  readonly details?: Readonly<Record<string, unknown>>;
};

type TopoNode = {
  readonly id: TopoStatementId;
  readonly sql: string;
  readonly provides: readonly TopoRef[];
};

type TopoResult = {
  readonly ordered: readonly TopoNode[];
  readonly diagnostics: readonly TopoDiagnostic[];
};

type PgTopo = {
  readonly analyzeAndSort: (sql: string[]) => Promise<TopoResult>;
};

function isPgTopo(value: unknown): value is PgTopo {
  return isRecord(value) && typeof value["analyzeAndSort"] === "function";
}

async function loadPgTopo(cwd: string): Promise<PgTopo | undefined> {
  const loaded = await importFromApp(cwd, PG_TOPO);
  return isPgTopo(loaded) ? loaded : undefined;
}

function refKey(ref: TopoRef): string {
  return `${ref.kind}:${ref.schema ?? ""}:${ref.name}:${ref.signature ?? ""}`;
}

/** `<input:3>` is the fourth SQL text passed to `analyzeAndSort`. */
function fileOf(files: readonly string[], filePath: string): string {
  const index = /^<input:(\d+)>$/u.exec(filePath)?.[1];
  return index === undefined ? filePath : (files[Number(index)] ?? filePath);
}

/** Whether every key names one function, so the keys differ only in arguments. */
function overloadsOnly(keys: readonly string[]): boolean {
  const names = new Set(
    keys.map((key) => {
      const [kind, schema, name] = key.split(":");
      return kind === "function" || kind === "procedure"
        ? `${schema ?? ""}.${name ?? ""}`
        : key;
    }),
  );
  return (
    names.size === 1 &&
    keys.every((key) => /^(?:function|procedure):/u.test(key))
  );
}

async function argTypes(sql: string): Promise<string | undefined> {
  try {
    const [node] = await parseSqlFile(sql);
    const types = node === undefined ? undefined : functionArgTypes(node);
    return types?.join(", ");
  } catch (error) {
    if (error instanceof SqlSyntaxError) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Whether the producers of a function key declare different argument lists.
 * pg-topo 1.0.0-alpha.8 drops array bounds from a signature, so `f(text, uuid)`
 * and `f(text, uuid[])` share a key.
 */
async function distinctOverloads(
  ref: TopoRef,
  producers: readonly TopoNode[],
): Promise<boolean> {
  if (ref.kind !== "function" && ref.kind !== "procedure") {
    return false;
  }
  const signatures: (string | undefined)[] = [];
  for (const node of producers) {
    signatures.push(await argTypes(node.sql));
  }
  return (
    signatures.every((signature) => signature !== undefined) &&
    new Set(signatures).size === signatures.length
  );
}

function configTables(input: DoctorInput): ReadonlySet<string> {
  return new Set(
    Object.entries(input.config.rls?.tables ?? {}).flatMap(
      ([resource, entry]) => {
        const table = tableOf(resource, entry);
        return table === undefined ? [] : [table];
      },
    ),
  );
}

async function duplicates(
  diagnostics: readonly TopoDiagnostic[],
  ordered: readonly TopoNode[],
  files: readonly string[],
  cwd: string,
): Promise<readonly DoctorFinding[]> {
  const refs = new Map<string, TopoRef>();
  for (const diagnostic of diagnostics) {
    const ref = diagnostic.objectRefs?.[0];
    if (
      diagnostic.code === "DUPLICATE_PRODUCER" &&
      diagnostic.details?.["requiredObjectKey"] === undefined &&
      ref !== undefined
    ) {
      refs.set(refKey(ref), ref);
    }
  }
  const findings: DoctorFinding[] = [];
  for (const [key, ref] of refs) {
    const producers = ordered.filter((node) =>
      node.provides.some((provided) => refKey(provided) === key),
    );
    if (await distinctOverloads(ref, producers)) {
      continue;
    }
    const where = [
      ...new Set(
        producers.map((node) => rel(cwd, fileOf(files, node.id.filePath))),
      ),
    ];
    findings.push({
      code: "PD125",
      severity: "warning",
      target: key,
      message: `pg-topo: ${where.join(" and ")} each create ${ref.kind} ${ref.schema === undefined ? "" : `${ref.schema}.`}${ref.name}, which better-supabase reports as BS722`,
      fix: "keep one statement that creates it in the schema directory",
    });
  }
  return findings;
}

function cycles(
  diagnostics: readonly TopoDiagnostic[],
  files: readonly string[],
  cwd: string,
): readonly DoctorFinding[] {
  return diagnostics.flatMap((diagnostic): DoctorFinding[] => {
    if (diagnostic.code !== "CYCLE_DETECTED") {
      return [];
    }
    const keys = diagnostic.details?.["cycleObjectKeys"];
    const objects = Array.isArray(keys)
      ? keys.filter((key): key is string => typeof key === "string")
      : [];
    if (objects.length > 0 && overloadsOnly(objects)) {
      return [];
    }
    const file =
      diagnostic.statementId === undefined
        ? ""
        : `${rel(cwd, fileOf(files, diagnostic.statementId.filePath))}: `;
    return [
      {
        code: "PD125",
        severity: "warning",
        target: objects.join(" "),
        message: `pg-topo: ${file}${diagnostic.message} (${objects.join(", ")})`,
        fix: "split the statements, or add a -- pg-topo:requires line to the one that depends on the other",
      },
    ];
  });
}

function unresolvedTables(
  diagnostics: readonly TopoDiagnostic[],
  input: DoctorInput,
  files: readonly string[],
): readonly DoctorFinding[] {
  const tables = configTables(input);
  const seen = new Set<string>();
  return diagnostics.flatMap((diagnostic): DoctorFinding[] => {
    const ref = diagnostic.objectRefs?.[0];
    if (
      diagnostic.code !== "UNRESOLVED_DEPENDENCY" ||
      ref?.kind !== "table" ||
      diagnostic.statementId === undefined
    ) {
      return [];
    }
    const table = `${ref.schema ?? "public"}.${ref.name}`;
    const file = rel(input.cwd, fileOf(files, diagnostic.statementId.filePath));
    if (!tables.has(table) || seen.has(`${file}:${table}`)) {
      return [];
    }
    seen.add(`${file}:${table}`);
    return [
      {
        code: "PD125",
        severity: "warning",
        target: `${file}:${table}`,
        message: `pg-topo: ${file} reads ${table}, which rls.tables names, and no file in the schema directory creates it`,
        fix: `add create table ${table} to the schema directory, or fix the table name in rls.tables`,
      },
    ];
  });
}

/**
 * PD125: pg-topo's dependency analysis of the declarative schema directory. It
 * reports cycles, an object two statements create, and a table `rls.tables`
 * names that no schema file creates. Overloads of one function are left out:
 * pg-topo 1.0.0-alpha.8 cannot tell them apart. Under better-supabase's doctor,
 * BS722 and BS723 report cycles and duplicates.
 */
export async function pd125(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
  const schemas = resolveSchemas(input.cwd, input.config);
  if (schemas.mode !== "pg-delta") {
    return [];
  }
  const files = sqlFiles(input.cwd, [schemas.schemaDir]);
  if (files.length === 0) {
    return [];
  }
  const topo = await loadPgTopo(input.cwd);
  if (topo === undefined) {
    return [
      {
        code: "PD125",
        severity: "info",
        message: `${PG_TOPO} is not installed, so doctor does not check the dependency order of ${schemas.schemaDir}`,
        fix: `install ${PG_TOPO} as a dev dependency; better-supabase installs it`,
      },
    ];
  }
  const read = filesOf(input);
  const result = await topo.analyzeAndSort(
    files.map((file) => read.read(file)),
  );
  const unresolved = unresolvedTables(result.diagnostics, input, files);
  if (await underBetterSupabaseDoctor(input)) {
    return unresolved;
  }
  return [
    ...cycles(result.diagnostics, files, input.cwd),
    ...(await duplicates(result.diagnostics, result.ordered, files, input.cwd)),
    ...unresolved,
  ];
}
