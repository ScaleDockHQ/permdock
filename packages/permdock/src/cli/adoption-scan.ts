import { readFileSync } from "node:fs";
import { relative } from "node:path";

import type { CommandResult } from "./core/result.ts";

import { DOCS_BASE } from "./core/manifest.ts";
import { listSourceFiles } from "./files.ts";

/** Authorization checks written before PermDock, by the shape they usually take. */
const LEGACY_PATTERNS: readonly {
  readonly name: string;
  readonly pattern: RegExp;
}[] = [
  { name: "role comparison", pattern: /\brole\s*[!=]==?\s*['"`]/u },
  { name: "roles.includes", pattern: /\broles?\.(?:includes|some|has)\(/u },
  { name: "isAdmin flag", pattern: /\bis(?:Admin|Owner|SuperUser|Staff)\b/u },
  {
    name: "hasRole / hasPermission",
    pattern: /\b(?:has|check|require)(?:Role|Permission|Access)s?\(/u,
  },
  { name: "CASL ability", pattern: /\bability\.(?:can|cannot)\(/u },
  { name: "Clerk has()", pattern: /\bhas\(\s*\{\s*(?:role|permission)\s*:/u },
  { name: "JWT role claim", pattern: /\[['"](?:role|roles|user_role)['"]\]/u },
];

export type LegacyFinding = {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
  readonly text: string;
};

export type AdoptionScanOptions = {
  readonly cwd: string;
  readonly srcPath: readonly string[];
  /** Extra regular expressions, matched per line, reported as `custom`. */
  readonly patterns?: readonly string[];
  readonly json?: boolean;
};

/**
 * Lines that look like an authorization check written without PermDock: the
 * work left before a permission can be enforced. It reads source text only and
 * runs nothing; a finding is a place to look, not a verdict.
 */
function scanLegacy(options: AdoptionScanOptions): readonly LegacyFinding[] {
  const custom = (options.patterns ?? []).map((source) => ({
    name: "custom",
    pattern: new RegExp(source, "u"),
  }));
  const patterns = [...LEGACY_PATTERNS, ...custom];
  const findings: LegacyFinding[] = [];
  for (const file of listSourceFiles(options.cwd, options.srcPath)) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      if (/permdock/iu.test(line)) {
        continue;
      }
      const hit = patterns.find((item) => item.pattern.test(line));
      if (hit !== undefined) {
        findings.push({
          file: relative(options.cwd, file),
          line: index + 1,
          kind: hit.name,
          text: line.trim().slice(0, 160),
        });
      }
    }
  }
  return findings;
}

export function runAdoptionScan(options: AdoptionScanOptions): CommandResult {
  let findings: readonly LegacyFinding[];
  try {
    findings = scanLegacy(options);
  } catch (error) {
    return {
      code: 2,
      output: `permdock scan: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
  const located = findings.map((finding) => ({
    code: "legacy-check",
    severity: "info" as const,
    message: `${finding.kind}: ${finding.text}`,
    file: finding.file,
    line: finding.line,
    docs: `${DOCS_BASE}/scan`,
  }));
  if (options.json === true) {
    return {
      code: 0,
      output: `${JSON.stringify(findings, null, 2)}\n`,
      findings: located,
    };
  }
  if (findings.length === 0) {
    return {
      code: 0,
      output: "No legacy authorization checks found.\n",
      findings: [],
    };
  }
  const byKind = new Map<string, number>();
  for (const finding of findings) {
    byKind.set(finding.kind, (byKind.get(finding.kind) ?? 0) + 1);
  }
  const lines = [
    ...findings.map(
      (finding) =>
        `${finding.file}:${finding.line}  ${finding.kind}  ${finding.text}`,
    ),
    "",
    `${findings.length} checks to move to PermDock: ${[...byKind]
      .map(([kind, count]) => `${count} ${kind}`)
      .join(", ")}.`,
    "Run them beside PermDock with shadowMode before enforcing (https://permdock.com/docs/getting-started/existing-apps).",
    ...(byKind.has("CASL ability")
      ? [
          "CASL rules import as roles: permdock casl import --rules <file> --out <file> (https://permdock.com/docs/cli/casl).",
        ]
      : []),
  ];
  return { code: 0, output: `${lines.join("\n")}\n`, findings: located };
}
