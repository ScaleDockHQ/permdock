import type { StandardSchemaV1 } from "@standard-schema/spec";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { DecisionSink } from "../../src/core/interfaces.ts";

import {
  onRoleChange,
  rolesFromAccessControl,
  subjectFromBetterAuth,
} from "../../src/better-auth/index.ts";
import { permissions } from "../fixtures/quick-start.ts";

const user = { id: "u1", role: "member" };

describe("subjectFromBetterAuth edge cases", () => {
  it("is anonymous for a session-only record or a non-object user", async () => {
    const subjects = await Promise.all([
      subjectFromBetterAuth({}, { session: { id: "s1" } }),
      subjectFromBetterAuth({}, { user: "u1", session: { id: "s1" } }),
      subjectFromBetterAuth({}, { user: { id: "" } }),
    ]);
    expect(subjects.map((subject) => subject.principal)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("drops claims an async or non-object schema returns", async () => {
    const asyncSchema = z
      .object({ plan: z.string() })
      .transform(async (v) => v);
    const scalar: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => ({ value: "scalar" }),
      },
    };
    const results = [];
    for (const schema of [asyncSchema, scalar]) {
      const subject = await subjectFromBetterAuth(
        {},
        { user: { ...user, plan: "pro" } },
        { schema },
      );
      results.push(subject.principal?.claims);
    }
    expect(results).toEqual([undefined, undefined]);
  });

  it("lists organizations, skips malformed rows and falls back on failure", async () => {
    const queried: (string | undefined)[] = [];
    const auth = {
      api: {
        listOrganizations: async () => [
          { id: "acme" },
          { id: "" },
          { name: "no id" },
          "row",
          { id: "acme" },
        ],
        listMembers: async (args?: {
          readonly query?: { readonly organizationId?: string };
        }) => {
          queried.push(args?.query?.organizationId);
          return [{ userId: "u1", organizationId: "acme", role: "admin" }];
        },
      },
    };
    const listed = await subjectFromBetterAuth(auth, { user });
    const notArray = await subjectFromBetterAuth(
      { api: { listOrganizations: async () => ({ organizations: [] }) } },
      { user },
    );
    const noLister = await subjectFromBetterAuth(
      { api: { listOrganizations: async () => [{ id: "acme" }] } },
      { user },
    );
    expect({
      queried,
      listed: listed.principal?.memberships,
      notArray: notArray.principal?.memberships,
      noLister: noLister.principal?.memberships,
    }).toEqual({
      queried: ["acme"],
      listed: [{ tenant: "acme", roles: ["admin"] }],
      notArray: [],
      noLister: [],
    });
  });
});

describe("rolesFromAccessControl and onRoleChange", () => {
  it("reads statements or permissions and reports unmatched actions", () => {
    const seeded = rolesFromAccessControl(
      {
        roles: {
          editor: { statements: { post: ["update", "fly"] } },
          viewer: { permissions: { post: ["read"] } },
        },
      },
      permissions,
      { on: "tenant" },
    );
    expect({
      names: seeded.map((binding) => binding.name),
      unmatched: seeded.unmatched,
    }).toEqual({
      names: ["editor", "viewer"],
      unmatched: [{ role: "editor", resource: "post", action: "fly" }],
    });
  });

  it("writes added, removed and changed events in tenant and team scope", async () => {
    const written: unknown[] = [];
    const sink: DecisionSink = {
      write: async (events) => {
        written.push(...events);
      },
    };
    const notify = onRoleChange(() => undefined, { sink });
    await notify({ userId: "u1", organizationId: "acme", role: "admin" });
    await notify({
      userId: "u1",
      organizationId: "acme",
      teamId: "t1",
      previousRole: "lead",
    });
    await notify({ userId: "u1", role: "admin", previousRole: "member" });
    await notify({ userId: "u1", role: "admin", previousRole: "admin" });
    await notify({ organizationId: "acme", role: "admin" });
    expect(written.length).toBe(4);
    expect(written).toEqual([
      expect.objectContaining({ operation: "added" }),
      expect.objectContaining({ operation: "removed" }),
      expect.objectContaining({ operation: "changed" }),
      expect.objectContaining({ operation: "changed" }),
    ]);
  });
});
