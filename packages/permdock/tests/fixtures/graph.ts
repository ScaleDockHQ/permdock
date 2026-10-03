import { z } from "zod";

import type { Membership } from "../../src/index.ts";

import {
  allow,
  definePermissions,
  definePolicy,
  defineRoles,
  memoryRelations,
  relation,
  resource,
  role,
} from "../../src/index.ts";

/**
 * A document workspace exercising the whole relationship graph: nested
 * folders, one `folder_members` edge table split by a `role` column, teams
 * as members of folders and of other teams, an expiring share, a restricted
 * branch, a folder role that walks down the tree, and a review path that
 * crosses from a document to its folder's owning team through named links.
 *
 * ```
 * root (vera views)
 * ├ eng (eddie edits; ex viewed until 1970; team eng-team)
 * │ └ platform (eng-team views; team eng-team)
 * │   └ deep (team sre)
 * └ hr (restricted; hana views)
 *   └ payroll
 *
 * eng-team: carl, and every member of sre
 * sre:      tina; lead lena
 * ```
 */
const Team = z.object({ id: z.string(), leadId: z.string().nullable() });
const Folder = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  teamId: z.string().nullable(),
  restricted: z.boolean(),
});
const Doc = z.object({ id: z.string(), folderId: z.string() });

const asGroupOrUser = {
  column: "kind",
  resources: { team: "member" },
  direct: "user",
} as const;

export const permissions = definePermissions({
  team: resource(Team, {
    actions: ["read"],
    relations: {
      member: {
        edge: "team_members",
        object: "team_id",
        subject: "subject_id",
        groups: asGroupOrUser,
      },
      lead: { principal: "leadId" },
    },
  }),
  folder: resource(Folder, {
    actions: ["read"],
    parent: { field: "parentId", resource: "folder" },
    links: { team: { field: "teamId", resource: "team" } },
    restricted: "restricted",
    relations: {
      editor: {
        edge: "folder_members",
        object: "folder_id",
        subject: "subject_id",
        expiresAt: "expires_at",
        match: { role: "editor" },
        groups: asGroupOrUser,
      },
      viewer: {
        edge: "folder_members",
        object: "folder_id",
        subject: "subject_id",
        expiresAt: "expires_at",
        match: { role: "viewer" },
        groups: asGroupOrUser,
        includes: ["editor"],
      },
    },
  }),
  doc: resource(Doc, {
    actions: ["read", "review"],
    parent: { field: "folderId", resource: "folder" },
    links: { folder: { field: "folderId", resource: "folder" } },
  }),
});

const roles = defineRoles({ folderAdmin: { on: "folder" } });

export const policy = definePolicy(
  { permissions, roles },
  {
    roles: [
      role(
        roles.folderAdmin,
        [allow(permissions.doc.read, { to: roles.folderAdmin })],
        { on: permissions.folder },
      ),
    ],
    grants: [
      allow(permissions.doc.read, {
        to: relation(permissions.folder, "viewer", {
          through: "parent",
          depth: 8,
        }),
      }),
      allow(permissions.doc.review, {
        to: relation(permissions.team, "lead", { through: ["folder", "team"] }),
      }),
    ],
    subject: (user: {
      readonly id: string;
      readonly memberships?: readonly Membership[];
    }) => ({ id: user.id, memberships: user.memberships ?? [] }),
  },
);

export const rows = {
  team: [
    { id: "eng-team", leadId: "lee" },
    { id: "sre", leadId: "lena" },
  ],
  folder: [
    { id: "root", parentId: null, teamId: null, restricted: false },
    { id: "eng", parentId: "root", teamId: "eng-team", restricted: false },
    { id: "platform", parentId: "eng", teamId: "eng-team", restricted: false },
    { id: "deep", parentId: "platform", teamId: "sre", restricted: false },
    { id: "hr", parentId: "root", teamId: null, restricted: true },
    { id: "payroll", parentId: "hr", teamId: null, restricted: false },
  ],
  doc: [
    { id: "root-doc", folderId: "root" },
    { id: "eng-doc", folderId: "eng" },
    { id: "deep-doc", folderId: "deep" },
    { id: "pay-doc", folderId: "payroll" },
  ],
} as const;

const tables = {
  team_members: [
    { team_id: "eng-team", kind: "user", subject_id: "carl" },
    { team_id: "eng-team", kind: "team", subject_id: "sre" },
    { team_id: "sre", kind: "user", subject_id: "tina" },
  ],
  folder_members: [
    {
      folder_id: "root",
      role: "viewer",
      kind: "user",
      subject_id: "vera",
      expires_at: null,
    },
    {
      folder_id: "eng",
      role: "editor",
      kind: "user",
      subject_id: "eddie",
      expires_at: null,
    },
    {
      folder_id: "eng",
      role: "viewer",
      kind: "user",
      subject_id: "ex",
      expires_at: 1000,
    },
    {
      folder_id: "platform",
      role: "viewer",
      kind: "team",
      subject_id: "eng-team",
      expires_at: null,
    },
    {
      folder_id: "hr",
      role: "viewer",
      kind: "user",
      subject_id: "hana",
      expires_at: null,
    },
  ],
} as const;

/** The graph above as an in-memory `RelationSource`. */
export const relations = memoryRelations(permissions, { rows, tables });

/** A folder administrator on `eng`: reaches every document below it, never above. */
export const engAdmin = {
  id: "ada",
  memberships: [
    { on: { resource: "folder", id: "eng" }, roles: ["folderAdmin"] },
  ],
} as const;
