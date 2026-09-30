import type { Decision, Denial, DenialReason } from '../core/decision.ts';
import type { DecisionProvider } from '../core/interfaces.ts';
import type { Permission } from '../core/permissions.ts';
import type { Subject } from '../core/subject.ts';
import type { RemotePdpOptions } from './types.ts';

import { isRecord } from '../authzen/map.ts';
import { compact } from '../core/compact.ts';
import { listPermissions } from '../core/permissions.ts';
import {
  DEFAULT_TIMEOUT_MS,
  cacheKey,
  denied,
  granted,
  joinUrl,
  postJson,
  resourceIdOf,
  ttlCache,
  ttlMs,
} from './shared.ts';

const DEFAULT_EVALUATION = '/access/v1/evaluation';
const DEFAULT_EVALUATIONS = '/access/v1/evaluations';
const MAX_SEARCH_PAGES = 100;

function delegatedKeys(
  listed: RemotePdpOptions['permissions'],
): ReadonlySet<string> | null {
  if (listed === undefined) {
    return null;
  }
  const keys = new Set<string>();
  for (const item of listed) {
    for (const leaf of listPermissions(item)) {
      keys.add(leaf.key);
    }
  }
  return keys;
}

type Discovery = {
  readonly evaluation: string;
  readonly evaluations?: string;
  readonly searchResource?: string;
};

function parseDiscovery(url: string, body: unknown): Discovery | null {
  if (!isRecord(body)) {
    return null;
  }
  const evaluation =
    typeof body['access_evaluation_endpoint'] === 'string'
      ? body['access_evaluation_endpoint']
      : typeof body['policy_decision_point'] === 'string'
        ? joinUrl(body['policy_decision_point'], DEFAULT_EVALUATION)
        : joinUrl(url, DEFAULT_EVALUATION);
  return compact<Discovery>({
    evaluation,
    evaluations:
      typeof body['access_evaluations_endpoint'] === 'string'
        ? body['access_evaluations_endpoint']
        : joinUrl(url, DEFAULT_EVALUATIONS),
    searchResource:
      typeof body['search_resource_endpoint'] === 'string'
        ? body['search_resource_endpoint']
        : undefined,
  });
}

function mapEvaluationBody(
  permission: Permission,
  data: unknown,
  subject: Subject,
  mapping: RemotePdpOptions['mapping'],
): Record<string, unknown> {
  const defaultId =
    data !== null && typeof data === 'object'
      ? (data as Record<string, unknown>)['id']
      : undefined;
  const mappedSubject =
    mapping?.subject?.(subject) ??
    compact({
      type: 'user',
      id: subject.principal?.id,
      properties: compact({
        orgId: subject.principal?.tenant,
        roles: subject.principal?.roles,
        actor: subject.actor,
        delegation: subject.delegation,
      }),
    });
  const mappedResource =
    mapping?.resource?.(permission, data) ??
    compact({
      type: permission.resource,
      id:
        typeof defaultId === 'string' || typeof defaultId === 'number'
          ? String(defaultId)
          : resourceIdOf(data),
      properties: data,
    });
  const mappedAction = mapping?.action?.(permission) ?? {
    name: permission.action,
  };
  return {
    subject: mappedSubject,
    action: mappedAction,
    resource: mappedResource,
    context: compact({
      tenant: subject.principal?.tenant,
      actor: subject.actor,
      delegation: subject.delegation,
    }),
  };
}

function parseRemoteDecision(
  body: unknown,
  permission: Permission,
  subject: Subject,
  data: unknown,
): Decision {
  if (!isRecord(body) || typeof body['decision'] !== 'boolean') {
    return denied('pdp-invalid-response');
  }
  if (body['decision']) {
    return granted('pdp', permission, subject, data);
  }
  const context =
    isRecord(body['context']) && isRecord(body['context']['permdock'])
      ? body['context']['permdock']
      : {};
  if (context['outcome'] === 'approval-required') {
    const token = typeof context['token'] === 'string' ? context['token'] : '';
    return {
      outcome: 'approval-required',
      grant: {
        role: 'pdp',
        permission: permission.key,
        provider: 'pdp',
        approval: 'human',
      },
      reason: 'human',
      token,
    };
  }
  if (Array.isArray(context['denials'])) {
    const denials: Denial[] = context['denials'].flatMap((item) => {
      if (!isRecord(item) || typeof item['reason'] !== 'string') {
        return [];
      }
      return [
        compact<Denial>({
          role: typeof item['role'] === 'string' ? item['role'] : null,
          reason: item['reason'] as DenialReason,
          detail: item['detail'],
        }),
      ];
    });
    if (denials.length > 0) {
      return {
        outcome: 'denied',
        denials,
        alternatives: [],
      };
    }
  }
  return denied('pdp-denied');
}

function mapSearchBody(
  permission: Permission,
  subject: Subject,
  mapping: RemotePdpOptions['mapping'],
): Record<string, unknown> {
  const body = mapEvaluationBody(permission, undefined, subject, mapping);
  const resource = isRecord(body['resource']) ? body['resource'] : {};
  return {
    ...body,
    resource: { type: resource['type'] ?? permission.resource },
  };
}

