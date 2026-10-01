import type { Decision } from '../core/decision.ts';
import type { DecideOptions, PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { AuthzenItem } from './map.ts';
import type { AuthzenFactory } from './types.ts';

import { compact } from '../core/compact.ts';
import { ownGet } from '../core/paths.ts';
import { createPermDock as createCorePermDock } from '../core/permdock.ts';
import { getResource, listPermissions } from '../core/permissions.ts';
import { applyApprovalResume } from '../server/evaluations.ts';
import {
  PROBLEM_BASE,
  problemResponse,
  validationProblem,
} from '../server/problem.ts';
import {
  UNAVAILABLE,
  UNKNOWN,
  actorOf,
  delegationOf,
  endsWithPath,
  evaluationRow,
  isRecord,
  mergeItem,
  pageOf,
  paged,
  pathnameOf,
  permissionOf,
  resourceData,
  resourceIdOf,
  tenantOf,
  userFromEntity,
} from './map.ts';

const DEFAULT_MAX = 256;

function unauthorized(): Response {
  return problemResponse(
    {
      type: `${PROBLEM_BASE}/unauthenticated`,
      title: 'Unauthenticated',
      status: 401,
      detail: 'AuthZEN decision endpoint requires authentication',
    },
    undefined,
    {
      outcome: 'denied',
      denials: [{ role: null, reason: 'anonymous' }],
      alternatives: [],
    },
  );
}

function methodNotAllowed(allow: string): Response {
  const response = problemResponse({
    type: `${PROBLEM_BASE}/method-not-allowed`,
    title: 'Method not allowed',
    status: 405,
    detail: `use ${allow}`,
  });
  response.headers.set('Allow', allow);
  return response;
}

function notFound(detail: string): Response {
  return problemResponse({
    type: `${PROBLEM_BASE}/not-found`,
    title: 'Not found',
    status: 404,
    detail,
  });
}

function tooLarge(max: number): Response {
  return problemResponse({
    type: `${PROBLEM_BASE}/payload-too-large`,
    title: 'Payload too large',
    status: 413,
    detail: `evaluations batch exceeds ${String(max)}`,
  });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return validationProblem('AuthZEN body was not valid JSON');
  }
}

function resourceRef(
  permission: Permission,
  data: unknown,
  item: AuthzenItem,
): { readonly type: string; readonly id?: string } {
  const fromRow =
    data !== null && typeof data === 'object' && 'id' in data
      ? data.id
      : undefined;
  const fromWire = item.resource?.id;
  const id =
    typeof fromRow === 'string' || typeof fromRow === 'number'
      ? String(fromRow)
      : typeof fromWire === 'string' || typeof fromWire === 'number'
        ? String(fromWire)
        : undefined;
  return compact({ type: permission.resource, id });
}

