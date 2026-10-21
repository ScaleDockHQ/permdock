import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { JsonSchemaNode } from "../core/json-schema.ts";

import { isRecord } from "../core/compact.ts";
import { freezeDeep } from "../core/freeze.ts";
import {
  checkSchema,
  copyJson,
  forbiddenKeyPath,
} from "../core/json-schema.ts";
import { CONNECTOR_SCHEMA } from "./connector-schema.ts";

type Https = `https://${string}`;

type ConnectorBase<K extends string, C> = {
  readonly id?: string;
  readonly kind: K;
  readonly name: string;
  readonly config: C;
};

export type SiemDestination =
  | "splunk-hec"
  | "sentinel"
  | "security-lake"
  | "google-secops"
  | "elastic"
  | "datadog";

/**
 * A connector body in wire format v1 (`schemas/connector-v1.json`), one member
 * per kind.
 */
export type Connector =
  | ConnectorBase<
      "webhook",
      { readonly url: Https; readonly types?: readonly string[] }
    >
  | ConnectorBase<
      "otlp",
      {
        readonly endpoint: Https;
        readonly headers?: Readonly<Record<string, string>>;
        readonly signals?: readonly ("logs" | "traces")[];
      }
    >
  | ConnectorBase<
      "siem",
      {
        readonly destination: SiemDestination;
        readonly endpoint: Https;
        readonly headers?: Readonly<Record<string, string>>;
      }
    >
  | ConnectorBase<
      "evidence",
      {
        readonly format: "jws" | "ocsf" | "csv";
        readonly destination: Https;
        readonly schedule?: "hourly" | "daily";
      }
    >
  | ConnectorBase<
      "scim",
      {
        readonly tenant: string;
        readonly target: Https;
        readonly groupRoles?: Readonly<Record<string, string>>;
      }
    >
  | ConnectorBase<
      "caep-transmitter",
      {
        readonly issuer: Https;
        readonly jwks_uri?: Https;
        readonly delivery: "push" | "poll";
        readonly poll_endpoint?: Https;
      }
    >
  | ConnectorBase<
      "federated-upstream",
      {
        readonly discovery: Https;
        readonly client_id: string;
        readonly scopes?: readonly string[];
      }
    >
  | ConnectorBase<
      "chat",
      { readonly platform: "slack" | "teams"; readonly workspace: string }
    >
  | ConnectorBase<"email", { readonly from: string }>
  | ConnectorBase<
      "vercel-oidc",
      {
        readonly team_id: string;
        readonly project_id?: string;
        readonly environment?: "production" | "preview" | "development";
      }
    >;

export type ConnectorKind = Connector["kind"];

/**
 * One problem with a connector body; `path` is an RFC 6901 JSON pointer into
 * it.
 */
export type ConnectorIssue = {
  readonly path: string;
  readonly message: string;
};

export type ParseConnectorResult =
  | { readonly ok: true; readonly connector: Connector }
  | { readonly ok: false; readonly issues: readonly ConnectorIssue[] };

const BRANCHES: ReadonlyMap<unknown, JsonSchemaNode> = new Map(
  (CONNECTOR_SCHEMA.oneOf ?? []).map((branch) => [
    branch.properties?.["kind"]?.const,
    branch,
  ]),
);

/** The kinds `connector-v1` lists, in schema order. */
export const CONNECTOR_KINDS: readonly ConnectorKind[] = Object.freeze(
  // SAFETY: every `oneOf` branch of CONNECTOR_SCHEMA pins `kind` to one ConnectorKind.
  [...BRANCHES.keys()] as ConnectorKind[],
);

function pointer(path: readonly PropertyKey[]): string {
  return path
    .map(
      (part) => `/${String(part).replaceAll("~", "~0").replaceAll("/", "~1")}`,
    )
    .join("");
}

function fail(issues: readonly StandardSchemaV1.Issue[]): ParseConnectorResult {
  return {
    ok: false,
    issues: issues.map((item) => ({
      path: pointer(
        (item.path ?? []).map((part) =>
          typeof part === "object" ? part.key : part,
        ),
      ),
      message: item.message,
    })),
  };
}

/**
 * Checks `input` against `connector-v1.json` and answers a frozen copy, or
 * every issue with a JSON pointer. The branch is chosen by `kind`, so an issue
 * names the field rather than "no branch matched".
 */
export function parseConnector(input: unknown): ParseConnectorResult {
  const issues: StandardSchemaV1.Issue[] = [];
  const value = copyJson(input, [], issues, new Set());
  if (issues.length > 0) {
    return fail(issues);
  }
  const forbidden = forbiddenKeyPath(value);
  if (forbidden !== undefined) {
    return fail([{ path: forbidden, message: "Forbidden key" }]);
  }
  if (!isRecord(value)) {
    return fail([{ path: [], message: "Expected object" }]);
  }
  const branch = BRANCHES.get(value["kind"]);
  if (branch === undefined) {
    return fail([
      {
        path: ["kind"],
        message: `Expected one of ${CONNECTOR_KINDS.map((kind) => JSON.stringify(kind)).join(", ")}`,
      },
    ]);
  }
  checkSchema(branch, value, [], issues, CONNECTOR_SCHEMA);
  if (issues.length > 0) {
    return fail(issues);
  }
  // SAFETY: `value` is a JSON copy that passed the connector-v1 branch for its kind.
  return { ok: true, connector: freezeDeep(value as Connector) };
}
