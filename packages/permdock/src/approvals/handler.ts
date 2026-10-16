import type { RelationSource, TokenSigner } from "../core/interfaces.ts";
import type { PermDock } from "../core/permdock.ts";
import type { PermissionTree } from "../core/permission-types.ts";
import type { Subject } from "../core/subject.ts";
import type { IdempotencyStore, IdempotentResponse } from "./idempotency.ts";
import type {
  ApprovalRequest,
  ApprovalStore,
  ApprovalVerdict,
} from "./types.ts";
import type { ApprovalDelegationSource } from "./types.ts";

import { canonicalJson } from "../core/canonical-json.ts";
import { compact } from "../core/compact.ts";
import { problemType, statusProblem } from "../core/problem-types.ts";
import { rootMembershipId } from "../core/scopes.ts";
import { sha256Digest } from "../core/sha256.ts";
import { nowMillis } from "../core/time.ts";
import { readBodyText } from "../server/body-text.ts";
import { bodyTooLarge } from "../server/body.ts";
import { hasCredentials } from "../server/http.ts";
import {
  methodNotAllowed,
  problemResponse,
  unauthenticatedProblem,
  validationProblem,
} from "../server/problem.ts";
import { matchDelegation } from "./delegation.ts";
import { ApprovalError, isApprovalError } from "./errors.ts";
import { memoryIdempotencyStore } from "./idempotency.ts";
import { listAllApprovals } from "./page.ts";
import { heldPermissions } from "./permissions.ts";
import { approverRelations } from "./relations.ts";
import { signApproval } from "./signature.ts";
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
   * reads a `CustomRoleSource`). Without it, or when it throws, they match nobody.
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
  readonly approvalDelegations?: ApprovalDelegationSource;
  /**
   * Resolves a delegator's subject from their principal id. Server-side:
   * never from the request body. A throw matches nobody.
   */
  readonly subjectFor?: (
    principalId: string,
    request: ApprovalRequest,
  ) => Subject | null | undefined | Promise<Subject | null | undefined>;
  /**
   * Where `Idempotency-Key` responses on approve and reject are kept for 24
   * hours; a `memoryIdempotencyStore()` per handler when absent.
   */
  readonly idempotency?: IdempotencyStore;
};

/** An approval as the approvals API shows it: never the resume `token`. */
export type ApprovalView = Omit<ApprovalRequest, "token">;

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

function problem(status: number, detail: string): Response {
  return problemResponse(statusProblem(status, detail));
}

function json(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-type": "application/json" },
  });
}

function viewOf(request: ApprovalRequest): ApprovalView {
  const { token: _token, ...view } = request;
  return view;
}

/** A strong RFC 9110 entity tag: the `sha-256:` digest of the view's RFC 8785 JSON. */
function entityTag(request: ApprovalRequest): string {
  return `"${sha256Digest(canonicalJson(viewOf(request)))}"`;
}

function entityTags(field: string): readonly string[] {
  return field
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
}

/** RFC 9110 section 13.1.1: strong comparison, so a weak tag never matches. */
function ifMatchFails(request: Request, current: ApprovalRequest): boolean {
  const field = request.headers.get("if-match");
  if (field === null) {
    return false;
  }
  const tags = entityTags(field);
  if (tags.includes("*")) {
    return false;
  }
  return !tags.includes(entityTag(current));
}

