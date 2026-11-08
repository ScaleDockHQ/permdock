import { resolve } from "node:path";

import type { Project } from "../project/project.ts";
import type { DoctorFinding } from "../shared/doctor-types.ts";

import { isRecord } from "../../core/compact.ts";

const MCP_SURFACE = /permdock\/mcp|registerTool\s*\(|\.tool\s*\(/u;
const OPTIONAL_LIMIT = /\blimit\s*:[^\n]*\boptional\b/iu;

type Parameter = Readonly<Record<string, unknown>>;

function resolveParameter(
  document: Record<string, unknown>,
  value: unknown,
): Parameter | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const ref = value["$ref"];
  if (typeof ref !== "string") {
    return value;
  }
  let node: unknown = document;
  for (const part of ref.replace(/^#\//u, "").split("/")) {
    node = isRecord(node) ? node[part] : undefined;
  }
  return isRecord(node) ? node : undefined;
}

function openApiFindings(
  doc: string,
  document: unknown,
): readonly DoctorFinding[] {
  if (!isRecord(document) || !isRecord(document["paths"])) {
    return [];
  }
  const findings: DoctorFinding[] = [];
  for (const [path, item] of Object.entries(document["paths"])) {
    const last = path.split("/").findLast((part) => part !== "") ?? "";
    const get = isRecord(item) ? item["get"] : undefined;
    if (last.startsWith("{") || !isRecord(get)) {
      continue;
    }
    const parameters = Array.isArray(get["parameters"])
      ? get["parameters"]
      : [];
    const limit = parameters
      .map((parameter: unknown) => resolveParameter(document, parameter))
      .find((parameter) => parameter?.["name"] === "limit");
    if (limit === undefined || limit["required"] === true) {
      continue;
    }
    findings.push({
      code: "PD111",
      severity: "warning",
      target: `${doc}:GET ${path}`,
      message: `${doc}: GET ${path} lists rows and its limit is optional, so a request without one reads the whole tenant`,
      fix: "mark limit required, or give it a default and a maximum, in the schema the document is generated from",
    });
  }
  return findings;
}

/**
 * PD111: a list endpoint takes an optional `limit`. In an `openapi.doc`
 * document it is a `GET` on a collection path whose `limit` parameter is not
 * required; in a source file that builds an MCP server it is a tool schema with
 * `limit: …optional()`. A caller that omits the limit reads every row the
 * policies allow.
 */
export function pd111(
  project: Pick<Project, "cwd" | "config" | "files" | "sources">,
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const doc of project.config.openapi?.doc ?? []) {
    const abs = resolve(project.cwd, doc);
    if (!project.files.exists(abs)) {
      continue;
    }
    try {
      findings.push(
        ...openApiFindings(doc, JSON.parse(project.files.read(abs))),
      );
    } catch {
      // PD091 reports a document that is not JSON.
    }
  }
  for (const source of project.sources()) {
    if (!MCP_SURFACE.test(source.text)) {
      continue;
    }
    const lines = source.text.split("\n");
    for (const [index, text] of lines.entries()) {
      if (OPTIONAL_LIMIT.test(text) && !/\bdefault\b/iu.test(text)) {
        findings.push({
          code: "PD111",
          severity: "warning",
          target: `${source.file}:${String(index + 1)}`,
          message: `${source.file}:${String(index + 1)} declares an optional limit on a tool that lists rows, so a call without one reads the whole tenant`,
          fix: "make limit required, or give it a default and a maximum",
        });
      }
    }
  }
  return findings;
}
