import type { Principal } from "permdock";

import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "permdock";
import { z } from "zod";

/**
 * Share links next to staff access: a guest link reads one sent quote, a
 * commenter link on a folder reaches that folder's files, and staff read
 * every quote of their organization.
 */
const Quote = z.object({
  id: z.string(),
  organization_id: z.string(),
  status: z.enum(["draft", "sent"]),
});

const Folder = z.object({ id: z.string() });

const File = z.object({ id: z.string(), folder_id: z.string() });

export const permissions = definePermissions({
  quote: resource(Quote, {
    id: "id",
    actions: ["read", "accept", "update"],
    relations: {
      organization: { field: "organization_id", memberOf: "organization" },
    },
  }),
  folder: resource(Folder, { id: "id", actions: ["read"] }),
  file: resource(File, {
    id: "id",
    parent: { field: "folder_id", resource: "folder" },
    actions: ["read", "update"],
  }),
});

export const policy = definePolicy(permissions, {
  subject: (user: Principal | null) => user,
  scopes: { organization: { key: "organization_id" } },
  roles: [
    role("staff", [allow(permissions.quote.read)], { on: "organization" }),
    role(
      "guest",
      [
        allow(permissions.quote.read, { where: { status: "sent" } }),
        allow(permissions.quote.accept, { where: { status: "sent" } }),
      ],
      { on: permissions.quote },
    ),
    role("commenter", [allow(permissions.file.read)], {
      on: permissions.folder,
    }),
  ],
});

export const quotes = [
  { id: "q_1", organization_id: "T", status: "sent" },
  { id: "q_2", organization_id: "T", status: "sent" },
  { id: "q_3", organization_id: "T", status: "draft" },
  { id: "q_4", organization_id: "B", status: "sent" },
] as const;

export const files = [
  { id: "x_1", folder_id: "f_1" },
  { id: "x_2", folder_id: "f_1" },
  { id: "x_3", folder_id: "f_2" },
] as const;
