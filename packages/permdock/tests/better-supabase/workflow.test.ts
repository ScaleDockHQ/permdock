import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  handlerCan,
  hookCan,
  subjectFromBetterSupabase,
} from "../../src/better-supabase/index.ts";
import {
  allow,
  getPermDockSync,
  definePermissions,
  definePolicy,
  defineRoles,
  resource,
  role,
} from "../../src/index.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const USER = "22222222-2222-4222-8222-222222222222";

const Run = z.object({ id: z.string(), organization_id: z.string() });

const permissions = definePermissions({
  run: resource(Run, {
    id: "id",
    actions: [],
    collection: ["approve", "list", "cancel"],
    relations: {
      organization: { field: "organization_id", memberOf: "organization" },
    },
  }),
});
const { run } = permissions;

const roles = defineRoles({ admin: { on: "organization" } });
const policy = definePolicy(
  { permissions, roles },
  {
    scopes: { organization: { key: "organization_id" } },
    // SAFETY: tests always pass a Subject, which this resolver returns unchanged.
    subject: (user: unknown) => user as never,
    roles: [
      role(
        roles.admin,
        [
          allow([run.approve, run.list]),
          allow(run.cancel, { approval: "human" }),
        ],
        { on: "organization" },
      ),
    ],
  },
);

const member = () =>
  getPermDockSync(
    policy,
    subjectFromBetterSupabase({
      kind: "user",
      claims: {
        sub: USER,
        role: "authenticated",
        tenant_id: ORG,
        memberships: [{ scope: "organization", id: ORG, roles: ["admin"] }],
      },
    }),
  );
const anonymous = () =>
  getPermDockSync(policy, subjectFromBetterSupabase(null));

describe(hookCan, () => {
  it("grants a member who holds the permission in the hook's tenant", async () => {
    const can = hookCan(member());
    expect(await can(ORG, run.approve.key)).toBe(true);
  });

  it("refuses another tenant, an unknown key and an anonymous caller", async () => {
    const can = hookCan(member());
    expect(await can(OTHER, run.approve.key)).toBe(false);
    expect(await can(ORG, "run.delete")).toBe(false);
    expect(await can(ORG, "__proto__")).toBe(false);
    expect(await hookCan(anonymous())(ORG, run.approve.key)).toBe(false);
  });

  it("refuses a permission that needs approval", async () => {
    const can = hookCan(member());
    expect(await can(ORG, run.cancel.key)).toBe(false);
  });

  it("accepts a permission's scope as well as its key", async () => {
    const can = hookCan(member());
    expect(await can(ORG, run.approve.scope)).toBe(true);
  });
});

describe(handlerCan, () => {
  const request = new Request("https://app.test/.well-known/workflow/v1/ui");

  it("answers true or false for a signed-in caller", async () => {
    const can = handlerCan({ getPermDock: member });
    expect(await can(request, run.list.key)).toBe(true);
    expect(await can(request, run.cancel.key)).toBe(false);
    expect(await can(request, "run.missing")).toBe(false);
  });

  it("answers undefined without a session or when the instance throws", async () => {
    expect(
      await handlerCan({ getPermDock: anonymous })(request, run.list.key),
    ).toBeUndefined();
    const failing = handlerCan({
      getPermDock: () => Promise.reject(new Error("no session")),
    });
    expect(await failing(request, run.list.key)).toBeUndefined();
  });
});