function searchIds(body: unknown, type: unknown): string[] | null {
  if (!isRecord(body) || !Array.isArray(body['results'])) {
    return null;
  }
  const ids: string[] = [];
  for (const entity of body['results']) {
    if (
      !isRecord(entity) ||
      entity['type'] !== type ||
      typeof entity['id'] !== 'string'
    ) {
      return null;
    }
    ids.push(entity['id']);
  }
  return ids;
}

function nextToken(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body['page'])) {
    return undefined;
  }
  const token = body['page']['next_token'];
  return typeof token === 'string' && token !== '' ? token : undefined;
}

export function remotePdp(options: RemotePdpOptions): DecisionProvider {
  const keys = delegatedKeys(options.permissions);
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const decisions = ttlCache<Decision>(ttlMs(options.cache));
  const lists = ttlCache<readonly string[]>(ttlMs(options.cache));
  const fetcher = options.fetch ?? fetch;
  const post = { auth: options.auth, timeout };
  let discovery: Discovery | null =
    options.endpoints?.evaluation === undefined
      ? null
      : compact<Discovery>({
          evaluation: options.endpoints.evaluation,
          evaluations: options.endpoints.evaluations,
          searchResource: options.endpoints.searchResource,
        });

  async function discover(): Promise<Discovery | null> {
    if (discovery !== null) {
      return discovery;
    }
    try {
      const signal = AbortSignal.timeout(timeout);
      const response = await fetcher(
        joinUrl(options.url, '/.well-known/authzen-configuration'),
        { signal },
      );
      if (!response.ok) {
        return null;
      }
      const parsed = parseDiscovery(options.url, await response.json());
      if (parsed === null) {
        return null;
      }
      discovery = parsed;
      return parsed;
    } catch {
      return null;
    }
  }

  async function readJson(
    url: string,
    body: unknown,
  ): Promise<
    { readonly ok: true; readonly body: unknown } | { readonly ok: false }
  > {
    const posted = await postJson(fetcher, url, body, post);
    if (!posted.ok) {
      return posted;
    }
    try {
      return { ok: true, body: await posted.response.json() };
    } catch {
      return { ok: false };
    }
  }

  return {
    name: 'pdp',
    handles(permission: Permission): boolean {
      return keys === null || keys.has(permission.key);
    },
    async decide(request): Promise<Decision> {
      if (request.subject.principal === null) {
        return denied('anonymous');
      }
      let body: Record<string, unknown>;
      try {
        body = mapEvaluationBody(
          request.permission,
          request.data,
          request.subject,
          options.mapping,
        );
      } catch {
        return denied('pdp-invalid-response');
      }
      const key = cacheKey(request.subject, request.permission, body);
      const hit = decisions.get(key);
      if (hit !== undefined) {
        return hit;
      }
      const endpoints = await discover();
      if (endpoints === null) {
        return denied('pdp-unavailable');
      }
      const posted = await readJson(endpoints.evaluation, body);
      if (!posted.ok) {
        return denied('pdp-unavailable');
      }
      const decision = parseRemoteDecision(
        posted.body,
        request.permission,
        request.subject,
        request.data,
      );
      const cacheable =
        decision.outcome === 'granted' ||
        decision.outcome === 'approval-required' ||
        (decision.outcome === 'denied' &&
          decision.denials[0]?.reason === 'pdp-denied');
      if (cacheable) {
        decisions.set(key, decision);
      }
      return decision;
    },
    async permitted(request): Promise<readonly string[] | null | undefined> {
      if (request.subject.principal === null) {
        return [];
      }
      const endpoints = await discover();
      if (endpoints === null) {
        return null;
      }
      if (endpoints.searchResource === undefined) {
        return undefined;
      }
      let body: Record<string, unknown>;
      try {
        body = mapSearchBody(
          request.permission,
          request.subject,
          options.mapping,
        );
      } catch {
        return null;
      }
      const key = cacheKey(request.subject, request.permission, body);
      const hit = lists.get(key);
      if (hit !== undefined) {
        return hit;
      }
      const type = isRecord(body['resource'])
        ? body['resource']['type']
        : undefined;
      const url = endpoints.searchResource;
      const collect = async (
        token: string | undefined,
        page: number,
        ids: readonly string[],
      ): Promise<readonly string[] | null> => {
        if (page >= MAX_SEARCH_PAGES) {
          return null;
        }
        const posted = await readJson(
          url,
          token === undefined ? body : { ...body, page: { token } },
        );
        const found = posted.ok ? searchIds(posted.body, type) : null;
        if (!posted.ok || found === null) {
          return null;
        }
        const next = nextToken(posted.body);
        return next === undefined
          ? [...ids, ...found]
          : collect(next, page + 1, [...ids, ...found]);
      };
      const ids = await collect(undefined, 0, []);
      if (ids === null) {
        return null;
      }
      const frozen = Object.freeze([...ids]);
      lists.set(key, frozen);
      return frozen;
    },
  };
}
