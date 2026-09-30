import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApprovalStore } from '../approvals/index.ts';
import type {
  LimitStore,
  Principal,
  RevocationFeed,
  RoleSource,
  Subject,
} from '../index.ts';
import type { SaasProject } from './saas/permissions.ts';

import {
  APPROVAL_HEADER,
  memoryApprovalStore,
  resolveApproval,
} from '../approvals/index.ts';
import {
  createPermDock,
  memoryLimitStore,
  memoryRevocationFeed,
  memoryRoleSource,
} from '../index.ts';
import { saasPolicy } from './saas/policy.ts';
import {
  saasCustomRoles,
  saasOrg,
  saasPrincipal,
  saasSeed,
} from './saas/seed.ts';
import { signSaasToken, verifySaasSession } from './saas/tokens.ts';

/**
 * What a mount wires into its framework. Every value is server-side: the
 * subject comes from a verified bearer token, memberships and plans from the
 * seed, the tenant from the `:org` path segment.
 */
export type HttpScenarioDomain = {
  readonly policy: typeof saasPolicy;
  /**
   * The verified principal for an `Authorization` header, with the plans of
   * the org in the first segment of `path`. The path, not a route param, so
   * the answer is the same in a global middleware that runs before routing.
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
  readonly customRoles: RoleSource;
  readonly store: ApprovalStore;
  readonly limits: LimitStore;
  /** A project row by id, whatever its org: tenant checks belong to the policy. */
  readonly project: (id: string | undefined) => SaasProject | null;
};

export type HttpOp =
  | { readonly op: 'project.get'; readonly org: string; readonly id: string }
  | { readonly op: 'project.update'; readonly org: string; readonly id: string }
  | {
      readonly op: 'project.create';
      readonly org: string;
      readonly body: unknown;
    }
  | { readonly op: 'project.delete'; readonly org: string; readonly id: string }
  | {
      readonly op: 'project.upload';
      readonly org: string;
      readonly id: string;
      readonly file: { readonly name: string; readonly content: string };
    }
  | { readonly op: 'analytics.read'; readonly org: string }
  | { readonly op: 'apiKey.create'; readonly org: string }
  | { readonly op: 'apiKey.revokeAll'; readonly org: string }
  | { readonly op: 'admin.members'; readonly org: string }
  | {
      readonly op: 'evaluations';
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
   * - `POST /:org/projects`: `protect(project.create, body, { trusted: false })`, 201 with the body
   * - `DELETE /:org/projects/:id`: `protect(project.read, row)`, then the handler
   *   calls `permdock.assert(project.delete, row)`; 204
   * - `POST /:org/projects/:id/files`: `protect(project.update, row)`, then the
   *   framework's own multipart parser reads field `file`; 201 `{ name, size }`
   * - `GET /:org/analytics`: `protect(analytics.read)`, 200
   * - `POST /:org/api-keys`: `protect(apiKey.create)`, 201
   * - `POST /:org/api-keys/revoke-all`: `protect(apiKey.revokeAll)`, 204
   * - `GET /:org/admin/members`: in a sub-app, router or group; `protect(member.list)`, 200
   * - `POST /:org/permdock/access/v1/evaluations`: the adapter's decision endpoint
   *
   * A global `permdock()` middleware runs before every route.
   *
   * With `streams: true` it also serves `GET /:org/projects/:id/events`:
   * `protect(project.read, row)` with the subject from `domain.session`,
   * then a connection opened for `project.read` on the row with
   * `revocations: domain.revocations`, streaming `domain.ticks(org)` as
   * `text/event-stream` `data:` frames of JSON rows, dropping rows the
   * subscriber cannot `project.update`, and ending with an
   * `event: permdock` frame carrying the Problem Details when the connection aborts.
   */
  readonly fetch?: (request: Request) => Promise<Response>;
  /** RPC adapters map a call to a procedure and its error to an HTTP status. */
  readonly call?: (call: HttpCall) => Promise<HttpResult>;
  readonly close?: () => Promise<void> | void;
};