/** RFC 9110 section 13.1.2: weak comparison. */
function ifNoneMatchHolds(request: Request, etag: string): boolean {
  const field = request.headers.get("if-none-match");
  if (field === null) {
    return false;
  }
  return entityTags(field).some(
    (tag) => tag === "*" || tag.replace(/^W\//u, "") === etag,
  );
}

type Route =
  | { readonly kind: "pending" }
  | { readonly kind: "mine" }
  | { readonly kind: "get"; readonly id: string }
  | { readonly kind: "signature"; readonly id: string }
  | { readonly kind: "approve"; readonly id: string }
  | { readonly kind: "reject"; readonly id: string };

function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/**
 * The route the path names and the methods it allows. The handler mounts at
 * any prefix, so a path reads from its last segments; a path naming none is
 * `undefined` (`404`).
 */
function parseRoute(
  url: URL,
):
  | { readonly route: (method: string) => Route | undefined; allow: string }
  | undefined {
  const parts = url.pathname.split("/").filter(Boolean);
  const last = parts.at(-1);
  const prev = parts.at(-2);
  if (last === undefined) {
    return undefined;
  }
  if (last === "pending" || last === "mine") {
    const kind = last;
    return {
      allow: "GET",
      route: (method) => (method === "GET" ? { kind } : undefined),
    };
  }
  if (
    (last === "approve" || last === "reject" || last === "signature") &&
    prev !== undefined
  ) {
    const id = decodeSegment(prev);
    if (id === undefined) {
      return undefined;
    }
    const kind = last;
    const method = kind === "signature" ? "GET" : "POST";
    return {
      allow: method,
      route: (requested) => (requested === method ? { kind, id } : undefined),
    };
  }
  const id = decodeSegment(last);
  if (id === undefined) {
    return undefined;
  }
  return {
    allow: "GET",
    route: (method) => (method === "GET" ? { kind: "get", id } : undefined),
  };
}

/** `store.getById`, else the first page run of `list` that carries the id. */
async function findById(
  store: ApprovalStore,
  id: string,
): Promise<ApprovalRequest | null> {
  if (store.getById !== undefined) {
    return store.getById(id);
  }
  const all = await listAllApprovals(store, {});
  return all.find((request) => request.id === id) ?? null;
}

/** RFC 8288 `Link: <…>; rel="next"` for a page with a `next` cursor. */
function nextLink(url: URL, next: string | undefined): Record<string, string> {
  if (next === undefined) {
    return {};
  }
  const target = new URL(url);
  target.searchParams.set("cursor", next);
  return { Link: `<${target.href}>; rel="next"` };
}

/** The signature sub-resource beside an `…/<id>/approve` or `…/<id>/reject` URL. */
function signatureLink(url: URL): Record<string, string> {
  const target = new URL(url);
  target.search = "";
  target.pathname = target.pathname.replace(
    /\/(?:approve|reject)\/*$/u,
    "/signature",
  );
  return {
    Link: `<${target.href}>; rel="alternate"; type="application/jwt"`,
  };
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
      undefined,
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
    ...(options.approvalDelegations === undefined
      ? {}
      : { approvalDelegations: options.approvalDelegations }),
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

/** The requester and who answered: the signed approval carries the resume token, so only they read it. */
function party(request: ApprovalRequest, principalId: string): boolean {
  return (
    request.subject.principal?.id === principalId ||
    request.resolvedBy === principalId ||
    (request.approvals ?? []).some((item) => item.by === principalId)
  );
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

type NoteRead = {
  readonly note?: string;
  /** The body as read, for the `Idempotency-Key` fingerprint. */
  readonly text: string;
  readonly refusal?: Response;
};

const MAX_BODY_BYTES = 16 * 1024;
const MAX_NOTE_LENGTH = 2000;

/** An unreadable body is no note; an oversized body or note is refused, never truncated. */
async function readNote(request: Request): Promise<NoteRead> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return { text: "" };
  }
  const read = await readBodyText(request, MAX_BODY_BYTES);
  if (!read.ok) {
    return read.cause === "too-large"
      ? { text: "", refusal: bodyTooLarge(MAX_BODY_BYTES) }
      : { text: "" };
  }
  const { text } = read;
  try {
    const body: unknown = JSON.parse(text);
    if (
      body !== null &&
      typeof body === "object" &&
      "note" in body &&
      typeof body.note === "string"
    ) {
      return body.note.length > MAX_NOTE_LENGTH
        ? {
            text,
            refusal: validationProblem(
              `note exceeds ${String(MAX_NOTE_LENGTH)} characters`,
            ),
          }
        : { text, note: body.note };
    }
  } catch {
    return { text };
  }
  return { text };
}

function mapError(error: unknown, credentials: boolean): Response {
  if (!isApprovalError(error)) {
    return problem(500, "approval store failed");
  }
  switch (error.code) {
    case "approval-not-found": {
      return problem(404, error.message);
    }
    case "approval-not-pending":
    case "approval-expired":
    case "approver-repeated": {
      return problem(409, error.message);
    }
    case "approver-unauthenticated": {
      return unauthenticatedProblem(credentials);
    }
    case "approver-not-eligible":
    case "approver-is-actor":
    case "approver-is-principal": {
      return problemResponse({
        type: problemType("approver-not-eligible"),
        title: "Approver not eligible",
        status: 403,
        detail: error.message,
        reason: error.code,
      });
    }
    default: {
      const unhandled: never = error.code;
      return problem(500, `unknown approval error ${String(unhandled)}`);
    }
  }
}

/** The `Idempotency-Key` field: an RFC 9651 sf-string, 1 to 256 characters. */
function idempotencyKey(
  request: Request,
): { readonly key?: string } | { readonly refusal: Response } {
  const field = request.headers.get("idempotency-key");
  if (field === null) {
    return {};
  }
  const match = /^"([\u0020-\u007E]*)"$/u.exec(field.trim());
  const key = match?.[1];
  if (
    key === undefined ||
    key === "" ||
    key.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    /["\\]/u.test(key)
  ) {
    return {
      refusal: validationProblem(
        "Idempotency-Key must be a quoted string of 1 to 256 characters",
      ),
    };
  }
  return { key };
}

async function stored(
  response: Response,
  fingerprint: string,
): Promise<IdempotentResponse> {
  return {
    fingerprint,
    status: response.status,
    headers: [...response.headers.entries()],
    body: await response.clone().text(),
  };
}

export function approvalsHandler(
  store: ApprovalStore,
  options: ApprovalsHandlerOptions,
): (request: Request) => Promise<Response> {
  const requireDistinct = options.requireDistinctApprover === true;
  const idempotency = options.idempotency ?? memoryIdempotencyStore();

  const visible = async (
    id: string,
    subject: Subject,
  ): Promise<ApprovalRequest | null> => {
    const current = await findById(store, id);
    return current !== null &&
      (await canView(current, subject, requireDistinct, options))
      ? current
      : null;
  };

  const resolve = async (
    request: Request,
    url: URL,
    route: Extract<Route, { readonly kind: "approve" | "reject" }>,
    subject: Subject,
    read: NoteRead,
  ): Promise<Response> => {
    const current = await visible(route.id, subject);
    if (current === null) {
      return problem(404, "approval was not found");
    }
    if (ifMatchFails(request, current)) {
      return problem(412, "the approval changed since it was read");
    }
    const acting = await actingApprover(
      current,
      subject,
      requireDistinct,
      options,
    );
    const resolved = await store.resolve(
      current.token,
      compact<ApprovalVerdict>({
        status: route.kind === "approve" ? "approved" : "rejected",
        by: subject,
        note: read.note,
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
    return json(200, viewOf(resolved), {
      ETag: entityTag(resolved),
      ...(options.signer !== undefined && resolved.status === "approved"
        ? signatureLink(url)
        : {}),
    });
  };

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const parsed = parseRoute(url);
    if (parsed === undefined) {
      return problem(404, "unknown approvals route");
    }
    const route = parsed.route(request.method);
    if (route === undefined) {
      return methodNotAllowed(parsed.allow);
    }

    await store.expire();

    const subject = await resolveSubject(request, options.subject);
    const principal = subject?.principal ?? null;
    if (subject === null || principal === null) {
      return unauthenticatedProblem(hasCredentials(request));
    }

    try {
      switch (route.kind) {
        case "pending": {
          const scoped = inboxScope(url, subject);
          if (!scoped.ok) {
            return problemResponse({
              type: problemType("denied"),
              title: "Permission denied",
              status: 403,
              detail: "approver does not belong to that tenant",
            });
          }
          const page = await store.list({
            ...pageQuery(url),
            status: "pending",
          });
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
              items: page.items
                .filter((_, index) => eligible[index] === true)
                .map(viewOf),
              next: page.next,
            }),
            nextLink(url, page.next),
          );
        }
        case "mine": {
          const page = await store.list({
            ...pageQuery(url),
            principalId: principal.id,
          });
          return json(
            200,
            compact({ items: page.items.map(viewOf), next: page.next }),
            nextLink(url, page.next),
          );
        }
        case "get": {
          const current = await visible(route.id, subject);
          if (current === null) {
            return problem(404, "approval was not found");
          }
          const etag = entityTag(current);
          if (ifNoneMatchHolds(request, etag)) {
            return new Response(null, { status: 304, headers: { ETag: etag } });
          }
          return json(200, viewOf(current), { ETag: etag });
        }
        case "signature": {
          const current = await findById(store, route.id);
          const signed =
            current === null || !party(current, principal.id)
              ? undefined
              : await signApproval(
                  current,
                  options.signer,
                  compact({ audience: options.audience }),
                );
          if (signed === undefined) {
            return problem(404, "no signed approval for that request");
          }
          return new Response(signed, {
            status: 200,
            headers: { "content-type": "application/jwt" },
          });
        }
        case "approve":
        case "reject": {
          const keyed = idempotencyKey(request);
          if ("refusal" in keyed) {
            return keyed.refusal;
          }
          const read = await readNote(request);
          if (read.refusal !== undefined) {
            return read.refusal;
          }
          if (keyed.key === undefined) {
            return await resolve(request, url, route, subject, read);
          }
          const key = `${principal.id}\n${keyed.key}`;
          const fingerprint = `${route.kind} ${route.id} ${sha256Digest(read.text)}`;
          const replay = await idempotency.get(key);
          if (replay !== undefined) {
            return replay.fingerprint === fingerprint
              ? new Response(replay.body, {
                  status: replay.status,
                  headers: replay.headers.map(([name, value]) => [name, value]),
                })
              : problem(422, "Idempotency-Key was used for another request");
          }
          const response = await resolve(request, url, route, subject, read);
          if (response.ok) {
            await idempotency.set(
              key,
              await stored(response, fingerprint),
              nowMillis() + IDEMPOTENCY_TTL_MS,
            );
          }
          return response;
        }
        default: {
          const unhandled: never = route;
          return problem(404, `unknown approvals route ${String(unhandled)}`);
        }
      }
    } catch (error) {
      return mapError(error, hasCredentials(request));
    }
  };
}
