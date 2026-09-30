import type { Decision } from '../core/decision.ts';
import type { DecisionProvider } from '../core/interfaces.ts';
import type { Permission } from '../core/permissions.ts';
import type { Subject } from '../core/subject.ts';
import type {
  OpenFgaOptions,
  OpenFgaTuple,
  RelationMap,
  RemotePdpAuth,
  RemotePdpCache,
  SpiceDbCheck,
  SpiceDbOptions,
} from './types.ts';

import { isRecord } from '../authzen/map.ts';
import { compact } from '../core/compact.ts';
import {
  DEFAULT_TIMEOUT_MS,
  cacheKey,
  denied,
  granted,
  joinUrl,
  postJson,
  ttlCache,
  ttlMs,
} from './shared.ts';

type CheckResult = boolean | 'unavailable' | 'invalid';

type RelationBackend<T> = {
  readonly name: string;
  readonly map: RelationMap<T>;
  readonly auth?: RemotePdpAuth;
  readonly timeout?: number;
  readonly cache?: RemotePdpCache;
  readonly check: (tuple: T, post: Post) => Promise<CheckResult>;
  readonly list: (tuple: T, post: Post) => Promise<readonly string[] | null>;
  readonly fetch?: typeof fetch;
};

type Post = (path: string, body: unknown) => Promise<Response | null>;

function relationProvider<T>(backend: RelationBackend<T>): DecisionProvider {
  const callbacks = new Map<
    string,
    (subject: Subject, data: unknown) => T | null
  >();
  for (const [permission, callback] of backend.map) {
    callbacks.set(permission.key, callback);
  }
  const timeout = backend.timeout ?? DEFAULT_TIMEOUT_MS;
  const decisions = ttlCache<Decision>(ttlMs(backend.cache));
  const lists = ttlCache<readonly string[]>(ttlMs(backend.cache));
  const fetcher = backend.fetch ?? fetch;
  const post: Post = async (url, body) => {
    const posted = await postJson(fetcher, url, body, {
      auth: backend.auth,
      timeout,
    });
    return posted.ok ? posted.response : null;
  };

  function tupleFor(
    permission: Permission,
    subject: Subject,
    data: unknown,
  ): T | null | 'invalid' {
    const callback = callbacks.get(permission.key);
    if (callback === undefined) {
      return null;
    }
    try {
      return callback(subject, data);
    } catch {
      return 'invalid';
    }
  }

  return {
    name: backend.name,
    handles(permission: Permission): boolean {
      return callbacks.has(permission.key);
    },
    async decide(request): Promise<Decision> {
      if (request.subject.principal === null) {
        return denied('anonymous');
      }
      const tuple = tupleFor(request.permission, request.subject, request.data);
      if (tuple === 'invalid') {
        return denied('pdp-invalid-response');
      }
      if (tuple === null) {
        return denied('pdp-denied');
      }
      const key = cacheKey(request.subject, request.permission, tuple);
      const hit = decisions.get(key);
      if (hit !== undefined) {
        return hit;
      }
      const result = await backend.check(tuple, post);
      if (result === 'unavailable') {
        return denied('pdp-unavailable');
      }
      if (result === 'invalid') {
        return denied('pdp-invalid-response');
      }
      const decision = result
        ? granted(
            backend.name,
            request.permission,
            request.subject,
            request.data,
          )
        : denied('pdp-denied');
      decisions.set(key, decision);
      return decision;
    },
    async permitted(request): Promise<readonly string[] | null> {
      if (request.subject.principal === null) {
        return [];
      }
      const tuple = tupleFor(request.permission, request.subject, undefined);
      if (tuple === 'invalid') {
        return null;
      }
      if (tuple === null) {
        return [];
      }
      const key = cacheKey(request.subject, request.permission, tuple);
      const hit = lists.get(key);
      if (hit !== undefined) {
        return hit;
      }
      const ids = await backend.list(tuple, post);
      if (ids !== null) {
        lists.set(key, ids);
      }
      return ids;
    },
  };
}

