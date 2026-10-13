import type { RelationSource, TokenSigner } from "../core/interfaces.ts";
import type { PermDock } from "../core/permdock.ts";
import type { PermissionTree } from "../core/permission-types.ts";
import type { Subject } from "../core/subject.ts";
import type {
  ApprovalRequest,
  ApprovalStore,
  ApprovalVerdict,
} from "./types.ts";
import type { ApprovalDelegationSource } from "./types.ts";

import { compact } from "../core/compact.ts";
import { rootMembershipId } from "../core/scopes.ts";
import { PROBLEM_BASE } from "../core/validation-error.ts";
import { hasCredentials } from "../server/http.ts";
import { unauthenticatedProblem } from "../server/problem.ts";
import { matchDelegation } from "./delegation.ts";
import { ApprovalError, isApprovalError } from "./errors.ts";
import { heldPermissions } from "./permissions.ts";
import { approverRelations } from "./relations.ts";
import { assertApprover } from "./store.ts";

export type ApprovalsHandlerOptions = {
  readonly subject: (
    request: Request,
  ) => Subject | null | undefined | Promise<Subject | null | undefined>;
  /** Refuse the principal even on grants that set `approval: { distinct: false }`. */
  readonly requireDistinctApprover?: boolean;
  readonly signer?: TokenSigner;
  readonly audience?: string | readonly string[];
  /** Where `relation()` approvers are read, by the request's resource id; without it they match nobody. */
  readonly relations?: RelationSource;
  /** The policy's permission tree, for `through` links and `includes` on relation approvers. */
  readonly permissions?: PermissionTree;
  /**
   * The approver's own instance in the request's tenant, for
   * `holder(permission)` approvers (custom roles included when the instance
   * reads a `RoleSource`). Without it, or when it throws, they match nobody.
   */
  readonly permdockFor?: (
    approver: Subject,
    request: ApprovalRequest,
  ) => PermDock | Promise<PermDock>;
  /**
   * Out-of-office delegations. With `subjectFor`, a caller who is not an
   * approver may approve as someone who delegated to them. Without either,
   * delegation matches nobody.
   */
  readonly delegations?: ApprovalDelegationSource;
  /**
   * Resolves a delegator's subject from their principal id. Server-side:
   * never from the request body. A throw matches nobody.
   */
  readonly subjectFor?: (
    principalId: string,
    request: ApprovalRequest,
  ) => Subject | null | undefined | Promise<Subject | null | undefined>;
};

type ProblemBody = {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
};

