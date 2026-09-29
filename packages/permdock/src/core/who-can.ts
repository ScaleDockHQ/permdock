import type { RelatedCondition } from '../conditions/ast.ts';
import type { CustomGrant } from './custom-roles.ts';
import type { Decision } from './decision.ts';
import type { EvalEnv } from './events.ts';
import type { Grantee, RelationGrantee, RoleGrantee } from './grantee.ts';
import type { MembershipSource, RelationHolder } from './interfaces.ts';
import type { Permission, ResourceNode } from './permissions.ts';
import type { Grant, Policy } from './policy.ts';
import type { RelationCache, RelationReader } from './relations.ts';
import type { Scope } from './scopes.ts';
import type { Membership, Subject } from './subject.ts';

import { evaluate } from './evaluate.ts';
import { emptyListeners } from './events.ts';
import { freezeDeep } from './freeze.ts';
import { flattenGrantee, relationCondition } from './grantee.ts';
import { ownGet } from './paths.ts';
import {
  getResource,
  isEdgeRelation,
  isFieldRelation,
  isPrincipalRelation,
} from './permissions.ts';
import { grantList } from './policy.ts';
import { pendingRelations, relationId, relationWalk } from './relations.ts';
import {
  findScope,
  normalizeMemberships,
  resolveScope,
  rootScope,
  scopeList,
} from './scopes.ts';
import { nowSeconds } from './tenancy.ts';

/** One way a principal holds a permission on an object. */
export type HoldingVia =
  | {
      readonly kind: 'role';
      readonly role: string;
      readonly membership: Membership;
    }
  | {
      readonly kind: 'relation';
      readonly resource: string;
      readonly relation: string;
      /** The instance the relation is held on: the object or one of its ancestors. */
      readonly id: string;
    }
  | {
      readonly kind: 'share';
      readonly resource: string;
      readonly relation: string;
      readonly id: string;
      readonly expiresAt?: number;
    };

export type Holder = {
  readonly principal: { readonly id: string };
  readonly via: readonly HoldingVia[];
};

/**
 * Who holds a permission on one object, for share dialogs and access
 * reviews. It lists and never grants. `complete: false` means some grantee
 * could not be enumerated (a global role, a plan, a source without `list`,
 * an unavailable relation): holders may be missing, so check with `decide`.
 */
export type WhoCan = {
  readonly permission: string;
  readonly holders: readonly Holder[];
  readonly complete: boolean;
};

type Member = { readonly id: string; readonly membership: Membership };

type NodeHolders = {
  readonly id: string;
  readonly holders: readonly RelationHolder[];
};

/** What discovery shares: the row, the sources, and the candidates found so far. */
type Discovery = {
  readonly policy: Policy;
  readonly scopes: readonly Scope[];
  readonly resource: ResourceNode | undefined;
  readonly permission: Permission;
  readonly row: object;
  readonly reader: RelationReader;
  readonly cache: RelationCache;
  readonly list: (
    scope: string,
    id: string,
  ) => Promise<readonly Member[] | null>;
  readonly add: (id: string, via?: HoldingVia, membership?: Membership) => void;
  readonly incomplete: () => void;
};

const MAX_ROUNDS = 6;

async function settle(cache: RelationCache): Promise<void> {
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const pending = pendingRelations(cache);
    if (pending.length === 0) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- each round's reads depend on the answers of the one before
    await Promise.all(pending);
  }
}

/** The holders on each instance a graph relation reads, or `undefined` when the graph cannot say. */
async function walkHolders(
  condition: RelatedCondition,
  row: unknown,
  reader: RelationReader,
  cache: RelationCache,
): Promise<readonly NodeHolders[] | undefined> {
  let walk = relationWalk(condition, row, reader);
  if (walk === 'relation-unavailable') {
    await settle(cache);
    walk = relationWalk(condition, row, reader);
  }
  if (walk === undefined) {
    return [];
  }
  if (walk === 'relation-depth' || walk === 'relation-unavailable') {
    return undefined;
  }
  const { ids } = walk;
  const read = (): ReturnType<RelationReader['holders']>[] =>
    ids.map((id) =>
      reader.holders({
        resource: condition.resource,
        id,
        relation: condition.relation,
      }),
    );
  let answers = read();
  if (answers.includes('pending')) {
    await settle(cache);
    answers = read();
  }
  const out: NodeHolders[] = [];
  for (const [index, answer] of answers.entries()) {
    const id = ids[index];
    if (answer === 'pending' || answer === 'failed' || id === undefined) {
      return undefined;
    }
    out.push({ id, holders: answer });
  }
  return out;
}