async function jsonOf(response: Response | null): Promise<unknown> {
  if (response === null) {
    return undefined;
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

/**
 * An OpenFGA store as a decision provider: `check` decides one row and
 * `list-objects` lists the ids `filter` and `where` use.
 */
export function openfga(options: OpenFgaOptions): DecisionProvider {
  const store = joinUrl(
    options.url,
    `/stores/${encodeURIComponent(options.storeId)}`,
  );
  const model = compact({
    authorization_model_id: options.authorizationModelId,
  });
  return relationProvider<OpenFgaTuple>(
    compact({
      name: 'openfga',
      map: options.map,
      auth: options.auth,
      timeout: options.timeout,
      cache: options.cache,
      fetch: options.fetch,
      async check(tuple: OpenFgaTuple, post: Post): Promise<CheckResult> {
        if (tuple.id === undefined) {
          return 'invalid';
        }
        const body = await jsonOf(
          await post(`${store}/check`, {
            ...model,
            tuple_key: {
              user: tuple.user,
              relation: tuple.relation,
              object: `${tuple.type}:${tuple.id}`,
            },
          }),
        );
        if (body === undefined) {
          return 'unavailable';
        }
        return isRecord(body) && typeof body['allowed'] === 'boolean'
          ? body['allowed']
          : 'invalid';
      },
      async list(
        tuple: OpenFgaTuple,
        post: Post,
      ): Promise<readonly string[] | null> {
        const body = await jsonOf(
          await post(`${store}/list-objects`, {
            ...model,
            type: tuple.type,
            relation: tuple.relation,
            user: tuple.user,
          }),
        );
        if (!isRecord(body) || !Array.isArray(body['objects'])) {
          return null;
        }
        const prefix = `${tuple.type}:`;
        const ids: string[] = [];
        for (const object of body['objects']) {
          if (typeof object !== 'string' || !object.startsWith(prefix)) {
            return null;
          }
          ids.push(object.slice(prefix.length));
        }
        return Object.freeze(ids);
      },
    }),
  );
}

function subjectReference(check: SpiceDbCheck): Record<string, unknown> {
  return compact({
    object: { objectType: check.subject.type, objectId: check.subject.id },
    optionalRelation: check.subject.relation,
  });
}

/**
 * A SpiceDB HTTP gateway as a decision provider: `CheckPermission` decides
 * one row and `LookupResources` lists the ids `filter` and `where` use. A
 * conditional permissionship (a caveat missing context) is a denial.
 */
export function spicedb(options: SpiceDbOptions): DecisionProvider {
  const consistency =
    options.consistency === 'fully-consistent'
      ? { fullyConsistent: true }
      : { minimizeLatency: true };
  return relationProvider<SpiceDbCheck>(
    compact({
      name: 'spicedb',
      map: options.map,
      auth: { bearer: options.token },
      timeout: options.timeout,
      cache: options.cache,
      fetch: options.fetch,
      async check(check: SpiceDbCheck, post: Post): Promise<CheckResult> {
        if (check.resource.id === undefined) {
          return 'invalid';
        }
        const body = await jsonOf(
          await post(joinUrl(options.url, '/v1/permissions/check'), {
            consistency,
            resource: {
              objectType: check.resource.type,
              objectId: check.resource.id,
            },
            permission: check.permission,
            subject: subjectReference(check),
          }),
        );
        if (body === undefined) {
          return 'unavailable';
        }
        if (!isRecord(body)) {
          return 'invalid';
        }
        switch (body['permissionship']) {
          case 'PERMISSIONSHIP_HAS_PERMISSION':
            return true;
          case 'PERMISSIONSHIP_NO_PERMISSION':
          case 'PERMISSIONSHIP_CONDITIONAL_PERMISSION':
            return false;
          default:
            return 'invalid';
        }
      },
      async list(
        check: SpiceDbCheck,
        post: Post,
      ): Promise<readonly string[] | null> {
        const response = await post(
          joinUrl(options.url, '/v1/permissions/resources'),
          {
            consistency,
            resourceObjectType: check.resource.type,
            permission: check.permission,
            subject: subjectReference(check),
          },
        );
        if (response === null) {
          return null;
        }
        let text: string;
        try {
          text = await response.text();
        } catch {
          return null;
        }
        const ids: string[] = [];
        for (const line of text.split('\n')) {
          if (line.trim() === '') {
            continue;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(line) as unknown;
          } catch {
            return null;
          }
          const result = isRecord(parsed) ? parsed['result'] : undefined;
          if (
            !isRecord(result) ||
            typeof result['resourceObjectId'] !== 'string'
          ) {
            return null;
          }
          if (
            result['permissionship'] === 'LOOKUP_PERMISSIONSHIP_HAS_PERMISSION'
          ) {
            ids.push(result['resourceObjectId']);
          }
        }
        return Object.freeze(ids);
      },
    }),
  );
}
