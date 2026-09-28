import type { TokenSigner } from '../core/interfaces.ts';
import type { Subject } from '../core/subject.ts';
import type { ApprovalRequest, ApprovalStore } from './types.ts';

import { compact } from '../core/compact.ts';
import { isApprovalError } from './errors.ts';
import { assertApprover } from './store.ts';

const PROBLEM_BASE = 'https://permdock.dev/problems';

export type ApprovalsHandlerOptions = {
  readonly subject: (
    request: Request,
  ) => Subject | null | undefined | Promise<Subject | null | undefined>;
  readonly requireDistinctApprover?: boolean;
  readonly signer?: TokenSigner;
  readonly audience?: string | readonly string[];
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
    headers: { 'content-type': 'application/problem+json' },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Route =
  | { readonly kind: 'pending' }
  | { readonly kind: 'mine' }
  | { readonly kind: 'get'; readonly token: string }
  | { readonly kind: 'approve'; readonly token: string }
  | { readonly kind: 'reject'; readonly token: string };

function parseRoute(url: URL, method: string): Route | undefined {
  const parts = url.pathname.replace(/\/+$/u, '').split('/').filter(Boolean);
  const last = parts.at(-1);
  const prev = parts.at(-2);
  if (last === undefined) {
    return undefined;
  }
  if (method === 'GET' && last === 'pending') {
    return { kind: 'pending' };
  }
  if (method === 'GET' && last === 'mine') {
    return { kind: 'mine' };
  }
  if (method === 'POST' && last === 'approve' && prev !== undefined) {
    return { kind: 'approve', token: decodeURIComponent(prev) };
  }
  if (method === 'POST' && last === 'reject' && prev !== undefined) {
    return { kind: 'reject', token: decodeURIComponent(prev) };
  }
  if (method === 'GET' && last !== 'pending' && last !== 'mine') {
    return { kind: 'get', token: decodeURIComponent(last) };
  }
  return undefined;
}

async function resolveSubject(
  request: Request,
  resolve: ApprovalsHandlerOptions['subject'],
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
    if (membership.tenant !== undefined) {
      tenants.add(membership.tenant);
    }
  }
  return [...tenants];
}

function belongsToTenant(subject: Subject, tenant: string): boolean {
  return membershipTenants(subject).includes(tenant);
}

function mayResolve(
  request: ApprovalRequest,
  subject: Subject,
  requireDistinct: boolean,
): boolean {
  try {
    assertApprover(request, subject, requireDistinct);
    return true;
  } catch {
    return false;
  }
}

function canView(request: ApprovalRequest, subject: Subject): boolean {
  const principal = subject.principal;
  if (principal === null) {
    return false;
  }
  if (request.subject.principal?.id === principal.id) {
    return true;
  }
  const tenant = request.subject.principal?.tenant;
  if (tenant !== undefined) {
    return belongsToTenant(subject, tenant);
  }
  return true;
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
  const limit = url.searchParams.get('limit');
  const cursor = url.searchParams.get('cursor');
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
  const requested = url.searchParams.get('tenant');
  if (requested !== null && requested !== '') {
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
  if (signer === undefined || request.status !== 'approved') {
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
    payload.sub = request.subject.principal.id;
  }
  return signer.sign(
    payload,
    compact<Parameters<TokenSigner['sign']>[1]>({
      typ: 'permdock-approval+jwt',
      audience,
      expiresAt: Math.floor(Date.parse(request.expiresAt) / 1000),
    }),
  );
}

async function readNote(request: Request): Promise<string | undefined> {
  const contentType = request.headers.get('content-type') ?? '';
  if (request.method !== 'POST' || contentType === '') {
    return undefined;
  }
  if (!contentType.includes('application/json')) {
    return undefined;
  }
  try {
    const body: unknown = await request.json();
    if (
      body !== null &&
      typeof body === 'object' &&
      'note' in body &&
      typeof (body as { note?: unknown }).note === 'string'
    ) {
      return (body as { note: string }).note;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function mapError(error: unknown): Response {
  if (!isApprovalError(error)) {
    return problem(500, 'Internal error', 'approval store failed', 'internal');
  }
  if (error.code === 'approval-not-found') {
    return problem(404, 'Not found', error.message, 'not-found');
  }
  if (
    error.code === 'approval-not-pending' ||
    error.code === 'approval-expired'
  ) {
    return problem(409, 'Conflict', error.message, 'conflict');
  }
  if (error.code === 'approver-unauthenticated') {
    return problem(401, 'Unauthenticated', error.message, 'unauthenticated');
  }
  return problem(403, 'Permission denied', error.message, 'denied');
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
        'Method not allowed',
        'unknown approvals route',
        'method-not-allowed',
      );
    }

    await store.expire();

    const subject = await resolveSubject(request, options.subject);
    if (subject === null || subject.principal === null) {
      return problem(
        401,
        'Unauthenticated',
        'approver must be authenticated',
        'unauthenticated',
      );
    }

    try {
      if (route.kind === 'pending') {
        const scoped = inboxScope(url, subject);
        if (!scoped.ok) {
          return problem(
            403,
            'Permission denied',
            'approver does not belong to that tenant',
            'denied',
          );
        }
        const page = await store.list({ ...pageQuery(url), status: 'pending' });
        const tenants = new Set(scoped.tenants);
        return json(
          200,
          compact({
            items: page.items.filter((item) => {
              const tenant = item.subject.principal?.tenant;
              const inScope =
                tenant === undefined ? scoped.tenantless : tenants.has(tenant);
              return inScope && mayResolve(item, subject, requireDistinct);
            }),
            next: page.next,
          }),
        );
      }
      if (route.kind === 'mine') {
        const page = await store.list({
          ...pageQuery(url),
          principalId: subject.principal.id,
        });
        return json(200, compact({ items: page.items, next: page.next }));
      }
      if (route.kind === 'get') {
        const current = await store.get(route.token);
        if (current === null || !canView(current, subject)) {
          return problem(
            404,
            'Not found',
            'approval was not found',
            'not-found',
          );
        }
        return json(200, current);
      }
      const current = await store.get(route.token);
      if (current === null) {
        return problem(404, 'Not found', 'approval was not found', 'not-found');
      }
      assertApprover(current, subject, requireDistinct);
      const note = await readNote(request);
      const resolved = await store.resolve(
        route.token,
        compact<{
          readonly status: 'approved' | 'rejected';
          readonly by: Subject;
          readonly note?: string;
        }>({
          status: route.kind === 'approve' ? 'approved' : 'rejected',
          by: subject,
          note,
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
      return mapError(error);
    }
  };
}
