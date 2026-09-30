import type { ApprovalStore } from '../approvals/types.ts';
import type { Decision } from '../core/decision.ts';
import type { DecideOptions, PermDock } from '../core/permdock.ts';
import type { Permission, PermissionTree } from '../core/permissions.ts';
import type { Policy } from '../core/policy.ts';
import type { WireDecision } from '../core/wire-denial.ts';

import { readApprovalHeader, resumeDecision } from '../approvals/helpers.ts';
import { compact } from '../core/compact.ts';
import { findPermission, listPermissions } from '../core/permissions.ts';
import { wireDenials } from '../core/wire-denial.ts';
import { validationProblem } from './problem.ts';
import { InvalidSignatureError } from './web-bot-auth.ts';

const DENIED: Decision = {
  outcome: 'denied',
  denials: [{ role: null, reason: 'no-grant' }],
  alternatives: [],
};

type EvaluationItem = {
  readonly resource?: {
    readonly type?: unknown;
    readonly id?: unknown;
    readonly properties?: unknown;
  };
  readonly action?: { readonly name?: unknown };
};

function permissionOf(
  tree: PermissionTree,
  item: EvaluationItem,
): Permission | undefined {
  const action =
    typeof item.action?.name === 'string' ? item.action.name : undefined;
  if (action === undefined) {
    return undefined;
  }
  const byKey = findPermission(tree, action);
  if (byKey !== undefined) {
    return byKey;
  }
  const resource =
    typeof item.resource?.type === 'string' ? item.resource.type : undefined;
  if (resource === undefined) {
    return undefined;
  }
  const dotted = findPermission(tree, `${resource}.${action}`);
  if (dotted !== undefined) {
    return dotted;
  }
  return listPermissions(tree).find(
    (leaf) => leaf.resource === resource && leaf.action === action,
  );
}

function resourceData(item: EvaluationItem): unknown {
  const properties = item.resource?.properties;
  if (properties !== null && typeof properties === 'object') {
    return properties;
  }
  const id = item.resource?.id;
  if (typeof id === 'string' || typeof id === 'number') {
    return { id: String(id) };
  }
  return undefined;
}

function resourceRef(
  permission: Permission,
  item: EvaluationItem,
  data: unknown,
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

function evaluationRow(decision: Decision): {
  readonly decision: boolean;
  readonly context: {
    readonly outcome: Decision['outcome'];
    readonly permdock: WireDecision;
  };
} {
  switch (decision.outcome) {
    case 'granted':
      return {
        decision: true,
        context: { outcome: 'granted', permdock: decision },
      };
    case 'denied':
      return {
        decision: false,
        context: {
          outcome: 'denied',
          permdock: { ...decision, denials: wireDenials(decision.denials) },
        },
      };
    case 'approval-required':
      return {
        decision: false,
        context: { outcome: 'approval-required', permdock: decision },
      };
    default: {
      const exhausted: never = decision;
      return exhausted;
    }
  }
}

export function applyApprovalResume(
  decision: Decision,
  permission: Permission,
  dock: PermDock,
  store: ApprovalStore | undefined,
  request: Request,
  resource: { readonly type: string; readonly id?: string },
  adapter: string,
): Promise<Decision> {
  return resumeDecision({
    decision,
    permission,
    subject: dock.subject,
    store,
    resource,
    adapter,
    token: readApprovalHeader(request.headers),
  });
}

function evaluateOne(
  policy: Policy,
  dock: PermDock,
  item: EvaluationItem,
  store: ApprovalStore | undefined,
  header: string | undefined,
  adapter: string,
): Promise<Decision> {
  const permission = permissionOf(policy.permissions, item);
  if (permission === undefined) {
    return Promise.resolve(DENIED);
  }
  const data = resourceData(item);
  // SAFETY: decide's generics only tie the row type to the permission; it accepts any row.
  const decide = dock.decide as (
    next: Permission,
    row?: unknown,
    options?: DecideOptions,
  ) => Decision;
  const decision = decide(
    permission,
    data,
    compact<DecideOptions>({
      source: 'endpoint',
      adapter,
      trusted: false,
      boundary: 'decision-endpoint',
    }),
  );
  return resumeDecision({
    decision,
    permission,
    subject: dock.subject,
    store,
    resource: resourceRef(permission, item, data),
    adapter,
    token: header,
    consume: false,
  });
}

async function resolveDock(
  options: {
    readonly resolve?: (request: Request) => Promise<PermDock>;
    readonly getPermDock?: (query?: {
      readonly tenant?: string;
    }) => Promise<PermDock>;
  },
  request: Request,
  tenant?: string,
): Promise<PermDock> {
  if (options.resolve !== undefined) {
    const dock = await options.resolve(request);
    return tenant === undefined ? dock : dock.tenant(tenant);
  }
  if (options.getPermDock !== undefined) {
    return options.getPermDock(tenant === undefined ? undefined : { tenant });
  }
  throw new TypeError('evaluations handler needs resolve or getPermDock');
}

export function createEvaluationsHandler(options: {
  readonly policy: Policy;
  readonly resolve?: (request: Request) => Promise<PermDock>;
  readonly getPermDock?: (query?: {
    readonly tenant?: string;
  }) => Promise<PermDock>;
  readonly store?: ApprovalStore;
  readonly adapter?: string;
}): {
  readonly POST: (request: Request) => Promise<Response>;
  readonly GET: (request: Request) => Promise<Response>;
} {
  const adapter = options.adapter ?? 'server';
  const POST = async (request: Request): Promise<Response> => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return validationProblem('evaluations body was not valid JSON');
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return validationProblem('evaluations body must be an object');
    }
    // SAFETY: body was checked to be a non-array object above; evaluations stays unknown.
    const evaluations = (body as { readonly evaluations?: unknown })
      .evaluations;
    if (evaluations === undefined) {
      return validationProblem('evaluations array is required');
    }
    if (!Array.isArray(evaluations)) {
      return validationProblem('evaluations must be an array');
    }

    const header = readApprovalHeader(request.headers);
    let dock: PermDock;
    try {
      dock = await resolveDock(options, request);
    } catch (error) {
      if (error instanceof InvalidSignatureError) {
        return error.response;
      }
      throw error;
    }
    const rows = await Promise.all(
      evaluations.map(async (item) => {
        // SAFETY: every EvaluationItem field is optional and read through ?. and typeof checks.
        const entry =
          item !== null && typeof item === 'object'
            ? (item as EvaluationItem)
            : {};
        return evaluationRow(
          await evaluateOne(
            options.policy,
            dock,
            entry,
            options.store,
            header,
            adapter,
          ),
        );
      }),
    );
    return Response.json({ evaluations: rows });
  };

  const GET = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname.includes('authzen-configuration')) {
      const origin = url.origin;
      return Response.json({
        policy_decision_point: origin,
        access_evaluation_endpoint: `${origin}/access/v1/evaluation`,
        access_evaluations_endpoint: `${origin}/access/v1/evaluations`,
      });
    }
    const tenant = url.searchParams.get('tenant') ?? undefined;
    let dock: PermDock;
    try {
      dock = await resolveDock(options, request, tenant);
    } catch (error) {
      if (error instanceof InvalidSignatureError) {
        return error.response;
      }
      throw error;
    }
    const snapshot = dock.snapshot();
    return Response.json(await Promise.resolve(snapshot));
  };

  return { POST, GET };
}