export type HttpScenarioName =
  | 'tenant'
  | 'roles'
  | 'custom-roles'
  | 'plans'
  | 'expired'
  | 'limits'
  | 'validation'
  | 'assert'
  | 'approval'
  | 'stale-approval'
  | 'evaluations'
  | 'upload'
  | 'sub-app'
  | 'parallel'
  | 'stream-revoked'
  | 'stream-demoted'
  | 'stream-filter'
  | 'stream-expired';

export type HttpAdapterOptions = {
  readonly name: string;
  readonly mount: (
    domain: HttpScenarioDomain,
  ) => HttpMounted | Promise<HttpMounted>;
  /** Scenarios the transport cannot express (multipart over RPC), each with a reason. */
  readonly skip?: Readonly<Partial<Record<HttpScenarioName, string>>>;
  /** The mount serves the events stream; the `stream-*` scenarios run only then. */
  readonly streams?: boolean;
};

function project(id: string): SaasProject {
  const row = saasSeed.projects.find((candidate) => candidate.id === id);
  if (row === undefined) {
    throw new Error(`no seed project ${id}`);
  }
  return row;
}

function bearerToken(authorization: string | null | undefined): string | null {
  if (typeof authorization !== 'string') {
    return null;
  }
  const match = /^Bearer (\S+)$/u.exec(authorization);
  return match?.[1] ?? null;
}

function orgOf(path: string): string | undefined {
  const [segment] = path.replace(/^\/+/u, '').split('/');
  return segment === undefined || segment.length === 0
    ? undefined
    : saasOrg(segment)?.id;
}

async function pause(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
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

type Demotions = {
  readonly demote: (user: string, org: string) => () => void;
};

function createDomain(): HttpScenarioDomain & Demotions {
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
    customRoles: memoryRoleSource(saasCustomRoles),
    store: memoryApprovalStore(),
    limits: memoryLimitStore(),
    project: (id) =>
      id === undefined
        ? null
        : (saasSeed.projects.find((row) => row.id === id) ?? null),
  };
}

function restRequest(base: string, call: HttpCall): Request {
  const headers = new Headers();
  if (call.authorization !== null) {
    headers.set('authorization', call.authorization);
  }
  if (call.approval !== undefined) {
    headers.set(APPROVAL_HEADER, call.approval);
  }
  const json = (method: string, path: string, body: unknown): Request => {
    headers.set('content-type', 'application/json');
    return new Request(`${base}${path}`, {
      method,
      headers,
      body: JSON.stringify(body),
    });
  };
  const plain = (method: string, path: string): Request =>
    new Request(`${base}${path}`, { method, headers });
  switch (call.op) {
    case 'project.get':
      return plain('GET', `/${call.org}/projects/${call.id}`);
    case 'project.update':
      return json('PATCH', `/${call.org}/projects/${call.id}`, {
        name: 'Renamed',
      });
    case 'project.create':
      return json('POST', `/${call.org}/projects`, call.body);
    case 'project.delete':
      return plain('DELETE', `/${call.org}/projects/${call.id}`);
    case 'project.upload': {
      const form = new FormData();
      form.set('file', new Blob([call.file.content]), call.file.name);
      return new Request(`${base}/${call.org}/projects/${call.id}/files`, {
        method: 'POST',
        headers,
        body: form,
      });
    }
    case 'analytics.read':
      return plain('GET', `/${call.org}/analytics`);
    case 'apiKey.create':
      return plain('POST', `/${call.org}/api-keys`);
    case 'apiKey.revokeAll':
      return plain('POST', `/${call.org}/api-keys/revoke-all`);
    case 'admin.members':
      return plain('GET', `/${call.org}/admin/members`);
    case 'evaluations':
      return json(
        'POST',
        `/${call.org}/permdock/access/v1/evaluations`,
        call.body,
      );
    default: {
      const exhaustive: never = call;
      return exhaustive;
    }
  }
}

async function readResult(response: Response): Promise<HttpResult> {
  const text = await response.text();
  if (text.length === 0) {
    return { status: response.status, body: null };
  }
  try {
    return { status: response.status, body: JSON.parse(text) as unknown };
  } catch {
    return { status: response.status, body: text };
  }
}

function field(body: unknown, key: string): unknown {
  return body !== null && typeof body === 'object'
    ? (body as Record<string, unknown>)[key]
    : undefined;
}