function problem(
  status: number,
  title: string,
  detail: string,
  slug: string,
): Response {
  const body: ProblemBody = {
    type: `${PROBLEM_BASE}/${slug}`,
    title,
    status,
    detail,
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Route =
  | { readonly kind: "pending" }
  | { readonly kind: "mine" }
  | { readonly kind: "get"; readonly token: string }
  | { readonly kind: "approve"; readonly token: string }
  | { readonly kind: "reject"; readonly token: string };

function parseRoute(url: URL, method: string): Route | undefined {
  const parts = url.pathname.replace(/\/+$/u, "").split("/").filter(Boolean);
  const last = parts.at(-1);
  const prev = parts.at(-2);
  if (last === undefined) {
    return undefined;
  }
  if (method === "GET" && last === "pending") {
    return { kind: "pending" };
  }
  if (method === "GET" && last === "mine") {
    return { kind: "mine" };
  }
  if (method === "POST" && last === "approve" && prev !== undefined) {
    return { kind: "approve", token: decodeURIComponent(prev) };
  }
  if (method === "POST" && last === "reject" && prev !== undefined) {
    return { kind: "reject", token: decodeURIComponent(prev) };
  }
  if (method === "GET" && last !== "pending" && last !== "mine") {
    return { kind: "get", token: decodeURIComponent(last) };
  }
  return undefined;
}

async function resolveSubject(
  request: Request,
  resolve: ApprovalsHandlerOptions["subject"],
): Promise<Subject | null> {
  try {
    const subject = await resolve(request);
    if (subject === null || subject === undefined) {
      return null;
    }
    return subject;
  } catch {
    return null;
  }
}

function membershipTenants(subject: Subject): readonly string[] {
  const principal = subject.principal;
  if (principal === null) {
    return [];
  }
  const tenants = new Set<string>();
  if (principal.tenant !== undefined) {
    tenants.add(principal.tenant);
  }
  for (const membership of principal.memberships ?? []) {
    const tenant = rootMembershipId(membership);
    if (tenant !== undefined) {
      tenants.add(tenant);
    }
  }
  return [...tenants];
}

function belongsToTenant(subject: Subject, tenant: string): boolean {
  return membershipTenants(subject).includes(tenant);
}

type Acting =
  | {
      readonly kind: "self";
      readonly relations: readonly string[];
      readonly permissions: readonly string[];
    }
  | {
      readonly kind: "delegated";
      readonly delegation: string;
      readonly delegator: Subject;
      readonly relations: readonly string[];
      readonly permissions: readonly string[];
    };

async function factsFor(
  request: ApprovalRequest,
  subject: Subject,
  options: ApprovalsHandlerOptions,
): Promise<{
  readonly relations: readonly string[];
  readonly permissions: readonly string[];
}> {
  return {
    relations: await approverRelations(request, subject, options),
    permissions: await heldPermissions(request, subject, options.permdockFor),
  };
}

/** The caller as themselves, or the first delegation that makes them an approver. */
async function actingApprover(
  request: ApprovalRequest,
  subject: Subject,
  requireDistinct: boolean,
  options: ApprovalsHandlerOptions,
): Promise<Acting> {
  const facts = await factsFor(request, subject, options);
  try {
    assertApprover(
      request,
      subject,
      requireDistinct,
      new Date(),
      facts.relations,
      facts.permissions,
    );
    return { kind: "self", ...facts };
  } catch (error) {
    if (!isApprovalError(error) || error.code !== "approver-not-eligible") {
      throw error;
    }
  }
  const match = await matchDelegation(request, subject, {
    ...(options.delegations === undefined
      ? {}
      : { delegations: options.delegations }),
    ...(options.subjectFor === undefined
      ? {}
      : { subjectFor: options.subjectFor }),
    requireDistinct,
    factsFor: (delegator) => factsFor(request, delegator, options),
  });
  if (match === undefined) {
    throw new ApprovalError(
      "approver-not-eligible",
      "approver does not hold an eligible role",
    );
  }
  return {
    kind: "delegated",
    delegation: match.delegation.id,
    delegator: match.delegator,
    relations: match.relations,
    permissions: match.permissions,
  };
}

async function mayResolve(
  request: ApprovalRequest,
  subject: Subject,
  requireDistinct: boolean,
  options: ApprovalsHandlerOptions,
): Promise<boolean> {
  try {
    await actingApprover(request, subject, requireDistinct, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * The requester, a tenant member for a tenant request, and for a request
 * without a tenant only who answered it or may answer it.
 */
function canView(
  request: ApprovalRequest,
  subject: Subject,
  requireDistinct: boolean,
  options: ApprovalsHandlerOptions,
): Promise<boolean> {
  const principal = subject.principal;
  if (principal === null) {
    return Promise.resolve(false);
  }
  if (request.subject.principal?.id === principal.id) {
    return Promise.resolve(true);
  }
  const tenant = request.subject.principal?.tenant;
  if (tenant !== undefined) {
    return Promise.resolve(belongsToTenant(subject, tenant));
  }
  if (
    request.resolvedBy === principal.id ||
    (request.approvals ?? []).some((item) => item.by === principal.id)
  ) {
    return Promise.resolve(true);
  }
  return mayResolve(request, subject, requireDistinct, options);
}

/**
 * The tenants whose pending requests the approver may list: the requested one,
 * else the active one, else every membership tenant. Requests without a tenant
 * are listed only when no tenant was requested or active.
 */
function pageQuery(url: URL): {
  readonly limit?: number;
  readonly cursor?: string;
} {
  const limit = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  return compact({
    limit: limit === null ? undefined : Number(limit),
    cursor: cursor ?? undefined,
  });
}

function inboxScope(
  url: URL,
  subject: Subject,
):
  | {
      readonly ok: true;
      readonly tenants: readonly string[];
      readonly tenantless: boolean;
    }
  | { readonly ok: false } {
  const requested = url.searchParams.get("tenant");
  if (requested !== null && requested !== "") {
    if (!belongsToTenant(subject, requested)) {
      return { ok: false };
    }
    return { ok: true, tenants: [requested], tenantless: false };
  }
  const active = subject.principal?.tenant;
  if (active !== undefined) {
    return { ok: true, tenants: [active], tenantless: false };
  }
  return { ok: true, tenants: membershipTenants(subject), tenantless: true };
}

function signedApproval(
  request: ApprovalRequest,
  signer: TokenSigner | undefined,
  audience: string | readonly string[] | undefined,
): Promise<string | undefined> {
  if (signer === undefined || request.status !== "approved") {
    return Promise.resolve(undefined);
  }
  const payload: Record<string, unknown> = {
    approval: {
      token: request.token,
      permission: request.permission,
      resource: request.resource,
      status: request.status,
    },
  };
  if (request.subject.principal !== null) {
    payload["sub"] = request.subject.principal.id;
  }
  return signer.sign(
    payload,
    compact<Parameters<TokenSigner["sign"]>[1]>({
      typ: "permdock-approval+jwt",
      audience,
      expiresAt: Math.floor(Date.parse(request.expiresAt) / 1000),
    }),
  );
}

type NoteRead = { readonly note?: string; readonly refusal?: Response };

const MAX_BODY_BYTES = 16 * 1024;
const MAX_NOTE_LENGTH = 2000;

function tooLarge(): Response {
  return problem(
    413,
    "Payload too large",
    `request body exceeds ${String(MAX_BODY_BYTES)} bytes`,
    "payload-too-large",
  );
}

/** An unreadable body is no note; an oversized body or note is refused, never truncated. */
async function readNote(request: Request): Promise<NoteRead> {
  const contentType = request.headers.get("content-type") ?? "";
  if (request.method !== "POST" || !contentType.includes("application/json")) {
    return {};
  }
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return { refusal: tooLarge() };
  }
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return { refusal: tooLarge() };
    }
    const body: unknown = JSON.parse(text);
    if (
      body !== null &&
      typeof body === "object" &&
      "note" in body &&
      typeof body.note === "string"
    ) {
      return body.note.length > MAX_NOTE_LENGTH
        ? {
            refusal: problem(
              400,
              "Invalid request",
              `note exceeds ${String(MAX_NOTE_LENGTH)} characters`,
              "validation",
            ),
          }
        : { note: body.note };
    }
  } catch {
    return {};
  }
  return {};
}

function mapError(error: unknown, credentials: boolean): Response {
  if (!isApprovalError(error)) {
    return problem(500, "Internal error", "approval store failed", "internal");
  }
  if (error.code === "approval-not-found") {
    return problem(404, "Not found", error.message, "not-found");
  }
  if (
    error.code === "approval-not-pending" ||
    error.code === "approval-expired" ||
    error.code === "approver-repeated"
  ) {
    return problem(409, "Conflict", error.message, "conflict");
  }
  if (error.code === "approver-unauthenticated") {
    return unauthenticatedProblem(credentials);
  }
  return problem(403, "Permission denied", error.message, "denied");
}

export function approvalsHandler(
  store: ApprovalStore,
  options: ApprovalsHandlerOptions,
): (request: Request) => Promise<Response> {
  const requireDistinct = options.requireDistinctApprover === true;

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const route = parseRoute(url, request.method);
    if (route === undefined) {
      return problem(
        405,
        "Method not allowed",
        "unknown approvals route",
        "method-not-allowed",
      );
    }

    await store.expire();

    const subject = await resolveSubject(request, options.subject);
    const principal = subject?.principal ?? null;
    if (subject === null || principal === null) {
      return unauthenticatedProblem(hasCredentials(request));
    }

    try {
      if (route.kind === "pending") {
        const scoped = inboxScope(url, subject);
        if (!scoped.ok) {
          return problem(
            403,
            "Permission denied",
            "approver does not belong to that tenant",
            "denied",
          );
        }
        const page = await store.list({ ...pageQuery(url), status: "pending" });
        const tenants = new Set(scoped.tenants);
        const eligible = await Promise.all(
          page.items.map(async (item) => {
            const tenant = item.subject.principal?.tenant;
            const inScope =
              tenant === undefined ? scoped.tenantless : tenants.has(tenant);
            return (
              inScope &&
              (await mayResolve(item, subject, requireDistinct, options))
            );
          }),
        );
        return json(
          200,
          compact({
            items: page.items.filter((_, index) => eligible[index] === true),
            next: page.next,
          }),
        );
      }
      if (route.kind === "mine") {
        const page = await store.list({
          ...pageQuery(url),
          principalId: principal.id,
        });
        return json(200, compact({ items: page.items, next: page.next }));
      }
      if (route.kind === "get") {
        const current = await store.get(route.token);
        if (
          current === null ||
          !(await canView(current, subject, requireDistinct, options))
        ) {
          return problem(
            404,
            "Not found",
            "approval was not found",
            "not-found",
          );
        }
        return json(200, current);
      }
      const current = await store.get(route.token);
      if (current === null) {
        return problem(404, "Not found", "approval was not found", "not-found");
      }
      const acting = await actingApprover(
        current,
        subject,
        requireDistinct,
        options,
      );
      const read = await readNote(request);
      if (read.refusal !== undefined) {
        return read.refusal;
      }
      const note = read.note;
      const resolved = await store.resolve(
        route.token,
        compact<ApprovalVerdict>({
          status: route.kind === "approve" ? "approved" : "rejected",
          by: subject,
          note,
          relations: acting.kind === "self" ? acting.relations : undefined,
          permissions: acting.kind === "self" ? acting.permissions : undefined,
          onBehalfOf:
            acting.kind === "delegated"
              ? {
                  subject: acting.delegator,
                  delegation: acting.delegation,
                  relations: acting.relations,
                  permissions: acting.permissions,
                }
              : undefined,
        }),
      );
      const signed = await signedApproval(
        resolved,
        options.signer,
        options.audience,
      );
      return json(
        200,
        compact<ApprovalRequest & { readonly signed?: string }>({
          ...resolved,
          signed,
        }),
      );
    } catch (error) {
      return mapError(error, hasCredentials(request));
    }
  };
}
