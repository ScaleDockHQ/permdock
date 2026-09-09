import type { Decision, Denial, DenialReason } from '../core/decision.ts';
import type { DecisionProvider } from '../core/interfaces.ts';
import type { Permission } from '../core/permissions.ts';
import type { Subject } from '../core/subject.ts';
import type { RemotePdpOptions } from './types.ts';

import { isRecord } from '../authzen/map.ts';
import { compact } from '../core/compact.ts';
import { listPermissions } from '../core/permissions.ts';
import { decisionToken } from '../core/token.ts';

const DEFAULT_TIMEOUT_MS = 300;
const DEFAULT_EVALUATION = '/access/v1/evaluation';
const DEFAULT_EVALUATIONS = '/access/v1/evaluations';

function ttlMs(ttl: RemotePdpOptions['cache']): number {
  if (ttl === undefined) {
    return 0;
  }
  if (typeof ttl.ttl === 'number') {
    return ttl.ttl;
  }
  if (ttl.ttl.endsWith('ms')) {
    return Number(ttl.ttl.slice(0, -2));
  }
  return Number(ttl.ttl.slice(0, -1)) * 1000;
}

function joinUrl(base: string, path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${trimmed}${path.startsWith('/') ? path : `/${path}`}`;
}

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

function resourceIdOf(data: unknown): string {
  if (data === null || typeof data !== 'object') {
    return '*';
  }
  const record = data as Record<string, unknown>;
  const id = record.id;
  if (typeof id === 'string' || typeof id === 'number') {
    return String(id);
  }
  return '*';
}

function cacheKey(
  subject: Subject,
  permission: Permission,
  data: unknown,
): string {
  return [
    subject.principal?.id ?? '',
    subject.actor?.id ?? '',
    permission.key,
    resourceIdOf(data),
  ].join(':');
}

function denied(reason: DenialReason): Decision {
  return {
    outcome: 'denied',
    denials: [{ role: null, reason }],
    alternatives: [],
  };
}

function granted(
  permission: Permission,
  subject: Subject,
  fingerprint: string,
  data: unknown,
): Extract<Decision, { readonly outcome: 'granted' }> {
  const principal = subject.principal!;
  return {
    outcome: 'granted',
    subject: { ...subject, principal },
    matched: {
      role: 'pdp',
      permission: permission.key,
      provider: 'pdp',
    },
    token: decisionToken({
      key: permission.key,
      resourceId: resourceIdOf(data),
      principal,
      actor: subject.actor,
      fingerprint,
    }),
  };
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
    typeof body.access_evaluation_endpoint === 'string'
      ? body.access_evaluation_endpoint
      : typeof body.policy_decision_point === 'string'
        ? joinUrl(body.policy_decision_point, DEFAULT_EVALUATION)
        : joinUrl(url, DEFAULT_EVALUATION);
  return compact<Discovery>({
    evaluation,
    evaluations:
      typeof body.access_evaluations_endpoint === 'string'
        ? body.access_evaluations_endpoint
        : joinUrl(url, DEFAULT_EVALUATIONS),
    searchResource:
      typeof body.search_resource_endpoint === 'string'
        ? body.search_resource_endpoint
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
      ? (data as Record<string, unknown>).id
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
  fingerprint: string,
  data: unknown,
): Decision {
  if (!isRecord(body) || typeof body.decision !== 'boolean') {
    return denied('pdp-invalid-response');
  }
  if (body.decision) {
    return granted(permission, subject, fingerprint, data);
  }
  const context = isRecord(body.context) ? body.context : {};
  if (context.outcome === 'approval-required') {
    const token = typeof context.token === 'string' ? context.token : '';
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
  if (Array.isArray(context.denials)) {
    const denials: Denial[] = context.denials.flatMap((item) => {
      if (!isRecord(item) || typeof item.reason !== 'string') {
        return [];
      }
      return [
        compact<Denial>({
          role: typeof item.role === 'string' ? item.role : null,
          reason: item.reason as DenialReason,
          detail: item.detail,
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

export function remotePdp(options: RemotePdpOptions): DecisionProvider {
  const keys = delegatedKeys(options.permissions);
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const cacheTtl = ttlMs(options.cache);
  const cache = new Map<
    string,
    { readonly at: number; readonly decision: Decision }
  >();
  const fetcher = options.fetch ?? fetch;
  let discovery: Discovery | null =
    options.endpoints?.evaluation === undefined
      ? null
      : compact<Discovery>({
          evaluation: options.endpoints.evaluation,
          evaluations: options.endpoints.evaluations,
          searchResource: options.endpoints.searchResource,
        });

  async function bearer(): Promise<string | null> {
    const auth = options.auth;
    if (auth === undefined) {
      return null;
    }
    try {
      const token =
        typeof auth.bearer === 'function' ? await auth.bearer() : auth.bearer;
      return token === '' ? null : token;
    } catch {
      return null;
    }
  }

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

  async function post(
    url: string,
    body: unknown,
  ): Promise<
    { readonly ok: true; readonly body: unknown } | { readonly ok: false }
  > {
    const token = await bearer();
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (token !== null) {
      headers.authorization = `Bearer ${token}`;
    }
    try {
      const response = await fetcher(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) {
        return { ok: false };
      }
      return { ok: true, body: await response.json() };
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
      const key = cacheKey(request.subject, request.permission, request.data);
      if (cacheTtl > 0) {
        const hit = cache.get(key);
        if (hit !== undefined && Date.now() - hit.at < cacheTtl) {
          return hit.decision;
        }
      }
      const endpoints = await discover();
      if (endpoints === null) {
        return denied('pdp-unavailable');
      }
      const posted = await post(
        endpoints.evaluation,
        mapEvaluationBody(
          request.permission,
          request.data,
          request.subject,
          options.mapping,
        ),
      );
      if (!posted.ok) {
        return denied('pdp-unavailable');
      }
      const decision = parseRemoteDecision(
        posted.body,
        request.permission,
        request.subject,
        'pdp',
        request.data,
      );
      const cacheable =
        decision.outcome === 'granted' ||
        decision.outcome === 'approval-required' ||
        (decision.outcome === 'denied' &&
          decision.denials[0]?.reason === 'pdp-denied');
      if (cacheTtl > 0 && cacheable) {
        cache.set(key, { at: Date.now(), decision });
      }
      return decision;
    },
  };
}
