import type { Membership } from '../core/subject.ts';
import type { BetterAuthStatements } from './types.ts';

import { compact } from '../core/compact.ts';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function asRoles(value: unknown): readonly string[] {
  if (typeof value === 'string') {
    return value === ''
      ? []
      : value
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item !== '');
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

export function asStatements(value: unknown): BetterAuthStatements {
  if (!isRecord(value)) {
    return {};
  }
  const out: Record<string, readonly string[]> = {};
  for (const [resource, actions] of Object.entries(value)) {
    if (!Array.isArray(actions)) {
      continue;
    }
    out[resource] = actions.filter(
      (action): action is string => typeof action === 'string',
    );
  }
  return out;
}

export function expiresAtSeconds(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000
      ? Math.floor(value / 1000)
      : Math.floor(value);
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
  }
  return undefined;
}

function unwrapList(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isRecord(value)) {
    return [];
  }
  for (const key of [
    'members',
    'teams',
    'organizations',
    'roles',
    'data',
    'items',
  ]) {
    const inner = value[key];
    if (Array.isArray(inner)) {
      return inner;
    }
  }
  return [];
}

export function parseMemberRows(value: unknown): readonly Membership[] {
  const out: Membership[] = [];
  for (const item of unwrapList(value)) {
    if (!isRecord(item)) {
      continue;
    }
    const tenant =
      typeof item.organizationId === 'string'
        ? item.organizationId
        : typeof item.id === 'string'
          ? item.id
          : undefined;
    const roles = asRoles(item.role ?? item.roles);
    if (tenant === undefined || roles.length === 0) {
      continue;
    }
    out.push(compact<Membership>({ tenant, roles }));
  }
  return out;
}

export function parseTeamRows(value: unknown): readonly Membership[] {
  const out: Membership[] = [];
  for (const item of unwrapList(value)) {
    if (!isRecord(item)) {
      continue;
    }
    const teamRecord = isRecord(item.team) ? item.team : undefined;
    const team =
      typeof item.teamId === 'string'
        ? item.teamId
        : typeof teamRecord?.id === 'string'
          ? teamRecord.id
          : undefined;
    const tenant =
      typeof item.organizationId === 'string'
        ? item.organizationId
        : typeof teamRecord?.organizationId === 'string'
          ? teamRecord.organizationId
          : undefined;
    const roles = asRoles(item.role ?? item.roles);
    if (team === undefined || roles.length === 0) {
      continue;
    }
    out.push(
      compact<Membership>({
        tenant,
        team,
        roles,
        via: `team:${team}`,
      }),
    );
  }
  return out;
}

export type DynamicOrgRole = {
  readonly name: string;
  readonly statements: BetterAuthStatements;
};

export function parseOrganizationRoles(
  value: unknown,
): readonly DynamicOrgRole[] {
  const out: DynamicOrgRole[] = [];
  for (const item of unwrapList(value)) {
    if (!isRecord(item)) {
      continue;
    }
    const name =
      typeof item.role === 'string'
        ? item.role
        : typeof item.name === 'string'
          ? item.name
          : undefined;
    if (name === undefined || name === '') {
      continue;
    }
    out.push({
      name,
      statements: asStatements(
        item.permission ?? item.permissions ?? item.statements,
      ),
    });
  }
  return out;
}

export function statementsCover(
  candidate: BetterAuthStatements,
  required: BetterAuthStatements,
): boolean {
  for (const [resource, actions] of Object.entries(required)) {
    const held = candidate[resource];
    if (held === undefined) {
      return false;
    }
    const set = new Set(held);
    for (const action of actions) {
      if (!set.has(action)) {
        return false;
      }
    }
  }
  return true;
}
