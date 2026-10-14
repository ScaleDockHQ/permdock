import type { Decision } from "../core/decision.ts";
import type { DecideOptions, PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { AuthzenFactory } from "./types.ts";

import { buildInstance, resolveOrNull } from "../core/build-instance.ts";
import { compact, isRecord } from "../core/compact.ts";
import { ownGet } from "../core/paths.ts";
import { getResource, listPermissions } from "../core/permission-registry.ts";
import { statusProblem } from "../core/problem-types.ts";
import { resourceRef } from "../core/resource-ref.ts";
import { permissionLookup } from "../server/evaluation-items.ts";
import {
  applyApprovalResume,
  authzenMetadata,
  evaluateBatch,
  evaluationsSemantic,
  unknownSemanticProblem,
  withRequestId,
} from "../server/evaluations.ts";
import { hasCredentials } from "../server/http.ts";
import {
  DEFAULT_MAX_EVALUATIONS,
  batchTooLarge,
  methodNotAllowed,
  problemResponse,
  unauthenticatedProblem,
  validationProblem,
} from "../server/problem.ts";
import {
  type AuthzenItem,
  UNAVAILABLE,
  UNKNOWN,
  actorOf,
  delegationOf,
  endsWithPath,
  evaluationRow,
  mergeEvaluationItem,
  pageOf,
  paged,
  pathnameOf,
  permissionOf,
  resourceData,
  resourceIdOf,
  tenantOf,
  userFromEntity,
} from "./map.ts";

function notFound(detail: string): Response {
  return problemResponse(statusProblem(404, detail));
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return validationProblem("AuthZEN body was not valid JSON");
  }
}

const WELL_KNOWN = "/.well-known/authzen-configuration";

/** The name an item's action gives, for the reasons of an unknown permission. */
function actionName(item: AuthzenItem): string {
  return typeof item.action?.name === "string" ? item.action.name : "unknown";
}

