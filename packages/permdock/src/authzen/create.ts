import type { Decision } from "../core/decision.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type {
  AuthzenRequestKind,
  AuthzenRequestOf,
  ParseAuthzenRequestResult,
} from "./parse.ts";
import type { AuthzenSubjectRecord } from "./types.ts";
import type { AuthzenFactory } from "./types.ts";

import { buildInstance, resolveOrNull } from "../core/build-instance.ts";
import { compact, isRecord } from "../core/compact.ts";
import { ownGet } from "../core/paths.ts";
import { getResource } from "../core/permission-registry.ts";
import { statusProblem } from "../core/problem-types.ts";
import { resourceRef } from "../core/resource-ref.ts";
import { permissionLookup } from "../server/evaluation-items.ts";
import {
  applyApprovalResume,
  authzenMetadata,
  evaluateBatch,
  withRequestId,
} from "../server/evaluations.ts";
import { hasCredentials } from "../server/http.ts";
import {
  DEFAULT_MAX_EVALUATIONS,
  methodNotAllowed,
  problemResponse,
  unauthenticatedProblem,
} from "../server/problem.ts";
import {
  type AuthzenItem,
  UNAVAILABLE,
  UNKNOWN,
  actorOf,
  delegationOf,
  endsWithPath,
  evaluationRow,
  pathnameOf,
  permissionOf,
  resourceData,
  resourceIdOf,
  tenantOf,
  userFromEntity,
} from "./map.ts";
import { authzenPage, emptyAuthzenPage } from "./page.ts";
import { readAuthzenRequest } from "./parse.ts";
import {
  decideAuthzen,
  grantedActions,
  grantedSubjects,
  permissionsOfType,
} from "./search.ts";

function notFound(detail: string): Response {
  return problemResponse(statusProblem(404, detail));
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
    return applyApprovalResume(
      decideAuthzen(permdock, permission, data, trusted),
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

  function read<K extends AuthzenRequestKind>(
    kind: K,
    request: Request,
  ): Promise<ParseAuthzenRequestResult<AuthzenRequestOf<K>>> {
    return readAuthzenRequest(kind, request, { maxEvaluations });
  }

  async function evaluation(request: Request, pep: unknown): Promise<Response> {
    const parsed = await read("evaluation", request);
    if (!parsed.ok) {
      return problemResponse(parsed.problem);
    }
    return Response.json(await rowOf(request, pep, parsed.request.item));
  }

  async function evaluations(
    request: Request,
    pep: unknown,
  ): Promise<Response> {
    const parsed = await read("evaluations", request);
    if (!parsed.ok) {
      return problemResponse(parsed.problem);
    }
    const body = parsed.request;
    switch (body.kind) {
      case "evaluation":
        return Response.json(await rowOf(request, pep, body.item));
      case "evaluations":
        return Response.json({
          evaluations: await evaluateBatch(body.items, body.semantic, (item) =>
            rowOf(request, pep, item),
          ),
        });
      default: {
        const unreachable: never = body;
        return unreachable;
      }
    }
  }

  async function searchAction(
    request: Request,
    pep: unknown,
  ): Promise<Response> {
    const parsed = await read("search/action", request);
    if (!parsed.ok) {
      return problemResponse(parsed.problem);
    }
    const { item, page } = parsed.request;
    const type =
      typeof item.resource?.type === "string" ? item.resource.type : "";
    const actions = await grantedActions(
      permissionsOfType(policy.permissions, type),
      (leaf) =>
        decideItem(
          request,
          pep,
          compact<AuthzenItem>({
            subject: item.subject,
            context: item.context,
            resource: item.resource,
            action: { name: leaf.key },
          }),
        ),
    );
    return Response.json(authzenPage(actions, page));
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
    const parsed = await read("search/resource", request);
    if (!parsed.ok) {
      return problemResponse(parsed.problem);
    }
    const { item, page } = parsed.request;
    const type =
      typeof item.resource?.type === "string" ? item.resource.type : undefined;
    const permission = permissionOf(lookup, item);
    if (type === undefined || permission === undefined) {
      return Response.json(emptyAuthzenPage());
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
    return Response.json(authzenPage(entities, page));
  }

  async function searchSubject(
    request: Request,
    pep: unknown,
  ): Promise<Response> {
    const lister = options.subjects;
    if (lister?.list === undefined) {
      return notFound("search/subject is not configured");
    }
    const parsed = await read("search/subject", request);
    if (!parsed.ok) {
      return problemResponse(parsed.problem);
    }
    const { item, page } = parsed.request;
    let records: readonly AuthzenSubjectRecord[];
    try {
      records = await lister.list(
        compact({
          type: typeof item.subject?.type === "string" ? item.subject.type : "",
          action: item.action ?? {},
          resource: item.resource ?? {},
          context: item.context,
        }),
      );
    } catch {
      return Response.json(emptyAuthzenPage());
    }
    const matches = await grantedSubjects(
      item.subject?.type,
      records,
      (subject) =>
        decideItem(
          request,
          pep,
          compact<AuthzenItem>({
            action: item.action,
            resource: item.resource,
            context: item.context,
            subject,
          }),
        ),
    );
    return Response.json(authzenPage(matches, page));
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
