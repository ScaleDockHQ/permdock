import type { Membership } from 'permdock';

import {
  allow,
  definePermissions,
  definePolicy,
  defineRoles,
  memoryRelations,
  relation,
  resource,
  role,
} from 'permdock';
import { z } from 'zod';

// The graph of packages/permdock/tests/fixtures/graph.ts, built on the
// published entry so its registry is the one the ORM compilers read.
const Team = z.object({ id: z.string(), leadId: z.string().nullable() });
const Folder = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  teamId: z.string().nullable(),
  restricted: z.boolean(),
});
const Doc = z.object({ id: z.string(), folderId: z.string() });

const asGroupOrUser = {
  column: 'kind',
  resources: { team: 'member' },
  direct: 'user',
} as const;

const member = {
  edge: 'folder_members',
  object: 'folder_id',
  subject: 'subject_id',
  expiresAt: 'expires_at',
  groups: asGroupOrUser,
} as const;

export const permissions = definePermissions({
  team: resource(Team, {
    actions: ['read'],
    relations: {
      member: {
        edge: 'team_members',
        object: 'team_id',
        subject: 'subject_id',
        groups: asGroupOrUser,
      },
      lead: { principal: 'leadId' },
    },
  }),
  folder: resource(Folder, {
    actions: ['read'],
    parent: { field: 'parentId', resource: 'folder' },
    links: { team: { field: 'teamId', resource: 'team' } },
    restricted: 'restricted',
    relations: {
      editor: { ...member, match: { role: 'editor' } },
      viewer: { ...member, match: { role: 'viewer' }, includes: ['editor'] },
    },
  }),
  doc: resource(Doc, {
    actions: ['read', 'review'],
    parent: { field: 'folderId', resource: 'folder' },
    links: { folder: { field: 'folderId', resource: 'folder' } },
  }),
});

export const roles = defineRoles({ folderAdmin: { on: 'folder' } });

export type WorkspaceUser = {
  readonly id: string;
  readonly memberships?: readonly Membership[];
};

const grants = [
  allow(permissions.doc.read, {
    to: relation(permissions.folder, 'viewer', {
      through: 'parent',
      depth: 8,
    }),
  }),
  allow(permissions.folder.read, {
    to: relation(permissions.folder, 'viewer', {
      through: 'parent',
      depth: 2,
    }),
  }),
  allow([permissions.doc.review, permissions.doc.read], {
    to: relation(permissions.team, 'lead', { through: ['folder', 'team'] }),
  }),
  allow(permissions.team.read, {
    to: relation(permissions.team, 'member'),
  }),
];

const subject = (user: WorkspaceUser) => ({
  id: user.id,
  memberships: user.memberships ?? [],
});

// Declared so the implicit tenant / team scopes do not claim the name of the
// team resource (its RLS helper is permitted_team_ids).
const scopes = { org: { key: 'orgId' } };

export const policy = definePolicy(
  { permissions, roles },
  {
    scopes,
    roles: [
      role(
        roles.folderAdmin,
        [allow(permissions.doc.read, { to: roles.folderAdmin })],
        { on: permissions.folder },
      ),
    ],
    grants,
    subject,
  },
);

/** The graph grants alone: what `permdock rls` compiles without a memberships table. */
export const graphPolicy = definePolicy(permissions, {
  scopes,
  grants,
  subject,
});

export const rows = {
  team: [
    { id: 'eng-team', leadId: 'lee' },
    { id: 'sre', leadId: 'lena' },
    { id: 'oncall', leadId: null },
  ],
  folder: [
    { id: 'root', parentId: null, teamId: null, restricted: false },
    { id: 'eng', parentId: 'root', teamId: 'eng-team', restricted: false },
    { id: 'platform', parentId: 'eng', teamId: 'eng-team', restricted: false },
    { id: 'deep', parentId: 'platform', teamId: 'sre', restricted: false },
    { id: 'hr', parentId: 'root', teamId: null, restricted: true },
    { id: 'payroll', parentId: 'hr', teamId: null, restricted: false },
    { id: 'secret', parentId: 'eng', teamId: null, restricted: true },
    { id: 'vault', parentId: 'secret', teamId: null, restricted: false },
  ],
  doc: [
    { id: 'root-doc', folderId: 'root' },
    { id: 'eng-doc', folderId: 'eng' },
    { id: 'platform-doc', folderId: 'platform' },
    { id: 'deep-doc', folderId: 'deep' },
    { id: 'hr-doc', folderId: 'hr' },
    { id: 'pay-doc', folderId: 'payroll' },
    { id: 'secret-doc', folderId: 'secret' },
    { id: 'vault-doc', folderId: 'vault' },
  ],
};

type EdgeRow = Readonly<Record<string, string | number | null>>;

