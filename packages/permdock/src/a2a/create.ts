import type { Decision } from '../core/decision.ts';
import type { ProblemDetails } from '../core/errors.ts';
import type { PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { Policy } from '../core/policy.ts';
import type { Actor, Delegation } from '../core/subject.ts';
import type {
  A2AAgentCard,
  A2AAuth,
  A2APermDock,
  A2APermDockOptions,
  A2ASkill,
  A2ATaskOutcome,
} from './types.ts';

import { compact } from '../core/compact.ts';
import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
} from '../core/errors.ts';
import { createPermDock as createCorePermDock } from '../core/permdock.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstScheme(options: A2APermDockOptions): string | undefined {
  return Object.keys(options.securitySchemes)[0];
}

function skillOf(
  id: string,
  permission: Permission,
  description: string | undefined,
  scheme: string | undefined,
): A2ASkill {
  return compact<A2ASkill>({
    id,
    name: id,
    description: description ?? permission.key,
    securityRequirements:
      scheme === undefined ? [] : [{ [scheme]: [permission.scope] }],
  });
}

function publicSkills(options: A2APermDockOptions): readonly A2ASkill[] {
  const scheme = firstScheme(options);
  return Object.entries(options.skills).map(([id, config]) =>
    skillOf(id, config.permission, config.description, scheme),
  );
}

function cardOf(
  options: A2APermDockOptions,
  skills: readonly A2ASkill[],
): A2AAgentCard {
  return compact<A2AAgentCard>({
    name: options.card.name,
    description: options.card.description,
    url: options.card.url,
    version: options.card.version,
    protocolVersion: '1.0',
    securitySchemes: options.securitySchemes,
    skills,
  });
}

function delegationOf(auth: A2AAuth): Delegation | undefined {
  return compact<Delegation>({
    scopes: auth.scopes,
    authorizationDetails: auth.extra?.authorizationDetails,
  });
}

function actorOf(auth: A2AAuth): Actor | undefined {
  return typeof auth.clientId === 'string' && auth.clientId !== ''
    ? { id: auth.clientId, kind: 'oauth-client' }
    : undefined;
}

async function resolveTenant(
  tenant: A2APermDockOptions['tenant'],
  auth: A2AAuth,
): Promise<string | undefined> {
  if (tenant === undefined || typeof tenant === 'string') {
    return tenant;
  }
  try {
    return await tenant(auth);
  } catch {
    return undefined;
  }
}

function hasScope(auth: A2AAuth, scope: string): boolean {
  return auth.scopes?.includes(scope) === true;
}

function snapshotAllows(dock: PermDock, permission: Permission): boolean {
  const snapshot = dock.snapshot();
  if (typeof snapshot === 'string' || snapshot instanceof Promise) {
    return false;
  }
  return snapshot.grants.some(
    (grant) => grant.permission === permission.key && grant.effect === 'allow',
  );
}

function skillAllowed(dock: PermDock, permission: Permission): boolean {
  if (permission.kind === 'collection') {
    return (dock.can as (next: Permission) => boolean)(permission);
  }
  return snapshotAllows(dock, permission);
}

function resourceRef(
  permission: Permission,
  data: unknown,
): { readonly type: string; readonly id?: string } {
  if (!isRecord(data)) {
    return { type: permission.resource };
  }
  const id = data.id;
  return typeof id === 'string' || typeof id === 'number'
    ? { type: permission.resource, id: String(id) }
    : { type: permission.resource };
}

function wwwAuthenticate(scope: string, held: readonly string[]): string {
  const scopes = [...new Set([...held, scope])].toSorted().join(' ');
  return `Bearer error="insufficient_scope", scope="${scopes}"`;
}

function deniedOutcome(
  decision: Extract<Decision, { readonly outcome: 'denied' }>,
  permission: Permission,
  data: unknown,
  dock: PermDock,
): A2ATaskOutcome {
  const error = new PermDockDeniedError({
    decision,
    permission: permission.key,
    scope: permission.scope,
    resource: resourceRef(permission, data),
    subject: dock.subject,
    message: `${permission.key} denied.`,
  });
  return {
    ok: false,
    status: 403,
    state: 'failed',
    problem: error.toProblemDetails(),
  };
}