function reasonsOf(body: unknown): readonly unknown[] {
  const denials = field(body, 'denials');
  return Array.isArray(denials)
    ? denials.map((denial: unknown) => field(denial, 'reason'))
    : [];
}

async function approverSubject(user: string, tenant: string): Promise<Subject> {
  const dock = await createPermDock(saasPolicy, saasPrincipal(user, tenant), {
    tenant,
  });
  return dock.subject;
}

const PARALLEL: readonly {
  readonly user: string | null;
  readonly org: string;
  readonly id: string;
  readonly status: number;
}[] = [
  { user: 'alice', org: 'acme', id: 'p1', status: 200 },
  { user: 'alice', org: 'globex', id: 'g1', status: 200 },
  { user: 'alice', org: 'acme', id: 'g1', status: 403 },
  { user: 'bob', org: 'acme', id: 'p1', status: 200 },
  { user: 'bob', org: 'globex', id: 'g1', status: 403 },
  { user: 'hank', org: 'acme', id: 'p3', status: 200 },
  { user: 'mallory', org: 'acme', id: 'p1', status: 403 },
  { user: null, org: 'acme', id: 'p1', status: 401 },
  { user: 'erin', org: 'globex', id: 'g1', status: 200 },
  { user: 'frank', org: 'acme', id: 'p1', status: 403 },
];

type Frame = { readonly event: string; readonly data: string };

type EventStream = {
  readonly status: number;
  /** The next frame, or `undefined` once the server ended the stream. */
  readonly next: () => Promise<Frame | undefined>;
  readonly cancel: () => Promise<void>;
};

const STREAM_WAIT_MS = 4000;

