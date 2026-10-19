import type { Agent } from "package-manager-detector";

import { spawn } from "node:child_process";
import { delimiter, join } from "node:path";

import type { CommandResult } from "../shared/result.ts";

import { addLine, packageManagerOf } from "../peer.ts";

type ExecResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
};

/** Runs a program to completion; `error` is set when it could not start. */
export type CliExec = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly signal?: AbortSignal;
  },
) => ExecResult | Promise<ExecResult>;

/** The PermDock doctor check that reports the same problem in migrations. */
const ADVISOR_CODES: Readonly<Record<string, `PD${string}`>> = {
  function_search_path_mutable: "PD048",
  auth_rls_initplan: "PD051",
  rls_disabled_in_public: "PD050",
  security_definer_view: "PD022",
  anon_security_definer_function_executable: "PD049",
  authenticated_security_definer_function_executable: "PD046",
};

export type AdvisorFinding = {
  readonly name: string;
  readonly level: string;
  readonly detail: string;
  readonly remediation: string;
  readonly cacheKey: string;
  readonly code?: `PD${string}`;
};

const defaultExec: CliExec = (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      resolve({ status: null, stdout, stderr, error });
    });
    child.once("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });

function text(value: unknown, key: string): string {
  const field =
    typeof value === "object" && value !== null
      ? Reflect.get(value, key)
      : undefined;
  return typeof field === "string" ? field : "";
}

function findingsOf(value: unknown): readonly AdvisorFinding[] | undefined {
  const results =
    typeof value === "object" && value !== null
      ? Reflect.get(value, "results")
      : undefined;
  if (!Array.isArray(results)) {
    return undefined;
  }
  return results.map((row: unknown): AdvisorFinding => {
    const name = text(row, "name");
    const finding = {
      name,
      level: text(row, "level"),
      detail: text(row, "detail"),
      remediation: text(row, "remediation"),
      cacheKey: text(row, "cacheKey"),
    };
    const code = ADVISOR_CODES[name];
    return code === undefined ? finding : Object.assign(finding, { code });
  });
}

function installHint(agent: Agent | undefined): string {
  return `rls verify --advisors runs the Supabase CLI: install it with ${addLine(agent, ["supabase"], { dev: true })} (or brew install supabase/tap/supabase)`;
}

/**
 * `supabase db advisors --type security` against `--db` or the local stack,
 * from the project's `node_modules/.bin` first, then `PATH`. Exit 1 on a WARN
 * or ERROR row, 2 when the CLI is missing or fails.
 */
export async function runRlsAdvisors(input: {
  readonly cwd: string;
  readonly db?: string;
  readonly json: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly exec?: CliExec;
  readonly signal?: AbortSignal;
}): Promise<CommandResult> {
  const exec = input.exec ?? defaultExec;
  const bin = join(input.cwd, "node_modules", ".bin");
  const path = input.env["PATH"];
  const result = await exec(
    "supabase",
    [
      "db",
      "advisors",
      ...(input.db === undefined ? ["--local"] : ["--db-url", input.db]),
      "--type",
      "security",
      "--output-format",
      "json",
    ],
    {
      cwd: input.cwd,
      env: {
        ...input.env,
        PATH: path === undefined ? bin : `${bin}${delimiter}${path}`,
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
  );
  if (result.error !== undefined) {
    return { code: 2, output: installHint(await packageManagerOf(input.cwd)) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = undefined;
  }
  const findings = findingsOf(parsed);
  if (findings === undefined) {
    const error =
      typeof parsed === "object" && parsed !== null
        ? Reflect.get(parsed, "error")
        : undefined;
    const message = [text(error, "message"), text(error, "suggestion")]
      .filter((part) => part !== "")
      .join(" ");
    return {
      code: 2,
      output: `supabase db advisors failed: ${message === "" ? result.stderr.trim() || `exit ${String(result.status)}` : message}`,
    };
  }
  const failing = findings.filter(
    (finding) => finding.level === "WARN" || finding.level === "ERROR",
  );
  const code = failing.length > 0 ? 1 : 0;
  if (input.json) {
    return {
      code,
      output: JSON.stringify(
        {
          findings,
          errors: findings.filter((finding) => finding.level === "ERROR")
            .length,
          warnings: findings.filter((finding) => finding.level === "WARN")
            .length,
        },
        null,
        2,
      ),
    };
  }
  if (findings.length === 0) {
    return { code, output: "supabase db advisors: no security findings" };
  }
  const lines = findings.map(
    (finding) =>
      `${finding.level} ${finding.name}${finding.code === undefined ? "" : ` (${finding.code})`}: ${finding.detail}\n  ${finding.remediation}`,
  );
  return {
    code,
    output: `${lines.join("\n")}\n\n${String(failing.length)} finding(s) at WARN or above`,
  };
}