function approvalOutcome(
  decision: Extract<Decision, { readonly outcome: 'approval-required' }>,
  permission: Permission,
  data: unknown,
): A2ATaskOutcome {
  const error = new PermDockApprovalRequiredError({
    decision,
    permission: permission.key,
    scope: permission.scope,
    resource: resourceRef(permission, data),
    message: `${permission.key} requires human approval.`,
  });
  return {
    ok: false,
    status: 403,
    state: 'input-required',
    problem: error.toProblemDetails(),
  };
}

async function signCard(
  card: A2AAgentCard,
  signPayload: (payload: string) => Promise<string>,
): Promise<{ readonly card: A2AAgentCard; readonly signature: string }> {
  return {
    card,
    signature: await signPayload(JSON.stringify(card)),
  };
}

function missingScope(permission: Permission, auth: A2AAuth): A2ATaskOutcome {
  const problem: ProblemDetails = {
    type: 'https://permdock.dev/problems/unauthenticated',
    title: 'Insufficient scope',
    status: 401,
    detail: `insufficient_scope: ${permission.scope}`,
    permission: permission.key,
    scope: permission.scope,
  };
  return {
    ok: false,
    status: 401,
    state: 'failed',
    problem,
    wwwAuthenticate: wwwAuthenticate(permission.scope, auth.scopes ?? []),
  };
}

export function createPermDock(
  policy: Policy,
  options: A2APermDockOptions,
): A2APermDock {
  const instanceFor = async (auth: A2AAuth): Promise<PermDock> => {
    let user: unknown = null;
    try {
      user = await options.subject(auth);
    } catch {
      user = null;
    }
    const tenant = await resolveTenant(options.tenant, auth);
    return createCorePermDock(
      policy,
      user,
      compact({
        tenant,
        actor: actorOf(auth),
        delegation: delegationOf(auth),
        memberships: options.memberships,
        customRoles: options.customRoles,
        sink: options.sink,
      }),
    );
  };

  const agentCard = (): A2AAgentCard => cardOf(options, publicSkills(options));

  const extendedAgentCard = async (auth: A2AAuth): Promise<A2AAgentCard> => {
    const dock = await instanceFor(auth);
    const scheme = firstScheme(options);
    const skills: A2ASkill[] = [];
    for (const [id, config] of Object.entries(options.skills)) {
      if (skillAllowed(dock, config.permission)) {
        skills.push(skillOf(id, config.permission, config.description, scheme));
      }
    }
    return cardOf(options, skills);
  };

  const protectSkill =
    (selector: (task: unknown) => string) =>
    async (task: unknown, auth: A2AAuth): Promise<A2ATaskOutcome> => {
      const id = selector(task);
      const config = options.skills[id];
      if (config === undefined) {
        return {
          ok: false,
          status: 403,
          state: 'failed',
          problem: {
            type: 'https://permdock.dev/problems/denied',
            title: 'Permission denied',
            status: 403,
            detail: 'unknown skill',
          },
        };
      }
      if (!hasScope(auth, config.permission.scope)) {
        return missingScope(config.permission, auth);
      }
      let data: unknown = task;
      if (config.data !== undefined) {
        data = await config.data(task);
      }
      const dock = await instanceFor(auth);
      const decision = (
        dock.decide as (
          next: Permission,
          row?: unknown,
          decideOptions?: {
            readonly source: 'adapter';
            readonly adapter: string;
          },
        ) => Decision
      )(
        config.permission,
        data,
        compact({ source: 'adapter' as const, adapter: 'a2a' }),
      );
      switch (decision.outcome) {
        case 'granted':
          return { ok: true };
        case 'denied':
          return deniedOutcome(decision, config.permission, data, dock);
        case 'approval-required':
          return approvalOutcome(decision, config.permission, data);
        default: {
          const exhaustive: never = decision;
          return exhaustive;
        }
      }
    };

  return { agentCard, extendedAgentCard, protectSkill, sign: signCard };
}
