import type { SaasProject } from "../saas/permissions.ts";

import {
  type ApprovalStore,
  memoryApprovalStore,
} from "../../approvals/index.ts";
import {
  type CustomRoleSource,
  type Limits,
  limits,
  getPermDock,
  memoryCustomRoleSource,
  memoryLimitStore,
  memoryRevocationFeed,
  type Principal,
  type RevocationFeed,
  type Subject,
} from "../../index.ts";
import { saasPolicy } from "../saas/policy.ts";
import {
  saasCustomRoles,
  saasOrg,
  saasPrincipal,
  saasSeed,
} from "../saas/seed.ts";
import { verifySaasSession } from "../saas/tokens.ts";

/**
 * What a mount wires into its framework. Every value is server-side: the
 * subject comes from a verified bearer token, memberships and plans from the
 * seed, the tenant from the `:org` path segment.
 */
export type HttpScenarioDomain = {
  readonly policy: typeof saasPolicy;
  /**
   * The verified principal for an `Authorization` header, with the plans of the
   * org in the first segment of `path`. The path, not a route param, so the
   * answer is the same in a global middleware that runs before routing.
   */
  readonly subject: (
    authorization: string | null | undefined,
    path: string,
  ) => Promise<Principal | null>;
  /** `subject` as a full `Subject` whose `expiresAt` is the token's `exp`. */
  readonly session: (
    authorization: string | null | undefined,
    path: string,
  ) => Promise<Subject | null>;
  /** The feed stream mounts pass as `revocations`. */
  readonly revocations: RevocationFeed;
  /**
   * The seed projects of an org, one every 20 ms, round and round until
   * `signal` aborts: the source of the events stream.
   */
  readonly ticks: (
    org: string | undefined,
    signal: AbortSignal,
  ) => AsyncIterable<SaasProject>;
  /** The `:org` segment of a path; mounts may read their route param instead. */
  readonly org: (path: string) => string | undefined;
  readonly customRoles: CustomRoleSource;
  readonly store: ApprovalStore;
  readonly limits: Limits;
  /** A project row by id, whatever its org: tenant checks belong to the policy. */
  readonly project: (id: string | undefined) => SaasProject | null;
};

export type HttpOp =
  | { readonly op: "project.get"; readonly org: string; readonly id: string }
  | { readonly op: "project.update"; readonly org: string; readonly id: string }
  | {
      readonly op: "project.create";
      readonly org: string;
      readonly body: unknown;
    }
  | { readonly op: "project.delete"; readonly org: string; readonly id: string }
  | {
      readonly op: "project.upload";
      readonly org: string;
      readonly id: string;
      readonly file: { readonly name: string; readonly content: string };
    }
  | { readonly op: "analytics.read"; readonly org: string }
  | { readonly op: "apiKey.create"; readonly org: string }
  | { readonly op: "apiKey.revokeAll"; readonly org: string }
  | { readonly op: "admin.members"; readonly org: string }
  | {
      readonly op: "evaluations";
      readonly org: string;
      readonly body: unknown;
    };

export type HttpCall = HttpOp & {
  /** `Bearer <token>` or `null` for an anonymous call. */
  readonly authorization: string | null;
  /** Sent as the `PermDock-Approval` header. */
  readonly approval?: string;
};

export type HttpResult = { readonly status: number; readonly body: unknown };

export type HttpMounted = {
  /**
   * A fetch-shaped entry for REST adapters. It must serve:
   *
   * - `GET /:org/projects/:id`: `protect(project.read, row)`, 200 with the row
   * - `PATCH /:org/projects/:id`: `protect(project.update, row)`, 200
   * - `POST /:org/projects`: `protect(project.create, body, { trusted: false })`,
   *   201 with the body
   * - `DELETE /:org/projects/:id`: `protect(project.read, row)`, then the handler
   *   calls `permdock.assert(project.delete, row)`; 204
   * - `POST /:org/projects/:id/files`: `protect(project.update, row)`, then the
   *   framework's own multipart parser reads field `file`; 201 `{ name, size
   *   }`
   * - `GET /:org/analytics`: `protect(analytics.read)`, 200
   * - `POST /:org/api-keys`: `protect(apiKey.create)`, 201
   * - `POST /:org/api-keys/revoke-all`: `protect(apiKey.revokeAll)`, 204
   * - `GET /:org/admin/members`: in a sub-app, router or group;
   *   `protect(member.list)`, 200
   * - `POST /:org/permdock/access/v1/evaluations`: the adapter's decision
   *   endpoint
   *
   * A global `permdock()` middleware runs before every route.
   *
   * With `streams: true` it also serves `GET /:org/projects/:id/events`:
   * `protect(project.read, row)` with the subject from `domain.session`, then a
   * connection opened for `project.read` on the row with `revocations:
   * domain.revocations`, streaming `domain.ticks(org)` as `text/event-stream`
   * `data:` frames of JSON rows, dropping rows the subscriber cannot
   * `project.update`, and ending with an `event: permdock` frame carrying the
   * Problem Details when the connection aborts.
   */
  readonly fetch?: (request: Request) => Promise<Response>;
  /** RPC adapters map a call to a procedure and its error to an HTTP status. */
  readonly call?: (call: HttpCall) => Promise<HttpResult>;
  readonly close?: () => Promise<void> | void;
};

