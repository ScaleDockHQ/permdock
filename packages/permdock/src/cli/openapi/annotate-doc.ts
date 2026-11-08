import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

import type { PermissionTree } from "../../core/permission-types.ts";
import type {
  AnnotatedRoute,
  OperationsModuleExtras,
} from "../../openapi/annotate-routes.ts";
import type {
  OpenApiOperationRef,
  OperationSkipCause,
} from "../../openapi/operations.ts";
import type { CommandResult, Finding } from "../core/result.ts";
import type { CliIo, PermDockConfig } from "../types.ts";

import { isRecord } from "../../core/compact.ts";
import { byCodePoint } from "../../core/compare.ts";
import { operationsModule } from "../../openapi/annotate-routes.ts";
import {
  HTTP_METHODS,
  operationPermissionsFromOpenApi,
} from "../../openapi/operations.ts";
import { CliError, configError } from "../core/errors.ts";
import { applyFiles, planFiles } from "../core/files.ts";
import { asPermissionTree, loadModule, pickNamed } from "../project/load.ts";

const DOCS = "https://permdock.com/docs/cli/openapi";
const PARAMETER = /^[A-Za-z_][A-Za-z0-9_-]*$/u;

type DocOperation = {
  readonly label: string;
  readonly path: string;
  readonly node: Record<string, unknown>;
};

function skipFinding(
  operation: OpenApiOperationRef,
  cause: OperationSkipCause,
  keys: string,
): Finding | undefined {
  const label = `${operation.method} ${operation.path}`;
  const base = { severity: "error", docs: DOCS } as const;
  switch (cause) {
    case "public":
      return undefined;
    case "no-permission":
      return {
        ...base,
        code: "operation-no-permission",
        message: `${label} names no permission`,
        fix: "Add x-permdock-permissions to the operation, or security: [] when it is public",
      };
    case "several-permissions":
      return {
        ...base,
        code: "operation-several-permissions",
        message: `${label} names several permissions (${keys}); an operation maps to one`,
        fix: "Keep one key, or split the operation",
      };
    case "unknown-permission":
      return {
        ...base,
        code: "operation-unknown-permission",
        message: `${label} names '${keys}', which the permission vocabulary does not declare`,
        fix: "Use a key from the permissions module, or add the permission",
      };
    case "invalid-extension":
      return {
        ...base,
        code: "operation-invalid-extension",
        message: `${label} has a malformed x-permdock-permissions, x-authorization, x-oauth-scopes or enforcement value`,
      };
    default: {
      const never: never = cause;
      return never;
    }
  }
}

function declaredKeys(node: Record<string, unknown>): string {
  const raw = node["x-permdock-permissions"] ?? node["x-authorization"];
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw)
      ? [raw["permission"]]
      : [raw];
  return list.filter((key) => typeof key === "string").join(", ");
}

function operationsOf(document: Record<string, unknown>): DocOperation[] {
  const paths = isRecord(document["paths"]) ? document["paths"] : {};
  const out: DocOperation[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) {
      continue;
    }
    for (const [method, node] of Object.entries(item)) {
      if (HTTP_METHODS.has(method.toUpperCase()) && isRecord(node)) {
        out.push({ label: `${method.toUpperCase()} ${path}`, path, node });
      }
    }
  }
  return out;
}

/** The first tag, else the first static path segment, else `root`. */
function groupOf(operation: DocOperation): string {
  const tags = operation.node["tags"];
  const tag = Array.isArray(tags)
    ? tags.find((item) => typeof item === "string" && item !== "")
    : undefined;
  if (typeof tag === "string") {
    return tag;
  }
  const segment = operation.path
    .split("/")
    .find((part) => part !== "" && !part.startsWith("{"));
  return segment ?? "root";
}

function tenantParameter(path: string, name: string): string | undefined {
  return path.split("/").includes(`{${name}}`) ? name : undefined;
}

async function loadTree(
  cwd: string,
  config: PermDockConfig,
  permissions: string | undefined,
): Promise<PermissionTree> {
  const module = permissions ?? config.permissions;
  if (module === undefined) {
    throw new CliError(
      "action",
      "openapi annotate --doc needs --permissions, or permissions in the config, to validate keys against",
      { code: "input_required", extensions: { missing: ["--permissions"] } },
    );
  }
  return asPermissionTree(
    pickNamed(await loadModule(resolve(cwd, module)), ["permissions"]),
  );
}

function readDocument(cwd: string, doc: string): Record<string, unknown> {
  const path = resolve(cwd, doc);
  if (!existsSync(path)) {
    throw configError(`PermDock CLI: document not found: ${doc}`);
  }
  let value: unknown;
  try {
    // JSON is YAML 1.2, so one parser reads both.
    value = parse(readFileSync(path, "utf8"), { maxAliasCount: 50 });
  } catch {
    value = undefined;
  }
  if (!isRecord(value) || !isRecord(value["paths"])) {
    throw configError(
      "PermDock CLI: --doc must be a JSON or YAML OpenAPI document with paths",
    );
  }
  return value;
}

