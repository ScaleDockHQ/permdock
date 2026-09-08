import type {
  ApprovalInspectResult,
  ApprovalStore,
} from '../approvals/types.ts';
import type { Decision } from '../core/decision.ts';
import type { PermDock } from '../core/permdock.ts';
import type { Permission, PermissionTree } from '../core/permissions.ts';
import type { Policy } from '../core/policy.ts';

import {
  readApprovalHeader,
  requestApproval,
  resumeFromHeader,
} from '../approvals/helpers.ts';
import { compact } from '../core/compact.ts';
import { findPermission, listPermissions } from '../core/permissions.ts';
import { validationProblem } from './problem.ts';

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
      ? (data as { readonly id?: unknown }).id
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
    readonly permdock: Decision;
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
        context: { outcome: 'denied', permdock: decision },
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

function approvalDenied(detail: string): Decision {
  return {
    outcome: 'denied',
    denials: [{ role: null, reason: 'approval', detail }],
    alternatives: [],
  };
}

function resumeMatches(
  inspected: Extract<ApprovalInspectResult, { readonly ok: true }>,
  permission: Permission,
  ref: { readonly type: string; readonly id?: string },
  decision: Extract<Decision, { readonly outcome: 'approval-required' }>,
): boolean {
  if (inspected.request.token !== decision.token) {
    return false;
  }
  if (inspected.request.permission !== permission.key) {
    return false;
  }
  if (
    inspected.request.resource.id !== undefined &&
    inspected.request.resource.id !== ref.id
  ) {
    return false;
  }
  return true;
}

async function applyResume(
  decision: Decision,
  permission: Permission,
  item: EvaluationItem,
  data: unknown,
  dock: PermDock,
  store: ApprovalStore | undefined,
  inspected: ApprovalInspectResult | undefined,
  header: string | undefined,
): Promise<Decision> {
  if (header === undefined) {
    if (decision.outcome === 'approval-required' && store !== undefined) {
      await requestApproval(
        store,
        decision,
        compact({
          permission,
          resource: resourceRef(permission, item, data),
          subject: dock.subject,
          adapter: 'next',
        }),
      );
    }
    return decision;
  }
  if (store === undefined || inspected === undefined || !inspected.ok) {
    return approvalDenied(
      inspected !== undefined && !inspected.ok
        ? inspected.detail
        : 'approval-not-found',
    );
  }
  if (decision.outcome === 'granted') {
    return decision;
  }
  if (decision.outcome === 'denied') {
    return decision;
  }
  const ref = resourceRef(permission, item, data);
  if (!resumeMatches(inspected, permission, ref, decision)) {
    return approvalDenied('approval-mismatch');
  }
  const principal = dock.subject.principal;
  if (principal === null) {
    return approvalDenied('approval-mismatch');
  }
  return {
    outcome: 'granted',
    subject: { ...dock.subject, principal },
    matched: decision.grant,
    token: decision.token,
  };
}

function evaluateOne(
  policy: Policy,
  dock: PermDock,
  item: EvaluationItem,
  store: ApprovalStore | undefined,
  inspected: ApprovalInspectResult | undefined,
  header: string | undefined,
): Promise<Decision> {
  const permission = permissionOf(policy.permissions, item);
  if (permission === undefined) {
    return Promise.resolve(DENIED);
  }
  const data = resourceData(item);
  const decide = dock.decide as (
    next: Permission,
    row?: unknown,
    options?: { readonly source: 'endpoint'; readonly adapter: string },
  ) => Decision;
  const decision = decide(
    permission,
    data,
    compact({ source: 'endpoint' as const, adapter: 'next' }),
  );
  return applyResume(
    decision,
    permission,
    item,
    data,
    dock,
    store,
    inspected,
    header,
  );
}

export function createHandler(options: {
  readonly policy: Policy;
  readonly getPermDock: (query?: {
    readonly tenant?: string;
  }) => Promise<PermDock>;
  readonly store?: ApprovalStore;
}): {
  readonly POST: (request: Request) => Promise<Response>;
  readonly GET: (request: Request) => Promise<Response>;
} {
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
    const evaluations = (body as { readonly evaluations?: unknown })
      .evaluations;
    if (evaluations === undefined) {
      return validationProblem('evaluations array is required');
    }
    if (!Array.isArray(evaluations)) {
      return validationProblem('evaluations must be an array');
    }

    const header = readApprovalHeader(request.headers);
    const inspected =
      header === undefined || options.store === undefined
        ? undefined
        : await resumeFromHeader(options.store, request.headers);
    const dock = await options.getPermDock();
    const rows = await Promise.all(
      evaluations.map(async (item) => {
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
            inspected,
            header,
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
    const dock = await options.getPermDock(
      tenant === undefined ? undefined : { tenant },
    );
    const snapshot = dock.snapshot();
    return Response.json(await Promise.resolve(snapshot));
  };

  return { POST, GET };
}
