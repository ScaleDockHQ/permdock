import { describe, expect, it } from "vitest";

import { opaque } from "../../src/conditions/opaque.ts";
import {
  PermDockDeniedError,
  PermDockValidationError,
} from "../../src/core/errors.ts";
import { allow } from "../../src/core/grant-builders.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";
import { tree } from "../fixtures/org-tree.ts";

describe("validation edges", () => {
  it("fails closed on throwing closures, opaque conditions and invalid or async-validated rows", async () => {
    const schemaPolicy = definePolicy(tree, {
      roles: [
        role("member", [
          allow(tree.post.read, () => {
            throw new Error("closure");
          }),
          allow(tree.post.create, { check: { authorId: "u1" } }),
          allow(tree.post.update, {
            where: opaque({ sql: "1=1", fingerprint: "x" }),
          }),
        ]),
      ],
      subject: () => ({ id: "u1", roles: ["member"] }),
      validate: "never",
    });
    const permdock = getPermDockSync(schemaPolicy, { id: "u1" });
    const closed = permdock.decide(tree.post.read, { id: "p1" });
    expect(closed.outcome).toBe("denied");
    expect(permdock.where(tree.post.read).partial).toBe(true);
    expect(permdock.can(tree.post.create)).toBe(false);
    const opaqueDecision = permdock.decide(tree.post.update, {
      id: "p1",
      authorId: "u1",
    });
    expect(opaqueDecision.outcome).toBe("denied");

    const withSchema = definePermissions({
      post: resource(
        {
          "~standard": {
            version: 1 as const,
            vendor: "test",
            validate: (value: unknown) =>
              typeof value === "object" &&
              value !== null &&
              "id" in value &&
              typeof value.id === "string"
                ? { value }
                : { issues: [{ message: "required", path: [{ key: "id" }] }] },
          },
        },
        { actions: ["read"] },
      ),
    });
    const schemaed = definePolicy(withSchema, {
      roles: [role("member", [allow(withSchema.post.read)])],
      subject: () => ({ id: "u1", roles: ["member"] }),
      validate: "always",
    });
    const validating = getPermDockSync(schemaed, { id: "u1" });
    expect(
      validating.decide(withSchema.post.read, { id: 1 }, { trusted: false })
        .outcome,
    ).toBe("denied");
    expect(() =>
      validating.assert(withSchema.post.read, { id: 1 }, { trusted: false }),
    ).toThrow(PermDockValidationError);
    expect(
      validating.can(withSchema.post.read, { id: 1 }, { trusted: false }),
    ).toBe(false);
    expect(validating.can(withSchema.post.read, { id: "p1" })).toBe(true);
    expect(() =>
      validating.assert(
        withSchema.post.read,
        { id: "p1" },
        { trusted: false, onDenied: () => undefined },
      ),
    ).not.toThrow();
    const noGrant = definePolicy(withSchema, {
      roles: [role("member", [allow(withSchema.post.read)])],
      subject: () => ({ id: "u1", roles: [] }),
    });
    const empty = getPermDockSync(noGrant, { id: "u1", roles: [] });
    expect(() => empty.assert(withSchema.post.read, { id: "p1" })).toThrow(
      PermDockDeniedError,
    );

    const asyncSchema = definePermissions({
      post: resource(
        {
          "~standard": {
            version: 1 as const,
            vendor: "test",
            validate: () => Promise.resolve({ value: { id: "p1" } }),
          },
        },
        { actions: ["read"] },
      ),
    });
    const asyncPolicy = definePolicy(asyncSchema, {
      roles: [role("member", [allow(asyncSchema.post.read)])],
      subject: () => ({ id: "u1", roles: ["member"] }),
      validate: "always",
    });
    const asyncPermdock = getPermDockSync(asyncPolicy, { id: "u1" });
    expect(
      asyncPermdock.can(
        asyncSchema.post.read,
        { id: "p1" },
        { trusted: false },
      ),
    ).toBe(false);
  });

  it("skips validation for a resource without a schema", async () => {
    const noSchema = getPermDockSync(
      definePolicy(tree, {
        roles: [role("member", [allow(tree.post.read)])],
        subject: () => ({ id: "u1", roles: ["member"] }),
        validate: "boundary",
      }),
      { id: "u1" },
    );
    expect(noSchema.can(tree.post.read, { id: "p1" }, { trusted: false })).toBe(
      true,
    );
  });
});
