import type {
  ApprovalCancelMeta,
  ApprovalListFilter,
  ApprovalListQuery,
  ApprovalPage,
  ApprovalRequest,
  ApprovalStore,
  ApprovalVerdict,
} from '../approvals/types.ts';
import type { PolicyDocument, PolicySource } from '../core/hosted.ts';
import type {
  DecisionSink,
  SinkEvent,
  SnapshotSource,
} from '../core/interfaces.ts';
import type {
  CloudClient,
  CloudEndpointOptions,
  CloudEndpoints,
  CloudOptions,
} from './types.ts';

import { ApprovalError } from '../approvals/errors.ts';
import { compact } from '../core/compact.ts';
import { freezeDeep } from '../core/freeze.ts';
import { parsePolicyDocument } from '../core/hosted.ts';

function readEnv(name: string): string {
  const runtime = globalThis as {
    readonly process?: { readonly env?: Record<string, string | undefined> };
  };
  const value = runtime.process?.env?.[name];
  return typeof value === 'string' ? value : '';
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string {
  for (const value of values) {
    if (value !== undefined && value !== '') {
      return value;
    }
  }
  return '';
}

function trimSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asApproval(value: unknown): ApprovalRequest | null {
  if (!isRecord(value) || value.v !== 1 || typeof value.token !== 'string') {
    return null;
  }
  return value as ApprovalRequest;
}

function isCompactJws(value: string): boolean {
  return !value.startsWith('{') && value.split('.').length === 3;
}

function approvalErrorFromStatus(status: number): ApprovalError {
  if (status === 409) {
    return new ApprovalError('approval-not-pending', 'approval is not pending');
  }
  if (status === 410) {
    return new ApprovalError('approval-expired', 'approval has expired');
  }
  return new ApprovalError('approval-not-found', 'approval was not found');
}

/**
 * The environment URL and JWK Set URL `cloud()` uses, resolved with the same
 * fallbacks (`PERMDOCK_CLOUD_URL`; `PERMDOCK_CLOUD_ENV`, `VERCEL_ENV`, `production`).
 */
export function cloudEndpoints(
  options: CloudEndpointOptions = {},
): CloudEndpoints {
  const url = trimSlash(
    firstNonEmpty(options.url, readEnv('PERMDOCK_CLOUD_URL')),
  );
  if (url === '') {
    throw new Error('PermDock: cloud() requires url and key.');
  }
  const environment = firstNonEmpty(
    options.environment,
    readEnv('PERMDOCK_CLOUD_ENV'),
    readEnv('VERCEL_ENV'),
    'production',
  );
  const issuer = `${url}/v1/environments/${encodeURIComponent(environment)}`;
  return Object.freeze({ issuer, jwks: `${issuer}/.well-known/jwks.json` });
}

export function cloud(options: CloudOptions = {}): CloudClient {
  const key = firstNonEmpty(options.key, readEnv('PERMDOCK_CLOUD_KEY'));
  if (key === '') {
    throw new Error('PermDock: cloud() requires url and key.');
  }
  const { issuer: root, jwks } = cloudEndpoints(options);
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const flushAt = options.flushAt ?? 32;
  const waitUntil = options.waitUntil;

  const headers = (): Headers => {
    const next = new Headers();
    next.set('authorization', `Bearer ${key}`);
    next.set('content-type', 'application/json');
    return next;
  };

  const request = (
    path: string,
    init: RequestInit = {},
    accept?: string,
  ): Promise<Response> => {
    const next = headers();
    if (accept !== undefined) {
      next.set('accept', accept);
    }
    return fetchFn(`${root}${path}`, { ...init, headers: next });
  };

  const approvals: ApprovalStore = {
    async create(record: ApprovalRequest): Promise<void> {
      const response = await request('/approvals', {
        method: 'POST',
        body: JSON.stringify(record),
      });
      if (!response.ok) {
        throw new Error('PermDock Cloud rejected the approval create');
      }
    },
    async get(token: string): Promise<ApprovalRequest | null> {
      try {
        const response = await request(
          `/approvals/${encodeURIComponent(token)}`,
        );
        if (!response.ok) {
          return null;
        }
        return asApproval(await response.json());
      } catch {
        return null;
      }
    },
    async resolve(
      token: string,
      verdict: ApprovalVerdict,
    ): Promise<ApprovalRequest> {
      const response = await request(
        `/approvals/${encodeURIComponent(token)}/resolve`,
        {
          method: 'POST',
          body: JSON.stringify(verdict),
        },
      );
      if (!response.ok) {
        throw approvalErrorFromStatus(response.status);
      }
      const parsed = asApproval(await response.json());
      if (parsed === null) {
        throw new ApprovalError(
          'approval-not-found',
          'PermDock Cloud returned an unknown approval shape',
        );
      }
      return parsed;
    },
    async consume(token: string, now?: Date): Promise<ApprovalRequest | null> {
      try {
        const response = await request(
          `/approvals/${encodeURIComponent(token)}/consume`,
          {
            method: 'POST',
            body: JSON.stringify(
              compact({
                now: now === undefined ? undefined : now.toISOString(),
              }),
            ),
          },
        );
        if (!response.ok) {
          return null;
        }
        return asApproval(await response.json());
      } catch {
        return null;
      }
    },
    async list(query: ApprovalListQuery): Promise<ApprovalPage> {
      const params = new URLSearchParams(
        compact<Record<string, string>>({
          status: query.status,
          principalId: query.principalId,
          actorId: query.actorId,
          tenant: query.tenant,
          session: query.session,
          limit: query.limit === undefined ? undefined : String(query.limit),
          cursor: query.cursor,
        }),
      );
      const suffix = params.size === 0 ? '' : `?${params.toString()}`;
      try {
        const response = await request(`/approvals${suffix}`);
        if (!response.ok) {
          return { items: [] };
        }
        const body: unknown = await response.json();
        if (!isRecord(body) || !Array.isArray(body.items)) {
          return { items: [] };
        }
        const items = body.items.flatMap((item: unknown) => {
          const parsed = asApproval(item);
          return parsed === null ? [] : [parsed];
        });
        return typeof body.next === 'string' && body.next !== ''
          ? { items, next: body.next }
          : { items };
      } catch {
        return { items: [] };
      }
    },
    async cancel(
      filter: ApprovalListFilter,
      meta: ApprovalCancelMeta,
    ): Promise<number> {
      const response = await request('/approvals/cancel', {
        method: 'POST',
        body: JSON.stringify(compact({ filter, by: meta.by, note: meta.note })),
      });
      if (!response.ok) {
        throw new Error('PermDock Cloud rejected the approval cancel');
      }
      const body: unknown = await response.json();
      if (!isRecord(body) || typeof body.cancelled !== 'number') {
        throw new Error('PermDock Cloud returned an unknown cancel shape');
      }
      return body.cancelled;
    },
    async expire(now?: Date): Promise<number> {
      try {
        const response = await request('/approvals/expire', {
          method: 'POST',
          body: JSON.stringify(
            compact({
              now: now === undefined ? undefined : now.toISOString(),
            }),
          ),
        });
        if (!response.ok) {
          return 0;
        }
        const body: unknown = await response.json();
        if (!isRecord(body) || typeof body.expired !== 'number') {
          return 0;
        }
        return body.expired;
      } catch {
        return 0;
      }
    },
  };

  const capacity = options.capacity ?? 10_000;
  const pending: SinkEvent[] = [];
  const bound = (): void => {
    if (pending.length > capacity) {
      pending.splice(0, pending.length - capacity);
    }
  };

  const flush = async (): Promise<void> => {
    if (pending.length === 0) {
      return;
    }
    const events = pending.splice(0);
    try {
      const response = await request('/decisions', {
        method: 'POST',
        body: JSON.stringify({ events }),
      });
      if (!response.ok) {
        pending.unshift(...events);
      }
    } catch {
      pending.unshift(...events);
    }
    bound();
  };

  const sink: DecisionSink = {
    write(events: readonly SinkEvent[]): Promise<void> | void {
      pending.push(...events);
      bound();
      if (pending.length >= flushAt) {
        return flush();
      }
      if (waitUntil !== undefined && pending.length > 0) {
        waitUntil(flush());
      }
    },
    flush,
  };

  const snapshots: SnapshotSource = {
    async get(): Promise<string> {
      const response = await request('/snapshot', {}, 'application/jwt');
      if (!response.ok) {
        throw new Error('PermDock Cloud snapshot request failed');
      }
      const text = (await response.text()).trim();
      if (!isCompactJws(text)) {
        throw new Error('PermDock Cloud served an unsigned snapshot');
      }
      return text;
    },
  };

  let document: PolicyDocument | null = null;

  const policies: PolicySource = {
    current(): PolicyDocument | null {
      return document;
    },
    async refresh(): Promise<void> {
      const verifier = options.verifier;
      if (verifier === undefined) {
        return;
      }
      let response: Response;
      try {
        response = await request('/policy');
      } catch {
        return;
      }
      if (response.status === 404) {
        document = null;
        return;
      }
      if (!response.ok) {
        return;
      }
      const token = (await response.text()).trim();
      if (!isCompactJws(token)) {
        return;
      }
      const verified = await verifier.verify(token, {
        typ: 'permdock-policy+jwt',
        issuer: root,
        audience: root,
      });
      if (!verified.ok) {
        return;
      }
      let next: PolicyDocument;
      try {
        next = parsePolicyDocument(verified.claims.policy);
      } catch {
        return;
      }
      document = next;
    },
  };

  return freezeDeep({
    approvals,
    sink,
    snapshots,
    policies,
    issuer: root,
    jwks,
  });
}