function idFindings(operations: readonly DocOperation[]): Finding[] {
  const findings: Finding[] = [];
  const seen = new Map<string, string>();
  for (const operation of operations) {
    const id = operation.node["operationId"];
    if (typeof id !== "string" || id === "") {
      findings.push({
        code: "operation-id-missing",
        severity: "warning",
        message: `${operation.label} has no operationId, so a tool or RPC name cannot resolve to it`,
        fix: "Add an operationId",
        docs: DOCS,
      });
      continue;
    }
    const first = seen.get(id);
    if (first === undefined) {
      seen.set(id, operation.label);
    } else {
      findings.push({
        code: "operation-id-duplicate",
        severity: "error",
        message: `${operation.label} repeats operationId '${id}' of ${first}`,
        fix: "Make each operationId unique",
        docs: DOCS,
      });
    }
  }
  return findings;
}

function render(findings: readonly Finding[]): string {
  return findings
    .map(
      (finding) =>
        `${finding.severity}  ${finding.code}  ${finding.message}${finding.fix === undefined ? "" : ` (${finding.fix})`}`,
    )
    .join("\n");
}

/**
 * Writes the operations map of an OpenAPI document: each operation's
 * permission, `operationId`, scopes and enforcement, the operations by group,
 * and the tenant path parameter each one carries. Every key is checked against
 * the permission vocabulary; any error writes nothing.
 */
export async function runAnnotateDocument(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly doc: string;
  readonly permissions: string | undefined;
  readonly tenantPath: string | undefined;
  readonly out: string;
  readonly check: boolean;
  readonly dryRun: boolean;
  readonly io: CliIo;
}): Promise<CommandResult> {
  const tenant = input.tenantPath?.replace(/^\{(.*)\}$/u, "$1");
  if (tenant !== undefined && !PARAMETER.test(tenant)) {
    throw new CliError(
      "usage",
      `PermDock CLI: --tenant-path '${input.tenantPath}' must be a path parameter name such as orgId`,
      { code: "invalid_value" },
    );
  }
  const document = readDocument(input.cwd, input.doc);
  const tree = await loadTree(input.cwd, input.config, input.permissions);
  const operations = operationsOf(document);
  const byLabel = new Map(operations.map((item) => [item.label, item]));
  const findings: Finding[] = idFindings(operations);
  const skipped = new Set<string>();
  const operationMap = operationPermissionsFromOpenApi(document, tree, {
    onSkip(operation, cause) {
      const label = `${operation.method} ${operation.path}`;
      skipped.add(label);
      const node = byLabel.get(label)?.node ?? {};
      const finding = skipFinding(operation, cause, declaredKeys(node));
      if (finding !== undefined) {
        findings.push(finding);
      }
    },
  });
  const routes: AnnotatedRoute[] = [];
  const groups: Record<string, string[]> = {};
  const tenants: Record<string, string> = {};
  for (const entry of operationMap.entries()) {
    const label = `${entry.method} ${entry.path}`;
    routes.push({
      method: entry.method,
      path: entry.path,
      ...(entry.permission === undefined
        ? {}
        : { permission: entry.permission.key }),
      ...(entry.operationId === undefined
        ? {}
        : { operationId: entry.operationId }),
      ...(entry.oauthScopes === undefined
        ? {}
        : { oauthScopes: entry.oauthScopes }),
      ...(entry.enforcement === "handler" ? { check: "handler" } : {}),
    });
    const operation = byLabel.get(label);
    if (operation !== undefined) {
      (groups[groupOf(operation)] ??= []).push(label);
    }
    const param =
      tenant === undefined ? undefined : tenantParameter(entry.path, tenant);
    if (param !== undefined) {
      tenants[label] = param;
    }
    if (tenant !== undefined && param === undefined) {
      findings.push({
        code: "operation-no-tenant",
        severity: "warning",
        message: `${label} has no {${tenant}} path parameter`,
        fix: "Confirm the operation is not tenant-scoped",
        docs: DOCS,
      });
    }
  }
  const extras: OperationsModuleExtras = {
    groups: Object.fromEntries(
      Object.entries(groups)
        .toSorted(([a], [b]) => byCodePoint(a, b))
        .map(([name, labels]) => [name, labels]),
    ),
    tenants,
  };
  const failed = findings.some((finding) => finding.severity === "error");
  const data = {
    out: input.out,
    operations: routes.length,
    groups: extras.groups,
    tenants,
    skipped: [...skipped].toSorted(byCodePoint),
    written: false,
  };
  if (failed) {
    return { code: 1, output: render(findings), data, findings };
  }
  const file = { path: input.out, text: operationsModule(routes, extras) };
  const [plan] = planFiles(input.cwd, [file]);
  const drift = plan?.outcome !== "unchanged";
  if (input.check) {
    return {
      code: drift ? 1 : 0,
      output: drift
        ? `${input.out} is stale; run permdock openapi annotate --doc ${input.doc}`
        : `${input.out} is current`,
      data,
      findings,
    };
  }
  if (!input.dryRun) {
    applyFiles(input.cwd, [file]);
  }
  const summary = `${input.dryRun ? "would write" : "wrote"} ${input.out} (${String(routes.length)} operations, ${String(Object.keys(extras.groups ?? {}).length)} groups)`;
  return {
    code: 0,
    output: [render(findings), summary]
      .filter((part) => part !== "")
      .join("\n"),
    data: { ...data, written: !input.dryRun },
    findings,
  };
}