export const createPermDock: AuthzenFactory = (policy, options) => {
  const maxEvaluations = options.maxEvaluations ?? DEFAULT_MAX_EVALUATIONS;
  const lookup = permissionLookup(policy.permissions);
  const trusts = (pep: unknown): boolean => {
    const allow = options.trustedPep;
    if (typeof allow !== "function" || pep === null) {
      return false;
    }
    try {
      return allow(pep) === true;
    } catch {
      return false;
    }
  };
  const allowAnonymous = options.anonymous === true;

  async function authenticate(
    request: Request,
  ): Promise<{ readonly pep: unknown } | Response> {
    const pep = await resolveOrNull(() => options.subject(request));
    if ((pep === null || pep === undefined) && !allowAnonymous) {
      return unauthenticatedProblem(hasCredentials(request));
    }
    return { pep: pep ?? null };
  }

  async function instantiate(
    pep: unknown,
    item: AuthzenItem,
  ): Promise<PermDock> {
    const trusted = trusts(pep);
    const bodyUser = trusted ? userFromEntity(item.subject) : null;
    const user = bodyUser ?? pep;
    const built = await buildInstance({
      policy,
      user,
      sources: options,
      scope: {
        actor: trusted ? actorOf(item) : undefined,
        delegation: trusted ? delegationOf(item) : undefined,
        tenant: tenantOf(item),
      },
    });
    return built.permdock;
  }

  async function resourceOf(item: AuthzenItem): Promise<
    | {
        readonly data: unknown;
        readonly trusted: boolean;
      }
    | undefined
  > {
    const properties = item.resource?.properties;
    if (properties !== null && typeof properties === "object") {
      return { data: properties, trusted: false };
    }
    const type =
      typeof item.resource?.type === "string" ? item.resource.type : undefined;
    const id = resourceIdOf(item);
    const load =
      type !== undefined && options.resources !== undefined
        ? options.resources[type]?.data
        : undefined;
    if (id !== undefined && load !== undefined) {
      try {
        const loaded = await load(id);
        return { data: loaded, trusted: true };
      } catch {
        return undefined;
      }
    }
    return { data: resourceData(item), trusted: false };
  }

  async function decideItem(
    request: Request,
    pep: unknown,
    item: AuthzenItem,
  ): Promise<Decision> {
    const permission = permissionOf(lookup, item);
    if (permission === undefined) {
      return UNKNOWN;
    }
    const resolved = await resourceOf(item);
    if (resolved === undefined) {
      return UNAVAILABLE;
    }
    const { data, trusted } = resolved;
    const permdock = await instantiate(pep, item);
    // SAFETY: decide's instance and collection overloads share one implementation that takes either kind.
    const decide = permdock.decide as (
      next: Permission,
      row?: unknown,
      options?: DecideOptions,
    ) => Decision;
    const decision = decide(
      permission,
      data,
      trusted
        ? { call: "endpoint", adapter: "authzen", trusted: true }
        : {
            call: "endpoint",
            adapter: "authzen",
            trusted: false,
            boundary: "decision-endpoint",
          },
    );
    return applyApprovalResume(
      decision,
      permission,
      permdock,
      options.store,
      request,
      resourceRef(permission, data, resourceIdOf(item)),
      "authzen",
    );
  }

  async function rowOf(
    request: Request,
    pep: unknown,
    item: AuthzenItem,
  ): Promise<ReturnType<typeof evaluationRow>> {
    const decision = await decideItem(request, pep, item);
    return evaluationRow(
      decision,
      permissionOf(lookup, item)?.key ?? actionName(item),
    );
  }

  async function evaluation(request: Request, pep: unknown): Promise<Response> {
    const body = await readJson(request);
    if (body instanceof Response) {
      return body;
    }
    if (!isRecord(body)) {
      return validationProblem("evaluation body must be an object");
    }
    return Response.json(await rowOf(request, pep, body));
  }

  async function evaluations(
    request: Request,
    pep: unknown,
  ): Promise<Response> {
    const body = await readJson(request);
    if (body instanceof Response) {
      return body;
    }
    if (!isRecord(body)) {
      return validationProblem("evaluations body must be an object");
    }
    const items = body["evaluations"] ?? [];
    if (!Array.isArray(items)) {
      return validationProblem("evaluations must be an array");
    }
    if (items.length === 0) {
      return Response.json(await rowOf(request, pep, body));
    }
    if (items.length > maxEvaluations) {
      return batchTooLarge(maxEvaluations);
    }
    const semantic = evaluationsSemantic(body);
    if (semantic === undefined) {
      return unknownSemanticProblem();
    }
    const shared = compact<AuthzenItem>({
      subject: isRecord(body["subject"]) ? body["subject"] : undefined,
      action: isRecord(body["action"]) ? body["action"] : undefined,
      resource: isRecord(body["resource"]) ? body["resource"] : undefined,
      context: body["context"],
    });
    return Response.json({
      evaluations: await evaluateBatch(items, semantic, (item) =>
        rowOf(request, pep, mergeEvaluationItem(shared, item)),
      ),
    });
  }

  async function searchAction(
    request: Request,
    pep: unknown,
  ): Promise<Response> {
    const body = await readJson(request);
    if (body instanceof Response) {
      return body;
    }
    if (!isRecord(body)) {
      return validationProblem("search/action body must be an object");
    }
    const item: AuthzenItem = body;
    const type =
      typeof item.resource?.type === "string" ? item.resource.type : undefined;
    const leaves = listPermissions(policy.permissions).filter(
      (leaf) => type === undefined || leaf.resource === type,
    );
    const decisions = await Promise.all(
      leaves.map(async (leaf) => ({
        leaf,
        decision: await decideItem(
          request,
          pep,
          compact<AuthzenItem>({
            subject: item.subject,
            context: item.context,
            resource: item.resource,
            action: { name: leaf.key },
          }),
        ),
      })),
    );
    const names: string[] = [];
    for (const { leaf, decision } of decisions) {
      if (decision.outcome === "granted" && !names.includes(leaf.action)) {
        names.push(leaf.action);
      }
    }
    const { offset, size } = pageOf(body);
    return Response.json(
      paged(
        names.map((name) => ({ name })),
        offset,
        size,
      ),
    );
  }

  async function listRows(
    type: string,
    where: unknown,
  ): Promise<readonly unknown[]> {
    const list = options.resources?.[type]?.list;
    if (list === undefined) {
      return [];
    }
    try {
      return await list({ where });
    } catch {
      return [];
    }
  }

  async function searchResource(
    request: Request,
    pep: unknown,
  ): Promise<Response> {
    const body = await readJson(request);
    if (body instanceof Response) {
      return body;
    }
    if (!isRecord(body)) {
      return validationProblem("search/resource body must be an object");
    }
    const item: AuthzenItem = body;
    const type =
      typeof item.resource?.type === "string" ? item.resource.type : undefined;
    const permission = permissionOf(lookup, item);
    if (type === undefined || permission === undefined) {
      return Response.json(paged([], 0, 1));
    }
    const rows = await listRows(
      type,
      isRecord(item.resource?.properties)
        ? item.resource.properties
        : undefined,
    );
    const permdock = await instantiate(pep, item);
    let permitted: readonly unknown[] = [];
    if (permission.kind === "instance") {
      // SAFETY: permission.kind is checked to be instance just above.
      permitted = permdock.filter(
        permission as Permission<string, unknown, "instance">,
        rows,
      );
    } else if (
      permission.kind === "collection" &&
      // SAFETY: permission.kind is checked to be collection just before.
      permdock.can(permission as Permission<string, unknown, "collection">)
    ) {
      permitted = rows;
    }
    const idField = getResource(policy.permissions, type)?.id ?? "id";
    const entities = permitted.flatMap((row) => {
      const id = isRecord(row) ? ownGet(row, idField) : undefined;
      return typeof id === "string" || typeof id === "number"
        ? [{ type, id: String(id) }]
        : [];
    });
    const { offset, size } = pageOf(body);
    return Response.json(paged(entities, offset, size));
  }

  async function searchSubject(
    request: Request,
    pep: unknown,
  ): Promise<Response> {
    if (options.subjects?.list === undefined) {
      return notFound("search/subject is not configured");
    }
    const body = await readJson(request);
    if (body instanceof Response) {
      return body;
    }
    if (!isRecord(body)) {
      return validationProblem("search/subject body must be an object");
    }
    let records: readonly {
      readonly id: string;
      readonly [key: string]: unknown;
    }[];
    try {
      records = await options.subjects.list();
    } catch {
      return Response.json(paged([], 0, 1));
    }
    const item: AuthzenItem = body;
    const wanted = item.subject?.type;
    if (typeof wanted === "string" && wanted !== "user") {
      return Response.json(paged([], 0, 1));
    }
    const decisions = await Promise.all(
      records.map(async (record) => {
        const properties: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(record)) {
          if (key !== "id") {
            properties[key] = value;
          }
        }
        return {
          id: record.id,
          decision: await decideItem(
            request,
            pep,
            compact<AuthzenItem>({
              action: item.action,
              resource: item.resource,
              context: item.context,
              subject: { type: "user", id: record.id, properties },
            }),
          ),
        };
      }),
    );
    const matches = decisions.flatMap(({ id, decision }) =>
      decision.outcome === "granted" ? [{ type: "user", id }] : [],
    );
    const { offset, size } = pageOf(body);
    return Response.json(paged(matches, offset, size));
  }

  function discovery(request: Request, pathname: string): Response {
    const origin = new URL(request.url).origin;
    const suffix = pathname
      .slice(pathname.indexOf(WELL_KNOWN) + WELL_KNOWN.length)
      .replace(/\/+$/u, "");
    const pdp = `${origin}${suffix}`;
    return Response.json(
      authzenMetadata(pdp, {
        action: true,
        resource: true,
        subject: options.subjects?.list !== undefined,
      }),
    );
  }

  async function route(request: Request): Promise<Response> {
    const pathname = pathnameOf(request);
    if (
      endsWithPath(pathname, WELL_KNOWN) ||
      pathname.includes(`${WELL_KNOWN}/`)
    ) {
      if (request.method !== "GET") {
        return methodNotAllowed("GET");
      }
      return discovery(request, pathname);
    }

    const identity = await authenticate(request);
    if (identity instanceof Response) {
      return identity;
    }

    const routes: readonly (readonly [
      string,
      string,
      (req: Request, identity: unknown) => Promise<Response>,
    ])[] = [
      ["POST", "/access/v1/evaluation", evaluation],
      ["POST", "/access/v1/evaluations", evaluations],
      ["POST", "/access/v1/search/action", searchAction],
      ["POST", "/access/v1/search/resource", searchResource],
      ["POST", "/access/v1/search/subject", searchSubject],
    ];
    for (const [method, suffix, serve] of routes) {
      if (endsWithPath(pathname, suffix)) {
        if (request.method !== method) {
          return methodNotAllowed(method);
        }
        return serve(request, identity.pep);
      }
    }
    return notFound("unknown AuthZEN path");
  }

  const handler = async (request: Request): Promise<Response> =>
    withRequestId(request, await route(request));

  return { permdockHandler: () => handler };
};
