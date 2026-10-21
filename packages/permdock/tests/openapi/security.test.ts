import { describe, expect, it } from "vitest";

import { listPermissions } from "../../src/index.ts";
import {
  createPermDock,
  permissionsExtension,
  securityFor,
} from "../../src/openapi/index.ts";
import { createPermDock as createServerPermDock } from "../../src/server/index.ts";
import { permissions, policy } from "../fixtures/quick-start.ts";

const scheme = { name: "oauth2", type: "oauth2" } as const;

describe(securityFor, () => {
  it("matches the policy-backed emitter for every permission that is not public", () => {
    const emitter = createPermDock(policy, { scheme });
    for (const leaf of listPermissions(permissions)) {
      const described = emitter.describe(leaf);
      expect(securityFor(leaf)).toStrictEqual({
        security: described.security,
        "x-permdock-permissions": described["x-permdock-permissions"],
      });
    }
  });

  it("security: false emits only x-permdock-permissions", () => {
    const list = [permissions.post.update, permissions.post.publish];
    const bare = securityFor(list, { security: false });
    expect(bare).toStrictEqual({
      "x-permdock-permissions": ["post.update", "post.publish"],
    });
    expect(Object.keys(bare)).toStrictEqual(["x-permdock-permissions"]);
    expect(Object.isFrozen(bare)).toBe(true);
  });

  it("matches the emitter for a list, all-of and any-of", () => {
    const emitter = createPermDock(policy, { scheme });
    const list = [permissions.post.update, permissions.post.publish];
    expect(securityFor(list).security).toStrictEqual(emitter.security(list));
    expect(securityFor(list, { anyOf: true }).security).toStrictEqual(
      emitter.security(list, { anyOf: true }),
    );
    expect(securityFor(list, { anyOf: true }).security).toStrictEqual([
      { oauth2: ["post:update"] },
      { oauth2: ["post:publish"] },
    ]);
  });

  it("matches the server adapters' openapi.security", () => {
    const { openapi } = createServerPermDock(policy, { subject: () => null });
    for (const leaf of listPermissions(permissions)) {
      expect(securityFor(leaf)).toStrictEqual(openapi.security(leaf));
    }
  });

  it("names the scheme it is given", () => {
    expect(
      securityFor(permissions.post.delete, { scheme: "bearer" }).security,
    ).toStrictEqual([{ bearer: ["post:delete"] }]);
  });

  it("still requires the scheme for an empty list", () => {
    expect(securityFor([]).security).toStrictEqual([{ oauth2: [] }]);
    expect(securityFor([], { anyOf: true }).security).toStrictEqual([
      { oauth2: [] },
    ]);
  });

  it("returns frozen output", () => {
    const result = securityFor(permissions.post.read);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result["x-permdock-permissions"])).toBe(true);
  });
});

describe(permissionsExtension, () => {
  it("lists the keys in order", () => {
    expect(permissionsExtension(permissions.post.read)).toStrictEqual([
      "post.read",
    ]);
    expect(
      permissionsExtension([permissions.post.update, permissions.post.list]),
    ).toStrictEqual(["post.update", "post.list"]);
  });
});
