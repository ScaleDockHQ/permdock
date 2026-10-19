import type { CliProblem } from "./errors.ts";
import type { Finding, NextStep } from "./result.ts";

import { DOCS_BASE } from "./manifest.ts";
import { cliVersion } from "./version.ts";

export const CLI_RESULT_SCHEMA =
  "https://permdock.com/schemas/cli-result-v1.json" as const;

export type ResultStatus = "success" | "error" | "action_required";

/** What `--json` prints on stdout for every run, success or not. */
export type Envelope = {
  readonly $schema: typeof CLI_RESULT_SCHEMA;
  readonly status: ResultStatus;
  readonly data?: unknown;
  readonly error?: CliProblem;
  readonly next?: readonly NextStep[];
};

export function envelope(input: {
  readonly status: ResultStatus;
  readonly data?: unknown;
  readonly error?: CliProblem;
  readonly next?: readonly NextStep[];
}): Envelope {
  return {
    $schema: CLI_RESULT_SCHEMA,
    status: input.status,
    ...(input.data === undefined ? {} : { data: input.data }),
    ...(input.error === undefined ? {} : { error: input.error }),
    ...(input.next === undefined || input.next.length === 0
      ? {}
      : { next: input.next }),
  };
}

/** A command's JSON report as data; text that is not JSON becomes `{ message }`. */
export function dataOf(output: string): unknown {
  const text = output.trim();
  if (text === "") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return { message: text };
  }
}

function escapeData(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function escapeProperty(value: string): string {
  return escapeData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

/** GitHub Actions workflow commands, one per finding. */
export function githubAnnotations(findings: readonly Finding[]): string {
  return findings
    .map((finding) => {
      const level =
        finding.severity === "error"
          ? "error"
          : finding.severity === "warning"
            ? "warning"
            : "notice";
      const properties = [
        ...(finding.file === undefined
          ? []
          : [`file=${escapeProperty(finding.file)}`]),
        ...(finding.line === undefined ? [] : [`line=${String(finding.line)}`]),
        `title=${escapeProperty(finding.code)}`,
      ].join(",");
      const message =
        finding.fix === undefined
          ? finding.message
          : `${finding.message}\nFix: ${finding.fix}`;
      return `::${level} ${properties}::${escapeData(message)}`;
    })
    .join("\n");
}

/** A SARIF 2.1.0 log with one run, one rule per finding code. */
export function sarifLog(
  command: string,
  findings: readonly Finding[],
): string {
  const codes = [...new Set(findings.map((finding) => finding.code))];
  const rules = codes.map((code) => {
    const sample = findings.find((finding) => finding.code === code);
    const rule: { id: string; helpUri?: string; help?: { text: string } } = {
      id: code,
    };
    if (sample?.docs !== undefined) {
      rule.helpUri = sample.docs;
    }
    if (sample?.fix !== undefined) {
      rule.help = { text: sample.fix };
    }
    return rule;
  });
  const results = findings.map((finding) => ({
    ruleId: finding.code,
    level:
      finding.severity === "error"
        ? "error"
        : finding.severity === "warning"
          ? "warning"
          : "note",
    message: { text: finding.message },
    ...(finding.file === undefined
      ? {}
      : {
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: finding.file },
                ...(finding.line === undefined
                  ? {}
                  : { region: { startLine: finding.line } }),
              },
            },
          ],
        }),
  }));
  return `${JSON.stringify(
    {
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: `permdock ${command}`,
              version: cliVersion(),
              informationUri: DOCS_BASE,
              rules,
            },
          },
          results,
        },
      ],
    },
    null,
    2,
  )}\n`;
}
