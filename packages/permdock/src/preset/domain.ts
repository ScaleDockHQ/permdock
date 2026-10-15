import type { ArchetypeId } from "./catalog.ts";

/** One resource of a starter domain: its fields and actions. */
export type ResourceSpec = {
  readonly name: string;
  /** Field name to a Zod expression; `id` is added. */
  readonly fields: Readonly<Record<string, string>>;
  readonly preset: "crud" | "readable";
  /** Instance actions beyond the preset's. */
  readonly actions?: readonly string[];
  /** Collection actions beyond the preset's. */
  readonly collection?: readonly string[];
  /** The field that names the row's owner, for the ownership feature. */
  readonly owner?: string;
  /** Actions that change money, send messages or cannot be undone. */
  readonly sensitive?: readonly string[];
};

/** A grant a role holds, before features rewrite it. */
export type GrantSpec = {
  readonly resource: string;
  readonly action: string;
  /** Only on rows the subject owns, when ownership is on. */
  readonly own?: true;
};

export type RoleSpec = {
  readonly name: string;
  readonly grants: readonly GrantSpec[];
  /** The top role of an organisation: holds everything, at least one per organisation. */
  readonly top?: true;
  /** Roles this one may hand out, when organisations are on. */
  readonly assigns?: readonly string[];
};

export type DomainSpec = {
  readonly resources: readonly ResourceSpec[];
  readonly roles: readonly RoleSpec[];
  /** The role the demo user holds. */
  readonly demoRole: string;
  /** A grant only the pro plan has, when plans are on. */
  readonly pro?: GrantSpec;
};

function all(resource: string, actions: readonly string[]): GrantSpec[] {
  return actions.map((action) => ({ resource, action }));
}

const CRUD = ["read", "update", "delete", "create", "list"] as const;
const READ = ["read", "list"] as const;

