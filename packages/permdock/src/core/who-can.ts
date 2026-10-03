import type { RelatedCondition } from '../conditions/ast.ts';
import type { CustomGrant } from './custom-roles.ts';
import type { Decision } from './decision.ts';
import type { EvalEnv } from './events.ts';
import type { Grantee, RelationGrantee, RoleGrantee } from './grantee.ts';
import type {
  MembershipSource,
  RelationGroup,
  RelationHolder,
} from './interfaces.ts';
import type { Permission, ResourceNode } from './permissions.ts';
import type { Grant, Policy } from './policy.ts';
import type { ReadHolder, RelationCache, RelationReader } from './relations.ts';
import type { Scope } from './scopes.ts';
import type { Membership, Subject } from './subject.ts';

import { compact } from './compact.ts';
import { byCodePoint } from './compare.ts';
import { evaluate } from './evaluate.ts';
import { emptyListeners } from './events.ts';
import { freezeDeep } from './freeze.ts';
import { flattenGrantee, relationCondition } from './grantee.ts';
import { ownGet } from './paths.ts';
import {
  expandRelation,
  getResource,
  isEdgeRelation,
  isFieldRelation,
  isPrincipalRelation,
} from './permissions.ts';
import {
  DEFAULT_GROUP_DEPTH,
  pendingRelations,
  relationId,
  relationWalk,
} from './relations.ts';
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
      /** The group the share names, when the principal holds it as one of its members. */
      readonly group?: RelationGroup;
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
  readonly holders: readonly ReadHolder[];
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

const MAX_ROUNDS = 48;

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
  group?: RelationGroup,
): HoldingVia {
  if (!share) {
    return { kind: 'relation', ...at };
  }
  return compact<HoldingVia>({
    kind: 'share',
    ...at,
    expiresAt: holder.expiresAt,
    group,
  });
}

type GroupWalk = {
  readonly members: readonly string[];
  /** Whether a group was skipped for already being on the path, so `members` holds only this path's share. */
  readonly cut: boolean;
};

/**
 * Principals holding `group`'s relation, through at most `budget` more groups
 * of its resource; `undefined` when a read failed. `memo` keeps each group's
 * members per budget across one discovery, so a group shared by many paths is
 * read once; a result cut short by a cycle is path-specific and not kept.
 */
async function groupMembers(
  group: RelationGroup,
  ctx: Discovery,
  budget: number,
  seen: ReadonlySet<string>,
  memo: Map<string, readonly string[]>,
): Promise<GroupWalk | undefined> {
  const key = JSON.stringify([group.resource, group.id, group.relation]);
  const memoKey = `${budget}:${key}`;
  const known = memo.get(memoKey);
  if (known !== undefined) {
    return { members: known, cut: false };
  }
  let holders = ctx.reader.holders(group);
  if (holders === 'pending') {
    await settle(ctx.cache);
    holders = ctx.reader.holders(group);
  }
  if (holders === 'pending' || holders === 'failed') {
    return undefined;
  }
  const path = new Set(seen).add(key);
  const out = new Set<string>();
  let cut = false;
  for (const holder of holders) {
    if ('principal' in holder) {
      out.add(holder.principal.id);
      continue;
    }
    const nested = JSON.stringify([
      holder.group.resource,
      holder.group.id,
      holder.group.relation,
    ]);
    const same = holder.group.resource === group.resource;
    if (path.has(nested)) {
      cut = true;
      continue;
    }
    if (same && budget <= 0) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- nested groups are read one level at a time
    const walk = await groupMembers(
      holder.group,
      ctx,
      same ? budget - 1 : DEFAULT_GROUP_DEPTH,
      path,
      memo,
    );
    if (walk === undefined) {
      return undefined;
    }
    cut ||= walk.cut;
    for (const member of walk.members) {
      out.add(member);
    }
  }
  const members = [...out];
  if (!cut) {
    memo.set(memoKey, members);
  }
  return { members, cut };
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
  const node = ctx.policy.resources.get(condition.resource);
  const memo = new Map<string, readonly string[]>();
  for (const entry of nodes) {
    for (const holder of entry.holders) {
      const at = {
        resource: condition.resource,
        relation: holder.relation,
        id: entry.id,
      };
      const share = isEdgeRelation(node?.relations[holder.relation]);
      if ('principal' in holder) {
        ctx.add(
          holder.principal.id,
          allow ? holderVia(holder, at, share) : undefined,
        );
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- each group's members are read after the walk settles
      const walk = await groupMembers(
        holder.group,
        ctx,
        holder.group.resource === condition.resource
          ? DEFAULT_GROUP_DEPTH - 1
          : DEFAULT_GROUP_DEPTH,
        new Set(),
        memo,
      );
      if (walk === undefined) {
        ctx.incomplete();
        continue;
      }
      for (const member of walk.members) {
        ctx.add(
          member,
          allow ? holderVia(holder, at, share, holder.group) : undefined,
        );
      }
    }
  }
}

async function discoverRelation(
  item: RelationGrantee,
  allow: boolean,
  ctx: Discovery,
  expanded = false,
): Promise<void> {
  const condition = relationCondition(item, ctx.resource, ctx.scopes, {
    resources: ctx.policy.resources,
  });
  if (condition?.op === 'related') {
    await discoverGraph(condition, allow, ctx);
    return;
  }
  const spec = ctx.resource?.relations[item.relation];
  if (spec?.includes !== undefined && !expanded) {
    for (const name of expandRelation(ctx.resource, item.relation)) {
      // oxlint-disable-next-line no-await-in-loop -- each included relation is a field or principal read on the row
      await discoverRelation({ ...item, relation: name }, allow, ctx, true);
    }
    return;
  }
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
      return unknownKind(exhaustive, ctx);
    }
  }
}

/** Holders of a grantee kind this build does not know cannot be listed. */
function unknownKind(_item: never, ctx: Discovery): Promise<void> {
  ctx.incomplete();
  return Promise.resolve();
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
    (policy.index.grantsByKey.get(permission.key) ?? []).flatMap((grant) =>
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
    byCodePoint(a, b),
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