export const tables: Readonly<Record<string, readonly EdgeRow[]>> = {
  team_members: [
    { team_id: 'eng-team', kind: 'user', subject_id: 'carl' },
    { team_id: 'eng-team', kind: 'team', subject_id: 'sre' },
    { team_id: 'sre', kind: 'user', subject_id: 'tina' },
    { team_id: 'sre', kind: 'team', subject_id: 'oncall' },
    { team_id: 'oncall', kind: null, subject_id: 'otto' },
    { team_id: 'oncall', kind: 'robot', subject_id: 'rob' },
  ],
  folder_members: [
    {
      folder_id: 'root',
      role: 'viewer',
      kind: 'user',
      subject_id: 'vera',
      expires_at: null,
    },
    {
      folder_id: 'eng',
      role: 'editor',
      kind: 'user',
      subject_id: 'eddie',
      expires_at: null,
    },
    {
      folder_id: 'eng',
      role: 'viewer',
      kind: 'user',
      subject_id: 'ex',
      expires_at: 1000,
    },
    {
      folder_id: 'eng',
      role: 'viewer',
      kind: 'user',
      subject_id: 'fay',
      expires_at: 4_000_000_000,
    },
    {
      folder_id: 'platform',
      role: 'viewer',
      kind: 'team',
      subject_id: 'eng-team',
      expires_at: null,
    },
    {
      folder_id: 'hr',
      role: 'viewer',
      kind: 'user',
      subject_id: 'hana',
      expires_at: null,
    },
    {
      folder_id: 'secret',
      role: 'owner',
      kind: 'user',
      subject_id: 'vera',
      expires_at: null,
    },
    {
      folder_id: 'secret',
      role: 'editor',
      kind: 'user',
      subject_id: 'sid',
      expires_at: null,
    },
  ],
};

export const relations = memoryRelations(permissions, { rows, tables });

export const users: readonly WorkspaceUser[] = [
  ...[
    'vera',
    'eddie',
    'carl',
    'tina',
    'otto',
    'rob',
    'ex',
    'fay',
    'hana',
    'sid',
    'lee',
    'lena',
    'nobody',
  ].map((id) => ({ id })),
  {
    id: 'ada',
    memberships: [
      { on: { resource: 'folder', id: 'eng' }, roles: ['folderAdmin'] },
    ],
  },
];

function literal(value: string | number | boolean | null): string {
  if (value === null) {
    return 'null';
  }
  return typeof value === 'string'
    ? `'${value.replaceAll("'", "''")}'`
    : String(value);
}

function insert(
  table: string,
  items: readonly Readonly<Record<string, string | number | boolean | null>>[],
  expiry?: string,
): string {
  const first = items[0];
  if (first === undefined) {
    return '';
  }
  const columns = Object.keys(first);
  const values = items
    .map(
      (row) =>
        `(${columns
          .map((column) =>
            column === expiry && typeof row[column] === 'number'
              ? `to_timestamp(${String(row[column])})`
              : literal(row[column] ?? null),
          )
          .join(', ')})`,
    )
    .join(',\n  ');
  return `insert into ${table} (${columns.map((column) => `"${column}"`).join(', ')}) values\n  ${values};`;
}

export const schemaSql = `
create table team (id text primary key, "leadId" text);
create table folder (
  id text primary key,
  "parentId" text references folder (id),
  "teamId" text references team (id),
  restricted boolean not null default false
);
create table doc (id text primary key, "folderId" text not null references folder (id));
create table team_members (team_id text not null, kind text, subject_id text not null);
create table folder_members (
  folder_id text not null,
  role text not null,
  kind text,
  subject_id text not null,
  expires_at timestamptz
);
`;

export const seedSql = [
  insert('team', rows.team),
  insert('folder', rows.folder),
  insert('doc', rows.doc),
  insert('team_members', tables['team_members'] ?? []),
  insert('folder_members', tables['folder_members'] ?? [], 'expires_at'),
].join('\n');

/** The closure as `permdock rls` keeps it: every folder reaches its ancestors, stopping after the first restricted one. */
export const closureSql = `
create table permdock_closure (
  resource text not null,
  ancestor text not null,
  descendant text not null,
  depth integer not null,
  primary key (resource, descendant, ancestor)
);
insert into permdock_closure (resource, ancestor, descendant, depth)
with recursive walk(descendant, ancestor, parent, depth, stop) as (
  select id, id, "parentId", 0, restricted from folder
  union all
  select walk.descendant, p.id, p."parentId", walk.depth + 1, p.restricted
  from walk join folder p on p.id = walk.parent
  where not walk.stop and walk.depth < 32
)
select 'folder', ancestor, descendant, depth from walk;`;