export type HttpScenarioName =
  | "tenant"
  | "roles"
  | "custom-roles"
  | "plans"
  | "expired"
  | "limits"
  | "validation"
  | "assert"
  | "approval"
  | "stale-approval"
  | "evaluations"
  | "upload"
  | "sub-app"
  | "parallel"
  | "stream-revoked"
  | "stream-demoted"
  | "stream-filter"
  | "stream-expired";

export type HttpAdapterOptions = {
  readonly name: string;
  readonly mount: (
    domain: HttpScenarioDomain,
  ) => HttpMounted | Promise<HttpMounted>;
  /**
   * Scenarios the transport cannot express (multipart over RPC), each with a
   * reason.
   */
  readonly skip?: Readonly<Partial<Record<HttpScenarioName, string>>>;
  /** The mount serves the events stream; the `stream-*` scenarios run only then. */
  readonly streams?: boolean;
};

export function project(id: string): SaasProject {
  const row = saasSeed.projects.find((candidate) => candidate.id === id);
  if (row === undefined) {
    throw new Error(`no seed project ${id}`);
  }
  return row;
}

function bearerToken(authorization: string | null | undefined): string | null {
  if (typeof authorization !== "string") {
    return null;
  }
  const match = /^Bearer (\S+)$/u.exec(authorization);
  return match?.[1] ?? null;
}

function orgOf(path: string): string | undefined {
  const [segment] = path.replace(/^\/+/u, "").split("/");
  return segment === undefined || segment.length === 0
    ? undefined
    : saasOrg(segment)?.id;
}

async function pause(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

async function* ticks(
  org: string | undefined,
  signal: AbortSignal,
): AsyncGenerator<SaasProject, void, undefined> {
  const rows = saasSeed.projects.filter((row) => row.orgId === org);
  if (rows.length === 0) {
    return;
  }
  while (!signal.aborted) {
    for (const row of rows) {
      await pause(20, signal);
      if (signal.aborted) {
        return;
      }
      yield row;
    }
  }
}

function demotionKey(user: string, org: string): string {
  return JSON.stringify([user, org]);
}

type Demotions = { readonly demote: (user: string, org: string) => () => void };

export function createDomain(): HttpScenarioDomain & Demotions {
  const demoted = new Set<string>();
  const principalOf = (sub: string, path: string): Principal => {
    const principal = saasPrincipal(sub, orgOf(path));
    return {
      ...principal,
      memberships: (principal.memberships ?? []).filter(
        (membership) =>
          membership.tenant === undefined ||
          !demoted.has(demotionKey(sub, membership.tenant)),
      ),
    };
  };
  return {
    policy: saasPolicy,
    async subject(authorization, path) {
      const verified = await verifySaasSession(bearerToken(authorization));
      return verified === null ? null : principalOf(verified.sub, path);
    },
    async session(authorization, path) {
      const verified = await verifySaasSession(bearerToken(authorization));
      return verified === null
        ? null
        : {
            principal: principalOf(verified.sub, path),
            context: {},
            expiresAt: verified.expiresAt,
          };
    },
    revocations: memoryRevocationFeed(),
    ticks,
    demote(user, org) {
      const key = demotionKey(user, org);
      demoted.add(key);
      return () => {
        demoted.delete(key);
      };
    },
    org: orgOf,
    customRoles: memoryCustomRoleSource(saasCustomRoles),
    store: memoryApprovalStore(),
    limits: limits(memoryLimitStore()),
    project: (id) =>
      id === undefined
        ? null
        : (saasSeed.projects.find((row) => row.id === id) ?? null),
  };
}

export async function approverSubject(
  user: string,
  tenant: string,
): Promise<Subject> {
  const permdock = await getPermDock(saasPolicy, saasPrincipal(user, tenant), {
    tenant,
  });
  return permdock.subject;
}
