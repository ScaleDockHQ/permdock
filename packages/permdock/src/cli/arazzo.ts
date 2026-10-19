import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { CommandResult } from "./core/result.ts";
import type { PermDockConfig } from "./types.ts";

import { type PermissionTree, arazzoFindings } from "../index.ts";
import { missingInput } from "./core/errors.ts";
import { DOCS_BASE } from "./core/manifest.ts";
import { ARAZZO_REPORT_SCHEMA } from "./core/version.ts";
import { readJsonFile } from "./files.ts";
import { asPermissionTree, loadModule, pickNamed } from "./project/load.ts";

export async function runArazzo(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly doc: string | undefined;
  readonly openapi: string | undefined;
  readonly workflow: string | undefined;
  readonly from: string | undefined;
  readonly json: boolean;
}): Promise<CommandResult> {
  const docPath = input.doc;
  const openapiPath = input.openapi;
  if (docPath === undefined || openapiPath === undefined) {
    throw missingInput("arazzo check", [
      ...(docPath === undefined ? ["--doc"] : []),
      ...(openapiPath === undefined ? ["--openapi"] : []),
    ]);
  }
  const arazzoFile = resolve(input.cwd, docPath);
  const openapiFile = resolve(input.cwd, openapiPath);
  if (!existsSync(arazzoFile) || !existsSync(openapiFile)) {
    return { code: 2, output: "arazzo check: document not found" };
  }
  let arazzo: unknown;
  let openapi: unknown;
  try {
    arazzo = readJsonFile(arazzoFile);
    openapi = readJsonFile(openapiFile);
  } catch {
    return { code: 2, output: "arazzo check: unreadable JSON" };
  }
  const from = input.from ?? input.config.permissions;
  let tree: PermissionTree | undefined;
  if (from !== undefined) {
    const abs = resolve(input.cwd, from);
    if (!existsSync(abs)) {
      return {
        code: 2,
        output: `arazzo check: permissions not found: ${from}`,
      };
    }
    const mod = await loadModule(abs);
    tree = asPermissionTree(pickNamed(mod, ["permissions"]));
  }
  const findings = arazzoFindings(
    input.workflow === undefined
      ? { arazzo, openapi }
      : { arazzo, openapi, workflowId: input.workflow },
    tree,
  );
  const located = findings.map((finding) => ({
    code: finding.reason,
    severity: "error" as const,
    message: `${finding.workflowId} ${finding.stepId}: ${finding.detail}`,
    file: docPath,
    docs: `${DOCS_BASE}/arazzo`,
  }));
  if (input.json) {
    return {
      code: findings.length === 0 ? 0 : 1,
      output: JSON.stringify({ $schema: ARAZZO_REPORT_SCHEMA, findings }),
      findings: located,
    };
  }
  if (findings.length === 0) {
    return {
      code: 0,
      output: "arazzo check: all steps documented",
      findings: located,
    };
  }
  const lines = findings.map(
    (finding) =>
      `${finding.workflowId} ${finding.stepId}: ${finding.reason} (${finding.detail})`,
  );
  return { code: 1, output: lines.join("\n"), findings: located };
}