export const DOMAINS: Readonly<Record<ArchetypeId, DomainSpec>> = {
  b2b: {
    resources: [
      {
        name: "project",
        fields: { name: "z.string()", ownerId: "z.string()" },
        preset: "crud",
        actions: ["archive"],
        owner: "ownerId",
      },
      {
        name: "invoice",
        fields: { amount: "z.number()", ownerId: "z.string()" },
        preset: "readable",
        actions: ["pay"],
        collection: ["create"],
        owner: "ownerId",
        sensitive: ["pay"],
      },
    ],
    roles: [
      {
        name: "owner",
        top: true,
        grants: [
          ...all("project", [...CRUD, "archive"]),
          ...all("invoice", [...READ, "create", "pay"]),
        ],
        assigns: ["owner", "admin", "member", "viewer"],
      },
      {
        name: "admin",
        grants: [
          ...all("project", [...CRUD, "archive"]),
          ...all("invoice", [...READ, "create", "pay"]),
        ],
        assigns: ["member", "viewer"],
      },
      {
        name: "member",
        grants: [
          ...all("project", ["read", "list", "create"]),
          { resource: "project", action: "update", own: true },
          { resource: "project", action: "delete", own: true },
          ...all("invoice", READ),
        ],
      },
      {
        name: "viewer",
        grants: [...all("project", READ), ...all("invoice", READ)],
      },
    ],
    demoRole: "member",
    pro: { resource: "project", action: "archive" },
  },
  agent: {
    resources: [
      {
        name: "document",
        fields: { title: "z.string()", ownerId: "z.string()" },
        preset: "crud",
        owner: "ownerId",
      },
      {
        name: "email",
        fields: { to: "z.string()" },
        preset: "readable",
        collection: ["send"],
        sensitive: ["send"],
      },
    ],
    roles: [
      {
        name: "member",
        grants: [
          ...all("document", ["read", "list", "create"]),
          { resource: "document", action: "update", own: true },
          { resource: "document", action: "delete", own: true },
          ...all("email", [...READ, "send"]),
        ],
      },
      {
        name: "admin",
        top: true,
        grants: [...all("document", CRUD), ...all("email", [...READ, "send"])],
        assigns: ["admin", "member"],
      },
    ],
    demoRole: "member",
    pro: { resource: "email", action: "send" },
  },
  marketplace: {
    resources: [
      {
        name: "listing",
        fields: { title: "z.string()", sellerId: "z.string()" },
        preset: "crud",
        actions: ["publish"],
        owner: "sellerId",
      },
      {
        name: "order",
        fields: { listingId: "z.string()", buyerId: "z.string()" },
        preset: "readable",
        actions: ["refund"],
        collection: ["create"],
        owner: "buyerId",
        sensitive: ["refund"],
      },
    ],
    roles: [
      {
        name: "buyer",
        grants: [
          ...all("listing", READ),
          { resource: "order", action: "create" },
          { resource: "order", action: "list" },
          { resource: "order", action: "read", own: true },
        ],
      },
      {
        name: "seller",
        grants: [
          ...all("listing", ["read", "list", "create"]),
          { resource: "listing", action: "update", own: true },
          { resource: "listing", action: "delete", own: true },
          { resource: "listing", action: "publish", own: true },
          ...all("order", READ),
          { resource: "order", action: "refund" },
        ],
      },
      {
        name: "admin",
        top: true,
        grants: [
          ...all("listing", [...CRUD, "publish"]),
          ...all("order", [...READ, "create", "refund"]),
        ],
        assigns: ["admin", "seller", "buyer"],
      },
    ],
    demoRole: "seller",
    pro: { resource: "listing", action: "publish" },
  },
  api: {
    resources: [
      {
        name: "project",
        fields: { name: "z.string()", ownerId: "z.string()" },
        preset: "crud",
        owner: "ownerId",
      },
      {
        name: "deployment",
        fields: { projectId: "z.string()" },
        preset: "readable",
        actions: ["rollback"],
        collection: ["create"],
        sensitive: ["rollback"],
      },
    ],
    roles: [
      {
        name: "owner",
        top: true,
        grants: [
          ...all("project", CRUD),
          ...all("deployment", [...READ, "create", "rollback"]),
        ],
        assigns: ["owner", "developer", "viewer"],
      },
      {
        name: "developer",
        grants: [
          ...all("project", ["read", "list", "create", "update"]),
          ...all("deployment", [...READ, "create", "rollback"]),
        ],
      },
      {
        name: "viewer",
        grants: [...all("project", READ), ...all("deployment", READ)],
      },
    ],
    demoRole: "developer",
    pro: { resource: "deployment", action: "rollback" },
  },
  internal: {
    resources: [
      {
        name: "ticket",
        fields: { subject: "z.string()", ownerId: "z.string()" },
        preset: "crud",
        actions: ["assign", "close"],
        owner: "ownerId",
      },
      {
        name: "report",
        fields: { title: "z.string()" },
        preset: "readable",
      },
    ],
    roles: [
      {
        name: "agent",
        grants: [
          ...all("ticket", ["read", "list", "create"]),
          { resource: "ticket", action: "update", own: true },
          { resource: "ticket", action: "close", own: true },
        ],
      },
      {
        name: "lead",
        grants: [
          ...all("ticket", [...CRUD, "assign", "close"]),
          ...all("report", READ),
        ],
      },
      {
        name: "admin",
        top: true,
        grants: [
          ...all("ticket", [...CRUD, "assign", "close"]),
          ...all("report", READ),
        ],
        assigns: ["admin", "lead", "agent"],
      },
    ],
    demoRole: "agent",
    pro: { resource: "report", action: "read" },
  },
  consumer: {
    resources: [
      {
        name: "note",
        fields: { body: "z.string()", ownerId: "z.string()" },
        preset: "crud",
        actions: ["export"],
        owner: "ownerId",
      },
    ],
    roles: [
      {
        name: "user",
        grants: [
          { resource: "note", action: "create" },
          { resource: "note", action: "list" },
          { resource: "note", action: "read", own: true },
          { resource: "note", action: "update", own: true },
          { resource: "note", action: "delete", own: true },
        ],
      },
      {
        name: "admin",
        top: true,
        grants: all("note", [...CRUD, "export"]),
        assigns: ["admin", "user"],
      },
    ],
    demoRole: "user",
    pro: { resource: "note", action: "export" },
  },
};