async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out waiting for ${what}`));
    }, STREAM_WAIT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function parseFrame(raw: string): Frame | undefined {
  let event = 'message';
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      data.push(line.slice('data:'.length).trimStart());
    }
  }
  return data.length === 0 ? undefined : { event, data: data.join('\n') };
}

function eventStream(response: Response): EventStream {
  const reader = response.body
    ?.pipeThrough(new TextDecoderStream())
    .getReader();
  let buffer = '';
  const next = async (): Promise<Frame | undefined> => {
    if (reader === undefined) {
      return undefined;
    }
    for (;;) {
      const end = /\r?\n\r?\n/u.exec(buffer);
      if (end !== null) {
        const frame = parseFrame(buffer.slice(0, end.index));
        buffer = buffer.slice(end.index + end[0].length);
        if (frame !== undefined) {
          return frame;
        }
        continue;
      }
      const chunk = await within(reader.read(), 'an SSE frame');
      if (chunk.done) {
        return undefined;
      }
      buffer += chunk.value;
    }
  };
  return {
    status: response.status,
    next,
    cancel: async () => {
      await reader?.cancel().catch(() => undefined);
    },
  };
}

/** Reads frames until the `permdock` frame and the end of the stream. */
async function untilEnd(
  stream: EventStream,
): Promise<{ readonly problem: unknown; readonly ended: boolean }> {
  for (;;) {
    const frame = await stream.next();
    if (frame === undefined) {
      return { problem: undefined, ended: true };
    }
    if (frame.event === 'permdock') {
      const problem = JSON.parse(frame.data) as unknown;
      return { problem, ended: (await stream.next()) === undefined };
    }
  }
}

/**
 * Real-life HTTP scenarios over the shared SaaS domain. `mount` builds the
 * application once with the adapter under test; every expectation below is
 * written by hand, never computed with PermDock.
 */
export function testHttpAdapter(options: HttpAdapterOptions): void {
  const scenario = (
    name: HttpScenarioName,
    title: string,
    run: () => Promise<void>,
    timeout?: number,
  ): void => {
    const reason =
      options.skip?.[name] ??
      (name.startsWith('stream-') && options.streams !== true
        ? 'no events stream'
        : undefined);
    it.skipIf(reason !== undefined)(
      reason === undefined ? title : `${title} (${reason})`,
      run,
      timeout,
    );
  };

  describe(`${options.name}: real-life HTTP scenarios`, () => {
    const domain = createDomain();
    const tokens = new Map<string, string>();
    let mounted: HttpMounted;

    beforeAll(async () => {
      mounted = await options.mount(domain);
      for (const user of [
        'alice',
        'bob',
        'carol',
        'dave',
        'erin',
        'frank',
        'hank',
        'mallory',
      ]) {
        tokens.set(
          user,
          `Bearer ${await signSaasToken(user, { memberships: false })}`,
        );
      }
    });

    afterAll(async () => {
      await mounted.close?.();
    });

    const send = async (
      user: string | null,
      op: HttpOp,
      approval?: string,
    ): Promise<HttpResult> => {
      const call: HttpCall = {
        ...op,
        authorization: user === null ? null : (tokens.get(user) ?? null),
        ...(approval === undefined ? {} : { approval }),
      };
      if (mounted.call !== undefined) {
        return mounted.call(call);
      }
      if (mounted.fetch === undefined) {
        throw new Error(
          `${options.name}: mount returned neither fetch nor call`,
        );
      }
      return readResult(
        await mounted.fetch(restRequest('http://app.test', call)),
      );
    };

    const openStream = async (
      authorization: string | null,
      org: string,
      id: string,
    ): Promise<EventStream> => {
      if (mounted.fetch === undefined) {
        throw new Error(`${options.name}: streams need a fetch mount`);
      }
      const headers = new Headers({ accept: 'text/event-stream' });
      if (authorization !== null) {
        headers.set('authorization', authorization);
      }
      return eventStream(
        await mounted.fetch(
          new Request(`http://app.test/${org}/projects/${id}/events`, {
            headers,
          }),
        ),
      );
    };

    scenario(
      'tenant',
      'resolves the tenant from the path on every protect',
      async () => {
        expect(
          (await send('alice', { op: 'project.get', org: 'acme', id: 'p2' }))
            .status,
        ).toBe(200);
        expect(
          (await send('alice', { op: 'project.get', org: 'globex', id: 'g1' }))
            .status,
        ).toBe(200);
        expect(
          (await send('alice', { op: 'project.get', org: 'acme', id: 'g1' }))
            .status,
        ).toBe(403);
        expect(
          (await send('mallory', { op: 'project.get', org: 'acme', id: 'p1' }))
            .status,
        ).toBe(403);
        expect(
          (await send(null, { op: 'project.get', org: 'acme', id: 'p1' }))
            .status,
        ).toBe(401);
      },
    );

    scenario(
      'roles',
      'applies the role held in the requested org',
      async () => {
        expect(
          (await send('alice', { op: 'project.update', org: 'acme', id: 'p1' }))
            .status,
        ).toBe(200);
        expect(
          (
            await send('alice', {
              op: 'project.update',
              org: 'globex',
              id: 'g1',
            })
          ).status,
        ).toBe(403);
        expect(
          (await send('bob', { op: 'project.update', org: 'acme', id: 'p1' }))
            .status,
        ).toBe(200);
        expect(
          (await send('bob', { op: 'project.update', org: 'acme', id: 'p2' }))
            .status,
        ).toBe(403);
      },
    );

    scenario('custom-roles', 'grants through an org custom role', async () => {
      const body = {
        id: 'c1',
        orgId: 'acme',
        ownerId: 'dave',
        name: 'Contract',
        archived: false,
      };
      expect(
        (await send('dave', { op: 'project.create', org: 'acme', body }))
          .status,
      ).toBe(201);
      expect(
        (await send('hank', { op: 'project.create', org: 'acme', body }))
          .status,
      ).toBe(403);
    });

    scenario(
      'plans',
      'gates a feature on the plan of the requested org',
      async () => {
        expect(
          (await send('erin', { op: 'analytics.read', org: 'globex' })).status,
        ).toBe(200);
        expect(
          (await send('erin', { op: 'analytics.read', org: 'acme' })).status,
        ).toBe(403);
      },
    );

    scenario('expired', 'ignores an expired membership', async () => {
      expect(
        (await send('frank', { op: 'project.get', org: 'acme', id: 'p1' }))
          .status,
      ).toBe(403);
    });

    scenario('limits', 'counts a quota per subject and tenant', async () => {
      for (let index = 0; index < 5; index += 1) {
        expect(
          (await send('erin', { op: 'apiKey.create', org: 'acme' })).status,
        ).toBe(201);
      }
      const exhausted = await send('erin', {
        op: 'apiKey.create',
        org: 'acme',
      });
      expect(exhausted.status).toBe(429);
      expect(reasonsOf(exhausted.body)).toContain('limit');
      expect(
        (await send('erin', { op: 'apiKey.create', org: 'globex' })).status,
      ).toBe(201);
    });

    scenario(
      'validation',
      'validates an untrusted body before the check',
      async () => {
        const valid = {
          id: 'n2',
          orgId: 'acme',
          ownerId: 'bob',
          name: 'New',
          archived: false,
        };
        expect(
          (
            await send('bob', {
              op: 'project.create',
              org: 'acme',
              body: valid,
            })
          ).status,
        ).toBe(201);
        const invalid = await send('bob', {
          op: 'project.create',
          org: 'acme',
          body: { ...valid, name: 42 },
        });
        expect(invalid.status).toBe(400);
        expect(
          (
            await send('bob', {
              op: 'project.create',
              org: 'acme',
              body: { ...valid, orgId: 'globex' },
            })
          ).status,
        ).toBe(403);
      },
    );

    scenario(
      'assert',
      'maps assert inside a handler to a 403 Problem',
      async () => {
        const denied = await send('bob', {
          op: 'project.delete',
          org: 'acme',
          id: 'p2',
        });
        expect(denied.status).toBe(403);
        expect(field(denied.body, 'type')).toBe(
          'https://permdock.dev/problems/denied',
        );
        expect(
          (await send('bob', { op: 'project.delete', org: 'acme', id: 'p3' }))
            .status,
        ).toBe(204);
        expect(
          (await send('bob', { op: 'project.delete', org: 'acme', id: 'p4' }))
            .status,
        ).toBe(403);
      },
    );

    scenario(
      'approval',
      'asks for approval, resumes once and refuses a replay',
      async () => {
        const asked = await send('alice', {
          op: 'apiKey.revokeAll',
          org: 'acme',
        });
        expect(asked.status).toBe(403);
        expect(field(asked.body, 'type')).toBe(
          'https://permdock.dev/problems/approval-required',
        );
        const token = field(asked.body, 'token');
        expect(typeof token).toBe('string');
        await resolveApproval(domain.store, String(token), {
          status: 'approved',
          by: await approverSubject('carol', 'acme'),
        });
        expect(
          (
            await send(
              'alice',
              { op: 'apiKey.revokeAll', org: 'acme' },
              String(token),
            )
          ).status,
        ).toBe(204);
        expect(
          (
            await send(
              'alice',
              { op: 'apiKey.revokeAll', org: 'acme' },
              String(token),
            )
          ).status,
        ).toBe(403);
        expect(
          (await send('carol', { op: 'apiKey.revokeAll', org: 'acme' })).status,
        ).toBe(204);
      },
    );

    scenario(
      'stale-approval',
      'ignores an approval header meant for another request',
      async () => {
        expect(
          (
            await send(
              'bob',
              { op: 'project.get', org: 'acme', id: 'p1' },
              'pd1.not-a-real-token',
            )
          ).status,
        ).toBe(200);
      },
    );

    scenario(
      'evaluations',
      'answers the decision endpoint in the path tenant',
      async () => {
        const result = await send('bob', {
          op: 'evaluations',
          org: 'acme',
          body: {
            evaluations: [
              {
                action: { name: 'project.update' },
                resource: {
                  type: 'project',
                  id: 'p1',
                  properties: project('p1'),
                },
              },
              {
                action: { name: 'project.update' },
                resource: {
                  type: 'project',
                  id: 'p2',
                  properties: project('p2'),
                },
              },
            ],
          },
        });
        expect(result.status).toBe(200);
        const rows = field(result.body, 'evaluations');
        expect(
          Array.isArray(rows)
            ? rows.map((row: unknown) => field(row, 'decision'))
            : rows,
        ).toEqual([true, false]);
      },
    );

    scenario(
      'upload',
      'leaves a multipart body to the framework parser',
      async () => {
        const file = { name: 'notes.txt', content: 'hello' };
        const uploaded = await send('bob', {
          op: 'project.upload',
          org: 'acme',
          id: 'p1',
          file,
        });
        expect(uploaded.status).toBe(201);
        expect(uploaded.body).toEqual({ name: 'notes.txt', size: 5 });
        expect(
          (
            await send('bob', {
              op: 'project.upload',
              org: 'acme',
              id: 'p2',
              file,
            })
          ).status,
        ).toBe(403);
      },
    );

    scenario('sub-app', 'protects a route inside a sub-app', async () => {
      expect(
        (await send('alice', { op: 'admin.members', org: 'acme' })).status,
      ).toBe(200);
      expect(
        (await send('bob', { op: 'admin.members', org: 'acme' })).status,
      ).toBe(403);
    });

    scenario(
      'parallel',
      'keeps 50 parallel requests with mixed subjects apart',
      async () => {
        const calls = Array.from({ length: 50 }, (_, index) => {
          const entry = PARALLEL[(index * 7) % PARALLEL.length];
          if (entry === undefined) {
            throw new Error('parallel table is empty');
          }
          return entry;
        });
        const statuses = await Promise.all(
          calls.map(
            async (entry) =>
              (
                await send(entry.user, {
                  op: 'project.get',
                  org: entry.org,
                  id: entry.id,
                })
              ).status,
          ),
        );
        expect(statuses).toEqual(calls.map((entry) => entry.status));
      },
    );

    scenario(
      'stream-revoked',
      'closes an open stream when the session is revoked',
      async () => {
        expect((await openStream(null, 'acme', 'p1')).status).toBe(401);
        const stream = await openStream(
          tokens.get('bob') ?? null,
          'acme',
          'p1',
        );
        try {
          expect(stream.status).toBe(200);
          expect((await stream.next())?.event).toBe('message');
          await domain.revocations.revoke({
            principal: 'bob',
            kind: 'session-revoked',
          });
          const end = await untilEnd(stream);
          expect(end.problem).toMatchObject({
            type: 'https://permdock.dev/problems/unauthenticated',
            status: 401,
            detail: 'session-revoked',
          });
          expect(end.ended).toBe(true);
        } finally {
          await stream.cancel();
        }
      },
    );

    scenario(
      'stream-demoted',
      'closes an open stream when a membership change re-denies it',
      async () => {
        const stream = await openStream(
          tokens.get('bob') ?? null,
          'acme',
          'p1',
        );
        const restore = domain.demote('bob', 'acme');
        try {
          expect(stream.status).toBe(200);
          expect((await stream.next())?.event).toBe('message');
          await domain.revocations.revoke({
            principal: 'bob',
            tenant: 'acme',
            kind: 'changed',
          });
          const end = await untilEnd(stream);
          expect(end.problem).toMatchObject({
            type: 'https://permdock.dev/problems/denied',
            status: 403,
          });
          expect(end.ended).toBe(true);
        } finally {
          restore();
          await stream.cancel();
        }
      },
    );

    scenario(
      'stream-filter',
      'drops the items a subscriber cannot read and keeps the stream open',
      async () => {
        const stream = await openStream(
          tokens.get('bob') ?? null,
          'acme',
          'p1',
        );
        try {
          expect(stream.status).toBe(200);
          const ids: string[] = [];
          while (ids.length < 7) {
            const frame = await stream.next();
            expect(frame?.event).toBe('message');
            ids.push(String(field(JSON.parse(frame?.data ?? '{}'), 'id')));
          }
          expect(new Set(ids)).toEqual(new Set(['p1', 'p3', 'p4']));
        } finally {
          await stream.cancel();
        }
      },
    );

    scenario(
      'stream-expired',
      'closes an open stream when the token expires',
      async () => {
        const stream = await openStream(
          `Bearer ${await signSaasToken('bob', { memberships: false, ttl: 2 })}`,
          'acme',
          'p1',
        );
        try {
          expect(stream.status).toBe(200);
          expect((await stream.next())?.event).toBe('message');
          const end = await untilEnd(stream);
          expect(end.problem).toMatchObject({
            type: 'https://permdock.dev/problems/unauthenticated',
            detail: 'expired',
          });
          expect(end.ended).toBe(true);
        } finally {
          await stream.cancel();
        }
      },
      10_000,
    );
  });
}