export const createPermDock: AuthzenFactory = (policy, options) => {
  const maxEvaluations = options.maxEvaluations ?? DEFAULT_MAX;
  const trusts = (pep: unknown): boolean => {
    const allow = options.trustedPep;
    if (typeof allow !== 'function' || pep === null) {
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
    let pep: unknown;
    try {
      pep = await options.subject(request);
    } catch {
      pep = null;
    }
    if ((pep === null || pep === undefined) && !allowAnonymous) {
      return unauthorized();
    }
    return { pep: pep ?? null };
  }

  function instantiate(
    pep: unknown,
    item: AuthzenItem,
  ): PermDock | Promise<PermDock> {
    const trusted = trusts(pep);
    const bodyUser = trusted ? userFromEntity(item.subject) : null;
    const user = bodyUser ?? pep;
    return createCorePermDock(
      policy,
      user,
      compact({
        actor: trusted ? actorOf(item) : undefined,
        delegation: trusted ? delegationOf(item) : undefined,
        tenant: tenantOf(item),
        memberships: options.memberships,
        relations: options.relations,
        entitlements: options.entitlements,
        customRoles: options.customRoles,
        policies: options.policies,
        sink: options.sink,
        limits: options.limits,
      }),
    );
  }

  async function resourceOf(item: AuthzenItem): Promise<
    | {
        readonly data: unknown;
        readonly trusted: boolean;
      }
    | undefined
  > {
    const properties = item.resource?.properties;
    if (properties !== null && typeof properties === 'object') {
      return { data: properties, trusted: false };
    }
    const type =
      typeof item.resource?.type === 'string' ? item.resource.type : undefined;
    const id = resourceIdOf(item);
    const load =
      type !== undefined && options.resources !== undefined
        ? options.resources[type]?.load
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
    const permission = permissionOf(policy.permissions, item);
    if (permission === undefined) {
      return UNKNOWN;
    }
    const resolved = await resourceOf(item);
    if (resolved === undefined) {
      return UNAVAILABLE;
    }
    const { data, trusted } = resolved;
    const dock = await instantiate(pep, item);
    // SAFETY: decide's instance and collection overloads share one implementation that takes either kind.
    const decide = dock.decide as (
      next: Permission,
      row?: unknown,
      options?: DecideOptions,
    ) => Decision;
    const decision = decide(
      permission,
      data,
      trusted
        ? { source: 'endpoint', adapter: 'authzen', trusted: true }
        : {
            source: 'endpoint',
            adapter: 'authzen',
            trusted: false,
            boundary: 'decision-endpoint',
          },
    );
    return applyApprovalResume(
      decision,
      permission,
      dock,
      options.store,
      request,
      resourceRef(permission, data, item),
      'authzen',
    );
  }

  async function evaluation(request: Request, pep: unknown): Promise<Response> {
    const body = await readJson(request);
    if (body instanceof Response) {
      return body;
    }
    if (!isRecord(body)) {
      return validationProblem('evaluation body must be an object');
    }
    return Response.json(evaluationRow(await decideItem(request, pep, body)));
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
      return validationProblem('evaluations body must be an object');
    }
    const items = body['evaluations'];
    if (items === undefined) {
      return validationProblem('evaluations array is required');
    }
    if (!Array.isArray(items)) {
      return validationProblem('evaluations must be an array');
    }
    if (items.length > maxEvaluations) {
      return tooLarge(maxEvaluations);
    }
    const shared = compact<AuthzenItem>({
      subject: isRecord(body['subject']) ? body['subject'] : undefined,
      action: isRecord(body['action']) ? body['action'] : undefined,
      resource: isRecord(body['resource']) ? body['resource'] : undefined,
      context: body['context'],
    });
    const rows = await Promise.all(
      items.map((item) =>
        decideItem(request, pep, mergeItem(shared, item)).then(evaluationRow),
      ),
    );
    return Response.json({ evaluations: rows });
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
      return validationProblem('search/action body must be an object');
    }
    const item: AuthzenItem = body;
    const type =
      typeof item.resource?.type === 'string' ? item.resource.type : undefined;
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
      if (decision.outcome === 'granted' && !names.includes(leaf.action)) {
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
      return validationProblem('search/resource body must be an object');
    }
    const item: AuthzenItem = body;
    const type =
      typeof item.resource?.type === 'string' ? item.resource.type : undefined;
    const permission = permissionOf(policy.permissions, item);
    if (type === undefined || permission === undefined) {
      return Response.json({ results: [], page: { next_token: '' } });
    }
    const rows = await listRows(
      type,
      isRecord(item.resource?.properties)
        ? item.resource.properties
        : undefined,
    );
    const dock = await instantiate(pep, item);
    let permitted: readonly unknown[] = [];
    if (permission.kind === 'instance') {
      // SAFETY: permission.kind is checked to be instance just above.
      permitted = dock.filter(
        permission as Permission<string, unknown, 'instance'>,
        rows,
      );
    } else if (
      permission.kind === 'collection' &&
      // SAFETY: permission.kind is checked to be collection just before.
      dock.can(permission as Permission<string, unknown, 'collection'>)
    ) {
      permitted = rows;
    }
    const idField = getResource(policy.permissions, type)?.id ?? 'id';
    const entities = permitted.flatMap((row) => {
      const id = isRecord(row) ? ownGet(row, idField) : undefined;
      return typeof id === 'string' || typeof id === 'number'
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
      return notFound('search/subject is not configured');
    }
    const body = await readJson(request);
    if (body instanceof Response) {
      return body;
    }
    if (!isRecord(body)) {
      return validationProblem('search/subject body must be an object');
    }
    let records: readonly {
      readonly id: string;
      readonly [key: string]: unknown;
    }[];
    try {
      records = await options.subjects.list();
    } catch {
      return Response.json({ results: [], page: { next_token: '' } });
    }
    const item: AuthzenItem = body;
    const decisions = await Promise.all(
      records.map(async (record) => {
        const properties: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(record)) {
          if (key !== 'id') {
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
              subject: { type: 'user', id: record.id, properties },
            }),
          ),
        };
      }),
    );
    const matches = decisions.flatMap(({ id, decision }) =>
      decision.outcome === 'granted' ? [{ type: 'user', id }] : [],
    );
    const { offset, size } = pageOf(body);
    return Response.json(paged(matches, offset, size));
  }

  function discovery(request: Request): Response {
    const origin = new URL(request.url).origin;
    const document: Record<string, string> = {
      policy_decision_point: origin,
      access_evaluation_endpoint: `${origin}/access/v1/evaluation`,
      access_evaluations_endpoint: `${origin}/access/v1/evaluations`,
      search_action_endpoint: `${origin}/access/v1/search/action`,
      search_resource_endpoint: `${origin}/access/v1/search/resource`,
    };
    if (options.subjects?.list !== undefined) {
      document['search_subject_endpoint'] =
        `${origin}/access/v1/search/subject`;
    }
    return Response.json(document);
  }

  return {
    async handler(request) {
      const pathname = pathnameOf(request);
      if (
        endsWithPath(pathname, '/.well-known/authzen-configuration') ||
        pathname.includes('/.well-known/authzen-configuration/')
      ) {
        if (request.method !== 'GET') {
          return methodNotAllowed('GET');
        }
        return discovery(request);
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
        ['POST', '/access/v1/evaluation', evaluation],
        ['POST', '/access/v1/evaluations', evaluations],
        ['POST', '/access/v1/search/action', searchAction],
        ['POST', '/access/v1/search/resource', searchResource],
        ['POST', '/access/v1/search/subject', searchSubject],
      ];
      for (const [method, suffix, route] of routes) {
        if (endsWithPath(pathname, suffix)) {
          if (request.method !== method) {
            return methodNotAllowed(method);
          }
          return route(request, identity.pep);
        }
      }
      return notFound('unknown AuthZEN path');
    },
  };
};
