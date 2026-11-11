import type { CliFailure } from "./errors.ts";
import type { Finding, NextStep } from "./result.ts";

import { splitCommandLine } from "./consent.ts";
import { CLI_ERRORS_URL, isActionRequired, isRetryable } from "./errors.ts";
import { DOCS_BASE } from "./manifest.ts";
import { cliVersion } from "./version.ts";

export const CLI_RESULT_SCHEMA =
  "https://permdock.com/schemas/cli-result-v2.json" as const;

/** A next step as `--json` prints it, with `command` split into `argv`. */
export type NextStepDocument = NextStep & { readonly argv: readonly string[] };

/**
 * What `--json` prints on stdout for a run that succeeds (`success`) or reports
 * findings and exits 1 (`error`, the report in `data`).
 */
export type ResultDocument = {
  readonly $schema: typeof CLI_RESULT_SCHEMA;
  readonly status: "success" | "error";
  readonly data?: unknown;
  readonly warnings?: readonly string[];
  readonly next?: readonly NextStepDocument[];
};

/** What `--json` prints as one line on stderr for a run that failed. */
export type ErrorDocument = {
  readonly $schema: typeof CLI_RESULT_SCHEMA;
  readonly status: "error" | "action_required";
  readonly reason: CliFailure["code"];
  readonly message: string;
  readonly type: string;
  readonly next: readonly NextStepDocument[];
  readonly data: Readonly<Record<string, unknown>>;
  readonly userActionRequired: boolean;
  readonly retryable: boolean;
};

function withArgv(step: NextStep): NextStepDocument {
  return {
    command: step.command,
    argv: splitCommandLine(step.command),
    when: step.when,
  };
}

export function resultDocument(input: {
  readonly status: "success" | "error";
  readonly data?: unknown;
  readonly warnings?: readonly string[];
  readonly next?: readonly NextStep[];
}): ResultDocument {
  return {
    $schema: CLI_RESULT_SCHEMA,
    status: input.status,
    ...(input.data === undefined ? {} : { data: input.data }),
    ...(input.warnings === undefined || input.warnings.length === 0
      ? {}
      : { warnings: input.warnings }),
    ...(input.next === undefined || input.next.length === 0
      ? {}
      : { next: input.next.map(withArgv) }),
  };
}

export function errorDocument(
  failure: CliFailure,
  next: readonly NextStep[] = [],
): ErrorDocument {
  const action = isActionRequired(failure.code);
  return {
    $schema: CLI_RESULT_SCHEMA,
    status: action ? "action_required" : "error",
    reason: failure.code,
    message: failure.message,
    type: `${CLI_ERRORS_URL}#${failure.code}`,
    next: next.map(withArgv),
    data: failure.data,
    userActionRequired: action,
    retryable: isRetryable(failure.code),
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

const LOCATION = /^([^\s:]+\.[A-Za-z0-9]+):(\d+)\b/u;

/**
 * A finding whose `file` and `line` default to the `path:line` a message opens
 * with, the form doctor, usage and scan already print.
 */
export function findingOf(input: Finding): Finding {
  if (input.file !== undefined) {
    return input;
  }
  const match = LOCATION.exec(input.message);
  if (match?.[1] === undefined || match[2] === undefined) {
    return input;
  }
  return { ...input, file: match[1], line: Number(match[2]) };
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
      const text =
        finding.id === undefined
          ? finding.message
          : `${finding.message} [${finding.id}]`;
      const message =
        finding.fix === undefined ? text : `${text}\nFix: ${finding.fix}`;
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
    ...(finding.id === undefined
      ? {}
      : { partialFingerprints: { "permdockId/v1": finding.id } }),
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

/** `text`, or `fallback` when `text` is empty. */
export function nonEmptyOr<T>(text: string, fallback: T): string | T {
  return text === "" ? fallback : text;
}
