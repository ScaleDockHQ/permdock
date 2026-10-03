import type { Condition, Principal } from "permdock";
import type { MembershipsMapping } from "permdock/drizzle";

import {
  allow,
  defineRoles,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "permdock";

/**
 * One instance action per operator shape, so each ORM parity scenario
 * isolates one compilation. `item` rows sit in a `folder` (the parent).
 */
const OPERATORS = {
  eq: { op: "eq", field: "status", value: "open" },
  ne: { op: "ne", field: "status", value: "open" },
  gt: { op: "gt", field: "score", value: 5 },
  gte: { op: "gte", field: "score", value: 5 },
  lt: { op: "lt", field: "score", value: 5 },
  lte: { op: "lte", field: "score", value: 5 },
  in: { op: "in", field: "status", value: ["open", "closed"] },
  inWithNull: { op: "in", field: "status", value: ["open", null] },
  notIn: { op: "notIn", field: "status", value: ["open"] },
  notInWithNull: { op: "notIn", field: "status", value: ["open", null] },
  containsPercent: { op: "contains", field: "title", value: "100%" },
  containsUnderscore: { op: "contains", field: "title", value: "a_b" },
  containsTag: { op: "contains", field: "tags", value: "red" },
  isNull: { op: "isNull", field: "owner", value: true },
  notNull: { op: "isNull", field: "owner", value: false },
  dateGt: { op: "gt", field: "due", value: { date: "2026-01-01T00:00:00Z" } },
  boolTrue: { op: "eq", field: "archived", value: true },
  slug: { op: "eq", field: "owner", value: "user-2" },
  refOwner: { op: "eq", field: "owner", value: { ref: "principal.id" } },
  refMissing: {
    op: "eq",
    field: "owner",
    value: { ref: "principal.nickname" },
  },
  refMissingNe: {
    op: "ne",
    field: "owner",
    value: { ref: "principal.nickname" },
  },
  refMissingNotIn: {
    op: "notIn",
    field: "owner",
    value: { ref: "principal.nickname" },
  },
  notEq: { op: "not", condition: { op: "eq", field: "status", value: "open" } },
  notGt: { op: "not", condition: { op: "gt", field: "score", value: 5 } },
  notIn2: {
    op: "not",
    condition: { op: "in", field: "status", value: ["open", "closed"] },
  },
  notNotIn: {
    op: "not",
    condition: { op: "notIn", field: "status", value: ["open"] },
  },
  notContains: {
    op: "not",
    condition: { op: "contains", field: "tags", value: "red" },
  },
  notBool: {
    op: "not",
    condition: { op: "eq", field: "archived", value: true },
  },
  notAnd: {
    op: "not",
    condition: {
      op: "and",
      conditions: [
        { op: "eq", field: "status", value: "open" },
        { op: "gt", field: "score", value: 5 },
      ],
    },
  },
  notOr: {
    op: "not",
    condition: {
      op: "or",
      conditions: [
        { op: "eq", field: "status", value: "open" },
        { op: "lt", field: "score", value: 5 },
      ],
    },
  },
  notRefMissing: {
    op: "not",
    condition: {
      op: "eq",
      field: "owner",
      value: { ref: "principal.nickname" },
    },
  },
  notNull2: {
    op: "not",
    condition: { op: "isNull", field: "owner", value: true },
  },
  memberOfTenant: {
    op: "memberOf",
    scope: "tenant",
    field: "orgId",
    roles: ["member"],
  },
  memberOfTenantAny: {
    op: "memberOf",
    scope: "tenant",
    field: "orgId",
    roles: [],
  },
  memberOfTeam: {
    op: "memberOf",
    scope: "team",
    field: "teamId",
    roles: [],
  },
  memberOfFolder: {
    op: "memberOf",
    scope: "resource",
    resource: "item",
    field: "id",
    roles: ["editor"],
    parents: ["folderId"],
  },
  memberOfFolderKeyed: {
    op: "memberOf",
    scope: "resource",
    resource: "item",
    field: "id",
    roles: ["editor"],
    parents: [{ field: "folderId", resource: "folder" }],
  },
  notMemberOfTenant: {
    op: "not",
    condition: {
      op: "memberOf",
      scope: "tenant",
      field: "orgId",
      roles: ["member"],
    },
  },
} as const satisfies Readonly<Record<string, Condition>>;

export type ItemAction = keyof typeof OPERATORS | "inFolder";

export const itemActions =
  // SAFETY: Object.keys(OPERATORS) lists exactly its keys, which with 'inFolder' are ItemAction
  [...Object.keys(OPERATORS), "inFolder"] as readonly ItemAction[];

export const itemPermissions = definePermissions({
  folder: resource({ actions: ["read"] }),
  item: resource({
    parent: { field: "folderId", resource: "folder" },
    actions: itemActions,
  }),
});

export const itemRoles = defineRoles({
  reader: {},
  editor: { assignable: true },
});

// SAFETY: itemActions lists every ItemAction, so the resource has one permission per action
const item = itemPermissions.item as unknown as Readonly<
  Record<ItemAction, (typeof itemPermissions.item)["eq"]>
>;

export const itemPolicy = definePolicy(
  { permissions: itemPermissions, roles: itemRoles },
  {
    subject: (user: Principal | null) => user,
    roles: [
      role(itemRoles.editor, [allow(item.inFolder, { to: itemRoles.editor })], {
        on: itemPermissions.folder,
      }),
    ],
    grants: Object.entries(OPERATORS).map(([action, where]) =>
      // SAFETY: Object.entries(OPERATORS) yields only its keys, each an ItemAction
      allow(item[action as ItemAction], { to: itemRoles.reader, where }),
    ),
  },
);

export type ItemRow = {
  readonly id: string;
  readonly orgId: string;
  readonly teamId: string | null;
  readonly folderId: string | null;
  readonly owner: string | null;
  readonly status: string | null;
  readonly score: number | null;
  readonly title: string;
  readonly tags: readonly string[] | null;
  readonly due: Date | null;
  readonly archived: boolean | null;
};

/**
 * Adversarial rows: NULL in every nullable column, `%` and `_` in titles, a
 * team id reused across tenants, slug-like owners, and an item whose id is
 * also a folder id (`f1`).
 */
export const itemRows: readonly ItemRow[] = [
  {
    id: "i1",
    orgId: "acme",
    teamId: "team-a",
    folderId: "f1",
    owner: "alice",
    status: "open",
    score: 10,
    title: "100% done",
    tags: ["red", "blue"],
    due: new Date("2026-06-01T00:00:00Z"),
    archived: false,
  },
  {
    id: "i2",
    orgId: "acme",
    teamId: "team-b",
    folderId: "f2",
    owner: "bob",
    status: "closed",
    score: 5,
    title: "a_b",
    tags: ["blue"],
    due: new Date("2025-06-01T00:00:00Z"),
    archived: true,
  },
  {
    id: "i3",
    orgId: "acme",
    teamId: null,
    folderId: null,
    owner: null,
    status: null,
    score: null,
    title: "axb",
    tags: null,
    due: null,
    archived: null,
  },
  {
    id: "i4",
    orgId: "globex",
    teamId: "team-a",
    folderId: "f1",
    owner: "user-2",
    status: "open",
    score: 3,
    title: "50% off",
    tags: [],
    due: new Date("2027-01-01T00:00:00Z"),
    archived: false,
  },
  {
    id: "i5",
    orgId: "org-1",
    teamId: null,
    folderId: "f2",
    owner: "2",
    status: "archived",
    score: 7,
    title: "plain",
    tags: ["red"],
    due: null,
    archived: false,
  },
  {
    id: "f1",
    orgId: "acme",
    teamId: "team-a",
    folderId: "f9",
    owner: "org-1",
    status: "open",
    score: 6,
    title: "folder lookalike",
    tags: ["green"],
    due: new Date("2026-01-01T00:00:00Z"),
    archived: false,
  },
];

export type ItemMember = {
  readonly user: string;
  readonly tenant?: string;
  readonly team?: string;
  readonly on?: { readonly resource: string; readonly id: string };
  readonly roles: readonly string[];
  readonly expiresAt?: number;
};

const PAST = 1_000_000_000;

/**
 * - alice: member of acme, lead of acme team-a, editor of folder f1
 * - bob: member of globex, lead of globex team-a, expired member of acme,
 *   editor of a project whose id collides with folder f1
 * - user-2: member of org-1
 * - mallory: no memberships
 */
export const itemMembers: readonly ItemMember[] = [
  { user: "alice", tenant: "acme", roles: ["member"] },
  { user: "alice", tenant: "acme", team: "team-a", roles: ["lead"] },
  { user: "alice", on: { resource: "folder", id: "f1" }, roles: ["editor"] },
  // A project whose id collides with folder f1: a keyed hop must ignore it.
  { user: "bob", on: { resource: "project", id: "f1" }, roles: ["editor"] },
  { user: "bob", tenant: "globex", roles: ["member"] },
  { user: "bob", tenant: "globex", team: "team-a", roles: ["lead"] },
  { user: "bob", tenant: "acme", roles: ["member"], expiresAt: PAST },
  { user: "user-2", tenant: "org-1", roles: ["member"] },
];

export const itemUsers = ["alice", "bob", "user-2", "mallory"] as const;

export function itemPrincipal(user: string): Principal {
  return {
    id: user,
    roles: ["reader"],
    memberships: itemMembers
      .filter((member) => member.user === user)
      .map(({ user: _user, ...membership }) =>
        Object.assign(membership, { roles: [...membership.roles] }),
      ),
  };
}

/** Where each scope kind's memberships live, for the `exists` form. */
export const itemMemberships: MembershipsMapping = {
  tenant: {
    table: "item_member",
    user: "user_id",
    role: "role",
    tenant: "org_id",
    expiresAt: "expires_at",
  },
  team: {
    table: "item_member",
    user: "user_id",
    role: "role",
    tenant: "org_id",
    team: "team_id",
    expiresAt: "expires_at",
  },
  resource: {
    item: {
      table: "item_member",
      user: "user_id",
      role: "role",
      id: "resource_id",
      resource: "resource",
      expiresAt: "expires_at",
    },
    folder: {
      table: "item_member",
      user: "user_id",
      role: "role",
      id: "resource_id",
      resource: "resource",
      expiresAt: "expires_at",
    },
  },
};
