import { describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";

import { powersyncPlan } from "../../src/cli/powersync/streams.ts";
import { powersyncYaml } from "../../src/cli/powersync/yaml.ts";
import {
  actor,
  allow,
  authenticated,
  definePermissions,
  definePolicy,
  deny,
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
  job: resource(Row, {
    id: "id",
    actions: ["read"],
    relations: { organization: { field: "org_id", memberOf: "organization" } },
  }),
  secret: resource(Row, { id: "id", actions: ["read"] }),
});

const { job, secret } = permissions;

const policy = definePolicy(permissions, {
  scopes: { organization: { key: "org_id" } },
  // SAFETY: stream generation never calls the subject mapper.
  subject: (user: unknown) => user as never,
  roles: [role("tech", [allow(job.read)], { on: "organization" })],
  grants: [
    allow(secret.read, { to: authenticated() }),
    deny(secret.read, { to: actor("oauth-client") }),
  ],
});

const memberships: PermDockConfig["rls"] = {
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
};

function plan(tables: NonNullable<PermDockConfig["powersync"]>["tables"]) {
  return powersyncPlan(policy, {
    policy: "p.ts",
    rls: memberships,
    powersync: { tables },
  });
}

const jobs =
  "SELECT jobs.id FROM jobs WHERE jobs.org_id IN (SELECT organization_users.organization_id FROM organization_users WHERE organization_users.user_id = auth.user_id() AND organization_users.role IN ('tech'))";

describe("powersync.tables", () => {
  it("streams the user's own rows of a table and marks the stream as the user's", () => {
    const result = plan({ notification_recipients: { user: "user_id" } });
    expect(result.tables).toStrictEqual([
      {
        name: "notification_recipients",
        table: "notification_recipients",
        user: "user_id",
        queries: [
          "SELECT * FROM notification_recipients WHERE notification_recipients.user_id = auth.user_id()",
        ],
      },
    ]);
    expect(powersyncYaml(result)).toContain("  notification_recipients:\n");
  });

  it("streams the rows that point at a resource row the user reads, with a match per resource", () => {
    const result = powersyncPlan(policy, {
      policy: "p.ts",
      rls: { ...memberships, tables: { job: "jobs" } },
      powersync: {
        tables: {
          "files.attachments": {
            user: "uploaded_by",
            follow: [
              {
                resource: "job",
                field: "subject_id",
                match: { subject_type: "job" },
              },
            ],
          },
        },
      },
    });
    expect(result.tables).toStrictEqual([
      {
        name: "attachments",
        table: "attachments",
        queries: [
          'SELECT * FROM "files"."attachments" AS attachments WHERE attachments.uploaded_by = auth.user_id()',
          `SELECT * FROM "files"."attachments" AS attachments WHERE attachments.subject_id IN (${jobs}) AND attachments.subject_type = 'job'`,
        ],
      },
    ]);
    expect(result.outside).toContain("files.attachments");
  });

  it("leaves out the rows of a resource whose read permission has a deny grant", () => {
    const result = plan({
      notes: { follow: [{ resource: "secret", field: "secret_id" }] },
    });
    expect(result.tables).toStrictEqual([]);
    expect(result.warnings).toContain(
      "notes does not sync the rows of secret: no grant of its read permission compiles, or it has a deny grant",
    );
    expect(result.omitted).toContainEqual({
      resource: "notes",
      reason: "no query compiles",
    });
  });

  it("refuses a column that is not an identifier and a name a resource stream holds", () => {
    const result = plan({
      notes: { user: "user id" },
      job: { user: "user_id" },
    });
    expect(result.tables).toStrictEqual([]);
    expect(result.omitted).toStrictEqual(
      expect.arrayContaining([
        { resource: "notes", reason: "user id is not a column name" },
        { resource: "job", reason: "a resource stream is named job" },
      ]),
    );
  });
});
