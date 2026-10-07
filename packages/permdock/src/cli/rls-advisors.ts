import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";

/** Runs a program to completion; `error` is set when it could not start. */
export type CliExec = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  },
) => {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
};

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

const defaultExec: CliExec = (command, args, options) => {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error === undefined ? {} : { error: result.error }),
  };
};

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

const INSTALL =
  "rls verify --advisors runs the Supabase CLI: install it with npm install --save-dev supabase (or brew install supabase/tap/supabase)";

/**
 * `supabase db advisors --type security` against `--db` or the local stack.
 * Exit 1 on a WARN or ERROR row, 2 when the CLI is missing or fails.
 */
export function runRlsAdvisors(input: {
  readonly cwd: string;
  readonly db?: string;
  readonly json: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly exec?: CliExec;
}): { readonly code: 0 | 1 | 2; readonly output: string } {
  const exec = input.exec ?? defaultExec;
  const bin = join(input.cwd, "node_modules", ".bin");
  const path = input.env["PATH"];
  const result = exec(
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
    },
  );
  if (result.error !== undefined) {
    return { code: 2, output: INSTALL };
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