async function discoverRole(
  item: RoleGrantee,
  allow: boolean,
  ctx: Discovery,
): Promise<void> {
  if (typeof item.scope !== 'string' || item.scope === 'global') {
    ctx.incomplete();
    return;
  }
  const key = findScope(ctx.scopes, item.scope)?.key;
  const id = key === undefined ? undefined : relationId(ownGet(ctx.row, key));
  if (id === undefined) {
    return;
  }
  const members = await ctx.list(item.scope, id);
  if (members === null) {
    ctx.incomplete();
    return;
  }
  for (const member of members.filter((entry) =>
    entry.membership.roles.includes(item.role),
  )) {
    ctx.add(
      member.id,
      allow
        ? { kind: 'role', role: item.role, membership: member.membership }
        : undefined,
      member.membership,
    );
  }
}

function holderVia(
  holder: RelationHolder,
  at: {
    readonly resource: string;
    readonly relation: string;
    readonly id: string;
  },
  share: boolean,
): HoldingVia {
  if (!share) {
    return { kind: 'relation', ...at };
  }
  return holder.expiresAt === undefined
    ? { kind: 'share', ...at }
    : { kind: 'share', ...at, expiresAt: holder.expiresAt };
}

async function discoverGraph(
  condition: RelatedCondition,
  allow: boolean,
  ctx: Discovery,
): Promise<void> {
  const nodes = await walkHolders(condition, ctx.row, ctx.reader, ctx.cache);
  if (nodes === undefined) {
    ctx.incomplete();
    return;
  }
  const share = isEdgeRelation(
    ctx.policy.resources.get(condition.resource)?.relations[condition.relation],
  );
  for (const node of nodes) {
    const at = {
      resource: condition.resource,
      relation: condition.relation,
      id: node.id,
    };
    for (const holder of node.holders) {
      ctx.add(
        holder.principal.id,
        allow ? holderVia(holder, at, share) : undefined,
      );
    }
  }
}

async function discoverRelation(
  item: RelationGrantee,
  allow: boolean,
  ctx: Discovery,
): Promise<void> {
  const condition = relationCondition(item, ctx.resource, ctx.scopes, {
    resources: ctx.policy.resources,
  });
  if (condition?.op === 'related') {
    await discoverGraph(condition, allow, ctx);
    return;
  }
  const spec = ctx.resource?.relations[item.relation];
  const via: HoldingVia | undefined = allow
    ? {
        kind: 'relation',
        resource: ctx.permission.resource,
        relation: item.relation,
        id: relationId(ownGet(ctx.row, ctx.resource?.id ?? 'id')) ?? '',
      }
    : undefined;
  if (isFieldRelation(spec) && spec.memberOf !== undefined) {
    const scope = resolveScope(ctx.scopes, spec.memberOf);
    const id = relationId(ownGet(ctx.row, spec.field));
    const members =
      scope === undefined || id === undefined ? [] : await ctx.list(scope, id);
    if (members === null) {
      ctx.incomplete();
      return;
    }
    for (const member of members) {
      ctx.add(member.id, via, member.membership);
    }
    return;
  }
  const column = isFieldRelation(spec)
    ? spec.field
    : isPrincipalRelation(spec)
      ? spec.principal
      : undefined;
  const holder =
    column === undefined ? undefined : relationId(ownGet(ctx.row, column));
  if (holder !== undefined) {
    ctx.add(holder, via);
  }
}

