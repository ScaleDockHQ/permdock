import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { PermDock } from "../../src/core/permdock.ts";
import type { VocabularyOf } from "../../src/core/type-helpers.ts";

import { definePermDock } from "../../src/better-supabase/index.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";

const permissions = definePermissions({
  post: resource({ actions: ["read"] }),
});
const policy = definePolicy(permissions, {
  roles: [role("member", [allow(permissions.post.read)])],
  subject: (user: { id: string; roles: string[] } | null) => user,
});

type Vocabulary = VocabularyOf<typeof policy>;

describe(definePermDock, () => {
  it("owns a version cache per definition and loads the client once", async () => {
    let calls = 0;
    const first = definePermDock(policy, {
      client: () => {
        calls += 1;
        return { id: "admin" };
      },
    });
    const second = definePermDock(policy);
    expect(calls).toBe(0);
    expect(await first.client()).toStrictEqual({ id: "admin" });
    expect(await first.client()).toStrictEqual({ id: "admin" });
    expect(calls).toBe(1);
    expect(first.next().versions).not.toBe(second.next().versions);
    expect(() => second.client()).toThrow(/client option/u);
  });

  it("builds an instance from claims, a subject and a permission map", async () => {
    const app = definePermDock(policy, {
      claims: { id: "user.id", roles: "user.roles" },
    });
    const granted = await app.fromClaims({
      user: { id: "u1", roles: ["member"] },
    });
    expect(granted.can(permissions.post.read, { id: "p1" })).toBe(true);
    const server = await app.server({
      subject: granted.subject,
      tenant: "org-1",
      operations: { read: "post.read" },
    });
    expect(server.can(permissions.post.read, { id: "p1" })).toBe(true);
    const states = await app.getPermissions(granted.subject, {
      read: [permissions.post.read, { id: "p1" }],
    });
    expect(states.read?.allowed).toBe(true);
    const gate = app.authorizer();
    expect(gate).toMatchObject({ apiVersion: 1 });
    const next = app.next();
    expect(next.authorization).toBe(next.authorizer);
    expect(next.versions).toBe(app.next().versions);
  });

  it("types every instance member as PermDock of the policy vocabulary", () => {
    const app = definePermDock(policy);
    expectTypeOf<
      Awaited<ReturnType<(typeof app)["getPermDock"]>>
    >().toEqualTypeOf<PermDock<Vocabulary>>();
    expectTypeOf<
      Awaited<ReturnType<(typeof app)["fromClaims"]>>
    >().toEqualTypeOf<PermDock<Vocabulary>>();
    expectTypeOf<
      Awaited<ReturnType<(typeof app)["fromApiKey"]>>
    >().toEqualTypeOf<PermDock<Vocabulary>>();
    expectTypeOf<Awaited<ReturnType<(typeof app)["server"]>>>().toEqualTypeOf<
      PermDock<Vocabulary>
    >();
  });

  it("keeps no module-level mutable state in either definition entry", () => {
    // Invariant 7: one Fluid Compute instance serves concurrent requests, so a
    // module-level Map, Set, WeakMap or `let` would leak one subject into the next.
    for (const file of [
      "../../src/better-supabase/define-permdock.ts",
      "../../src/app/define-permdock.ts",
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(
        /^(?:const|let|var)\s+\w+(?::[^=]+)?=\s*new\s+(?:Weak)?(?:Map|Set)\b/mu,
      );
      expect(source).not.toMatch(/^let\s/mu);
    }
  });
});
