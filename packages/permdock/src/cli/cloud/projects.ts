import type { ProblemCode } from "../core/errors.ts";
import type { CommandResult } from "../core/result.ts";
import type { CliIo } from "../types.ts";

import { isRecord } from "../../core/compact.ts";
import { CLI_ERRORS_URL } from "../core/errors.ts";
import { authFailure, httpRequest } from "../core/http.ts";
import { POLICY_NOT_PUBLISHED } from "./problem-types.ts";

/**
 * `GET /v1/projects/{id}/policy`: what the project's last `cloud push` sent, as
 * pushed.
 */
export type ProjectPolicy = {
  readonly v: 1;
  readonly project: string;
  readonly version: number;
  readonly fingerprint: string;
  readonly permdockVersion: string;
  readonly catalog: Readonly<Record<string, unknown>>;
  readonly manifest?: Readonly<Record<string, unknown>>;
  readonly policy?: Readonly<Record<string, unknown>>;
};

export type ProjectSummary = { readonly id: string; readonly name?: string };

type Failure = { readonly ok: false; readonly result: CommandResult };

function failure(
  json: boolean,
  command: string,
  code: 1 | 2,
  problem: {
    readonly code: ProblemCode;
    readonly type?: string;
    readonly title: string;
    readonly status?: number;
    readonly detail: string;
  },
): Failure {
  const { type, ...rest } = problem;
  return {
    ok: false,
    result: {
      code,
      output: json
        ? JSON.stringify(
            {
              type: type ?? `${CLI_ERRORS_URL}#${problem.code}`,
              ...rest,
              command,
              exitCode: code,
            },
            null,
            2,
          )
        : `${command}: ${problem.detail}`,
    },
  };
}

async function readProblemType(
  response: Response,
): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    return isRecord(body) && typeof body["type"] === "string"
      ? body["type"]
      : undefined;
  } catch {
    return undefined;
  }
}

async function get(
  input: {
    readonly issuer: string;
    readonly path: string;
    readonly bearer: string;
    readonly io: CliIo;
    readonly json: boolean;
    readonly command: string;
  },
  what: string,
): Promise<{ readonly ok: true; readonly body: unknown } | Failure> {
  const response = await httpRequest(input.io, {
    url: `${input.issuer}${input.path}`,
    service: "PermDock Cloud",
    headers: {
      authorization: `Bearer ${input.bearer}`,
      accept: "application/json",
    },
  });
  if (response.ok) {
    try {
      return { ok: true, body: await response.json() };
    } catch {
      return failure(input.json, input.command, 1, {
        code: "request_failed",
        title: "Unreadable Cloud answer",
        status: response.status,
        detail: `PermDock Cloud answered ${what} with a body that is not JSON`,
      });
    }
  }
  const type = await readProblemType(response);
  if (response.status === 404 && type === POLICY_NOT_PUBLISHED) {
    return failure(input.json, input.command, 1, {
      code: "request_failed",
      type: POLICY_NOT_PUBLISHED,
      title: "Policy not published",
      status: 404,
      detail:
        "the project has no pushed catalog and policy yet; run permdock cloud push first",
    });
  }
  const denied = authFailure(
    response,
    response.status === 401
      ? "PermDock Cloud rejected the credential"
      : `the credential may not read ${what}; a PERMDOCK_CLOUD_TOKEN reads only its own environment`,
    [
      { command: "permdock login", when: "to log in on this machine" },
      { command: "export PERMDOCK_CLOUD_TOKEN=<read-only key>", when: "in CI" },
    ],
  );
  if (denied !== undefined) {
    throw denied;
  }
  const detail =
    response.status === 429
      ? `PermDock Cloud rate-limited the request (HTTP 429); retry after ${response.headers.get("retry-after") ?? "a while"} seconds`
      : `PermDock Cloud answered ${what} with HTTP ${String(response.status)}`;
  return failure(input.json, input.command, 1, {
    code: "request_failed",
    ...(type === undefined ? {} : { type }),
    title: "PermDock Cloud request failed",
    status: response.status,
    detail,
  });
}

function parseProjectPolicy(body: unknown): ProjectPolicy | null {
  if (
    !isRecord(body) ||
    body["v"] !== 1 ||
    typeof body["project"] !== "string" ||
    typeof body["version"] !== "number" ||
    typeof body["fingerprint"] !== "string" ||
    typeof body["permdockVersion"] !== "string" ||
    !isRecord(body["catalog"]) ||
    (body["manifest"] !== undefined && !isRecord(body["manifest"])) ||
    (body["policy"] !== undefined && !isRecord(body["policy"]))
  ) {
    return null;
  }
  return {
    v: 1,
    project: body["project"],
    version: body["version"],
    fingerprint: body["fingerprint"],
    permdockVersion: body["permdockVersion"],
    catalog: body["catalog"],
    ...(isRecord(body["manifest"]) ? { manifest: body["manifest"] } : {}),
    ...(isRecord(body["policy"]) ? { policy: body["policy"] } : {}),
  };
}

export type CloudRequest = {
  readonly issuer: string;
  readonly bearer: string;
  readonly io: CliIo;
  readonly json: boolean;
  readonly command: string;
};

export async function projectPolicy(
  request: CloudRequest,
  project: string,
): Promise<{ readonly ok: true; readonly value: ProjectPolicy } | Failure> {
  const fetched = await get(
    { ...request, path: `/v1/projects/${encodeURIComponent(project)}/policy` },
    `project ${project}`,
  );
  if (!fetched.ok) {
    return fetched;
  }
  const value = parseProjectPolicy(fetched.body);
  return value === null
    ? failure(request.json, request.command, 1, {
        code: "request_failed",
        title: "Unreadable project policy",
        detail: `PermDock Cloud sent a project policy for ${project} that is not v1`,
      })
    : { ok: true, value };
}

async function listProjects(
  request: CloudRequest,
): Promise<
  { readonly ok: true; readonly value: readonly ProjectSummary[] } | Failure
> {
  const fetched = await get(
    { ...request, path: "/v1/projects" },
    "the projects",
  );
  if (!fetched.ok) {
    return fetched;
  }
  const items =
    isRecord(fetched.body) && Array.isArray(fetched.body["items"])
      ? fetched.body["items"]
      : [];
  const projects: ProjectSummary[] = [];
  for (const item of items) {
    if (isRecord(item) && typeof item["id"] === "string") {
      projects.push({
        id: item["id"],
        ...(typeof item["name"] === "string" ? { name: item["name"] } : {}),
      });
    }
  }
  return { ok: true, value: projects };
}

/**
 * `--project`, or with `PERMDOCK_CLOUD_TOKEN` the one project the token is
 * pinned to, read from `GET /v1/projects`.
 */
export async function resolveProject(
  request: CloudRequest,
  flag: string | undefined,
  pinned: boolean,
): Promise<{ readonly ok: true; readonly value: string } | Failure> {
  if (flag !== undefined) {
    return { ok: true, value: flag };
  }
  if (!pinned) {
    return failure(request.json, request.command, 2, {
      code: "usage",
      title: "Missing project",
      detail: "pass --project <id>",
    });
  }
  const listed = await listProjects(request);
  if (!listed.ok) {
    return listed;
  }
  const [only, ...rest] = listed.value;
  return only !== undefined && rest.length === 0
    ? { ok: true, value: only.id }
    : failure(request.json, request.command, 2, {
        code: "usage",
        title: "Missing project",
        detail: `PERMDOCK_CLOUD_TOKEN reads ${String(listed.value.length)} projects; pass --project <id>`,
      });
}