function discover(grant: Grant, item: Grantee, ctx: Discovery): Promise<void> {
  const allow = grant.effect === 'allow';
  switch (item.kind) {
    case 'role':
      return discoverRole(item, allow, ctx);
    case 'relation':
      return discoverRelation(item, allow, ctx);
    case 'anyone':
    case 'authenticated':
    case 'plan':
    case 'actor':
    case 'assurance':
      ctx.incomplete();
      return Promise.resolve();
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}

function memberLister(
  source: MembershipSource | undefined,
  scopes: readonly Scope[],
): Discovery['list'] {
  const listed = new Map<string, Promise<readonly Member[] | null>>();
  const load = async (
    scope: string,
    id: string,
  ): Promise<readonly Member[] | null> => {
    if (source?.list === undefined) {
      return null;
    }
    try {
      const entries = await source.list({ scope, id });
      return entries.flatMap((entry) =>
        typeof entry.principal?.id === 'string'
          ? normalizeMemberships([entry.membership], scopes).map(
              (membership) => ({ id: entry.principal.id, membership }),
            )
          : [],
      );
    } catch {
      return null;
    }
  };
  return (scope, id) => {
    const key = JSON.stringify([scope, id]);
    const known = listed.get(key) ?? load(scope, id);
    listed.set(key, known);
    return known;
  };
}

export async function whoCan(input: {
  readonly policy: Policy;
  readonly permission: Permission;
  readonly row: unknown;
  readonly memberships: MembershipSource | undefined;
  readonly reader: RelationReader;
  readonly cache: RelationCache;
  readonly customGrants: readonly CustomGrant[];
  readonly team: string | undefined;
}): Promise<WhoCan> {
  const { policy, permission, row } = input;
  if (
    permission.kind !== 'instance' ||
    row === null ||
    typeof row !== 'object'
  ) {
    return freezeDeep({
      permission: permission.key,
      holders: [],
      complete: false,
    });
  }
  const scopes = scopeList(policy.scopes);
  let complete = !input.customGrants.some(
    (item) => item.grant.permission.key === permission.key,
  );
  const found = new Map<
    string,
    { readonly memberships: Membership[]; readonly via: HoldingVia[] }
  >();
  const ctx: Discovery = {
    policy,
    scopes,
    resource: getResource(policy.permissions, permission.resource),
    permission,
    row,
    reader: input.reader,
    cache: input.cache,
    list: memberLister(input.memberships, scopes),
    add(id, via, membership) {
      const entry = found.get(id) ?? { memberships: [], via: [] };
      found.set(id, entry);
      if (via !== undefined) {
        entry.via.push(via);
      }
      if (membership !== undefined) {
        entry.memberships.push(membership);
      }
    },
    incomplete() {
      complete = false;
    },
  };
  await Promise.all(
    grantList(policy)
      .filter((grant) => grant.permission.key === permission.key)
      .flatMap((grant) =>
        flattenGrantee(grant.to).map((item) => discover(grant, item, ctx)),
      ),
  );
  const root = rootScope(scopes);
  const tenantKey =
    root === undefined ? undefined : findScope(scopes, root)?.key;
  const tenant =
    tenantKey === undefined ? undefined : relationId(ownGet(row, tenantKey));
  const env: EvalEnv = {
    emit: false,
    simulated: true,
    skipAlternatives: true,
    customRoles: [],
    customGrants: [],
    listeners: emptyListeners(),
    sink: undefined,
    limits: undefined,
    limitCache: new Map(),
    team: input.team,
    relations: input.reader,
  };
  const now = nowSeconds();
  const ordered = [...found.entries()].toSorted(([a], [b]) =>
    a.localeCompare(b),
  );
  const decideAll = (): readonly Decision[] =>
    ordered.map(([id, entry]) => {
      const subject: Subject = freezeDeep({
        principal: {
          id,
          roles: [],
          memberships: entry.memberships,
          ...(tenant === undefined ? {} : { tenant }),
        },
        context: {},
      });
      return evaluate(
        policy,
        subject,
        permission,
        row,
        { source: 'simulate', trusted: true, now },
        env,
      );
    });
  let decisions = decideAll();
  if (pendingRelations(input.cache).length > 0) {
    await settle(input.cache);
    decisions = decideAll();
  }
  const holders: Holder[] = [];
  for (const [index, [id, entry]] of ordered.entries()) {
    const decision = decisions[index];
    if (decision === undefined || decision.outcome === 'denied') {
      if (
        decision?.outcome === 'denied' &&
        decision.denials.some(
          (denial) =>
            denial.reason === 'relation-unavailable' ||
            denial.reason === 'relation-depth',
        )
      ) {
        complete = false;
      }
      continue;
    }
    holders.push({ principal: { id }, via: entry.via });
  }
  return freezeDeep({ permission: permission.key, holders, complete });
}
