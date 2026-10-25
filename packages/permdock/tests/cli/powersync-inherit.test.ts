import { describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";

import { powersyncPlan } from "../../src/cli/powersync/streams.ts";
import {
  actor,
  allow,
  authenticated,
  deny,
  definePermissions,
  definePolicy,
  inherit,
  principal,
  resource,
  role,
} from "../../src/index.ts";

const Row = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({ value }),
  },
} as const;

const permissions = definePermissions({
  project: resource(Row, {
    id: "id",
    actions: ["read"],
    relations: { organization: { field: "org_id", memberOf: "organization" } },
  }),
  task: resource(Row, {
    id: "id",
    parent: { field: "project_id", resource: "project" },
    links: { project: { field: "project_id", resource: "project" } },
    restricted: "private",
    actions: ["read"],
  }),
  comment: resource(Row, {
    id: "id",
    links: { task: { field: "task_id", resource: "task" } },
    actions: ["read"],
  }),
  vault: resource(Row, { id: "id", actions: ["read"] }),
  secret: resource(Row, {
    id: "id",
    parent: { field: "vault_id", resource: "vault" },
    actions: ["read"],
  }),
});

const { comment, project, secret, task, vault } = permissions;

const policy = definePolicy(permissions, {
  scopes: { organization: { key: "org_id" } },
  // SAFETY: stream generation never calls the subject mapper.
  subject: (user: unknown) => user as never,
  roles: [role("admin", [allow(project.read)], { on: "organization" })],
  grants: [
    allow(project.read, {
      to: authenticated(),
      where: { owner_id: principal.id },
    }),
    allow(task.read, { to: inherit(project.read, { through: "parent" }) }),
    allow(comment.read, {
      to: inherit(project.read, { through: ["task", "project"] }),
    }),
    allow(vault.read, {
      to: authenticated(),
      where: { tags: { contains: "x" } },
    }),
    allow(secret.read, { to: inherit(vault.read, { through: "parent" }) }),
  ],
});

const config: PermDockConfig = {
  policy: "p.ts",
  rls: {
    authorize: "database",
    memberships: {
      scopes: {
        organization: {
          table: "organization_users",
          user: "user_id",
          role: "role",
          columns: { organization: "organization_id" },
        },
      },
    },
  },
};

const members =
  "SELECT organization_users.organization_id FROM organization_users WHERE organization_users.user_id = auth.user_id() AND organization_users.role IN ('admin')";
const projects = [
  `SELECT project.id FROM project WHERE project.org_id IN (${members})`,
  "SELECT project.id FROM project WHERE project.owner_id = auth.user_id()",
];

describe("powersync streams for inherit() grants", () => {
  const plan = powersyncPlan(policy, config);
  const queries = (name: string): readonly string[] | undefined =>
    plan.streams.find((stream) => stream.name === name)?.queries;

  it("syncs a child row whose parent the user reads, and skips a restricted child", () => {
    expect(queries("task")).toStrictEqual(
      projects.flatMap((ids) => [
        `SELECT * FROM task WHERE task.project_id IN (${ids}) AND task.private IS NULL`,
        `SELECT * FROM task WHERE task.project_id IN (${ids}) AND task.private = false`,
      ]),
    );
  });

  it("nests one subquery per link hop", () => {
    expect(queries("comment")).toStrictEqual(
      projects.map(
        (ids) =>
          `SELECT * FROM comment WHERE comment.task_id IN (SELECT task.id FROM task WHERE task.project_id IN (${ids}))`,
      ),
    );
  });

  it("syncs nothing when the parent's grant has no Sync Streams form", () => {
    expect(queries("secret")).toBeUndefined();
    expect(plan.omitted).toContainEqual({
      resource: "secret",
      reason: "no grant of secret.read compiles",
    });
    expect(plan.warnings).toContain(
      "authenticated/secret.read under-syncs: inherit() of vault.read leaves out authenticated: its condition has no Sync Streams form",
    );
  });
});

describe("powersync streams for inherit() of other parent grants", () => {
  const more = definePermissions({
    doc: resource(Row, { id: "id", actions: ["read"] }),
    note: resource(Row, {
      id: "id",
      parent: { field: "doc_id", resource: "doc" },
      actions: ["read"],
    }),
    locked: resource(Row, { id: "id", actions: ["read"] }),
    pin: resource(Row, {
      id: "id",
      parent: { field: "locked_id", resource: "locked" },
      actions: ["read"],
    }),
  });
  const plan = powersyncPlan(
    definePolicy(more, {
      // SAFETY: stream generation never calls the subject mapper.
      subject: (user: unknown) => user as never,
      grants: [
        allow(more.doc.read, { to: authenticated() }),
        allow(more.note.read, {
          to: inherit(more.doc.read, { through: "parent" }),
        }),
        allow(more.locked.read, { to: authenticated() }),
        deny(more.locked.read, { to: actor("oauth-client") }),
        allow(more.pin.read, {
          to: inherit(more.locked.read, { through: "parent" }),
        }),
      ],
    }),
    { policy: "p.ts" },
  );
  const queries = (name: string): readonly string[] | undefined =>
    plan.streams.find((stream) => stream.name === name)?.queries;

  it("reads every parent row an unconditional grant gives", () => {
    expect(queries("note")).toStrictEqual([
      "SELECT * FROM note WHERE note.doc_id IN (SELECT doc.id FROM doc)",
    ]);
  });

  it("syncs nothing under a parent with a deny grant", () => {
    expect(queries("pin")).toBeUndefined();
  });
});
