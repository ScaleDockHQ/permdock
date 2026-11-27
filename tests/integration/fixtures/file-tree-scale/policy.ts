import {
  allow,
  authenticated,
  definePermissions,
  definePolicy,
  inherit,
  relation,
  resource,
  role,
  sqlFunction,
} from "permdock";

const inOrganization = {
  organization: { field: "organization_id", memberOf: "organization" },
} as const;

export const permissions = definePermissions({
  file: resource({
    id: "id",
    actions: ["read", "update"],
    relations: inOrganization,
  }),
  fileDrive: resource({
    id: "id",
    actions: ["read", "update"],
    relations: {
      ...inOrganization,
      owner: "owner_user_id",
      viewer: {
        edge: "file_drive_grants",
        object: "drive_id",
        subject: "user_id",
      },
    },
  }),
  fileNode: resource({
    id: "id",
    actions: ["read", "update"],
    links: { drive: { field: "drive_id", resource: "fileDrive" } },
    parent: { field: "parent_id", resource: "fileNode" },
    relations: {
      ...inOrganization,
      viewer: {
        edge: "file_node_grants",
        object: "node_id",
        subject: "user_id",
      },
    },
    restricted: { field: "restricted", stops: ["parent"] },
  }),
});

const { file, fileDrive, fileNode } = permissions;

const recordAccess = (level: "read" | "update") =>
  sqlFunction("public.file_node_record_allowed_ids", {
    args: [level],
    set: { column: "id" },
    twin: { id: { isNull: true } },
  });

export const policy = definePolicy(permissions, {
  scopes: { organization: { key: "organization_id" } },
  roles: [
    role("owner", [allow(file.read), allow(file.update)], {
      on: "organization",
    }),
    role("member", [allow(file.read)], { on: "organization" }),
  ],
  grants: [
    allow(fileDrive.read, {
      requires: file.read,
      to: authenticated(),
      where: { drive_type: "company" },
    }),
    allow(fileDrive.read, {
      requires: file.read,
      to: relation(fileDrive, "owner"),
    }),
    allow(fileDrive.read, {
      requires: file.read,
      to: relation(fileDrive, "viewer"),
    }),
    allow(fileDrive.update, {
      requires: [file.read, file.update],
      to: authenticated(),
      where: { drive_type: "company" },
    }),
    allow(fileDrive.update, {
      requires: file.read,
      to: relation(fileDrive, "owner"),
    }),
    allow(fileNode.read, {
      requires: file.read,
      to: inherit(fileDrive.read, { through: ["drive"] }),
    }),
    allow(fileNode.update, {
      requires: file.read,
      to: inherit(fileDrive.update, { through: ["drive"] }),
    }),
    allow(fileNode.read, {
      requires: file.read,
      to: relation(fileNode, "viewer", { depth: 32, through: "parent" }),
    }),
    allow(fileNode.read, { to: authenticated(), where: recordAccess("read") }),
    allow(fileNode.update, {
      to: authenticated(),
      where: recordAccess("update"),
    }),
  ],
  subject: () => null,
});
