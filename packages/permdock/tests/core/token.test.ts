import { describe, expect, it } from "vitest";
import { z } from "zod";

import { sha256Digest } from "../../src/core/sha256.ts";
import {
  decisionToken,
  payloadDigest,
  tokenPayload,
  versionOf,
} from "../../src/core/token.ts";
import {
  allow,
  createPermDock,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";

describe("decisionToken", () => {
  it("is a sha-256: digest and stable for the same inputs", () => {
    const input = {
      key: "post.update",
      resourceId: "p1",
      principal: { id: "u1", roles: ["member"] as const },
      actor: undefined,
      fingerprint: "fp",
    };
    const token = decisionToken(input);
    expect(token).toMatch(/^sha-256:[\w-]{43}$/u);
    expect(token).toBe(
      sha256Digest(
        '{"actor":null,"fingerprint":"fp","key":"post.update","principal":{"id":"u1","issuer":null,"tenant":null},"resourceId":"p1"}',
      ),
    );
    expect(decisionToken(input)).toBe(token);
    expect(
      decisionToken({
        ...input,
        principal: { id: "u1", roles: ["member"], binding: { kid: "k" } },
      }),
    ).toBe(token);
  });
});

describe("versionOf", () => {
  it.each([
    [null, null],
    ["row", null],
    [{}, null],
    [{ version: "v3" }, "v3"],
    [{ version: 3 }, "3"],
    [{ version: 3n }, "3"],
    [{ version: false }, "false"],
    [{ version: new Date(0) }, "1970-01-01T00:00:00.000Z"],
    [{ version: new Date("invalid") }, null],
    [{ version: { nested: 1 } }, null],
    [Object.create({ version: "inherited" }), null],
  ])("reads %o as %o", (row, expected) => {
    expect(versionOf(row, "version")).toBe(expected);
  });
});

describe("payloadDigest", () => {
  it("is the sha-256: digest of the RFC 8785 JSON", () => {
    expect(payloadDigest({ b: [1.5, "x"], a: null })).toBe(
      sha256Digest('{"a":null,"b":[1.5,"x"]}'),
    );
  });

  it("is stable across key order and differs across values", () => {
    expect(payloadDigest({ a: 1, b: 2 })).toBe(payloadDigest({ b: 2, a: 1 }));
    expect(payloadDigest({ a: 1 })).not.toBe(payloadDigest({ a: 2 }));
  });
});

describe("tokenPayload", () => {
  it("binds the args when given, for a row or a collection", () => {
    expect(tokenPayload("p1", { id: "p1" }, { to: "a" })).toBe(
      payloadDigest({ to: "a" }),
    );
    expect(tokenPayload("*", { amount: 1 }, { to: "a" })).toBe(
      payloadDigest({ to: "a" }),
    );
  });

  it("binds a collection call's data without args, and nothing for a row", () => {
    expect(tokenPayload("*", { amount: 1 }, undefined)).toBe(
      payloadDigest({ amount: 1 }),
    );
    expect(tokenPayload("*", undefined, undefined)).toBeUndefined();
    expect(tokenPayload("p1", { id: "p1" }, undefined)).toBeUndefined();
  });
});

describe("decide with args", () => {
  it("gives an approval-required token per argument set", async () => {
    const permissions = definePermissions({
      email: resource(z.object({ id: z.string() }), {
        id: "id",
        collection: ["send"],
      }),
    });
    const policy = definePolicy(permissions, {
      roles: [
        role("member", [allow(permissions.email.send, { approval: "human" })]),
      ],
      subject: (user: { readonly id: string } | null) =>
        user === null ? null : { id: user.id, roles: ["member"] },
    });
    const permdock = await createPermDock(policy, { id: "u1" });
    const tokenOf = (args: unknown): string | undefined => {
      const decision = permdock.decide(
        permissions.email.send,
        undefined,
        args === undefined ? {} : { args },
      );
      return decision.outcome === "approval-required"
        ? decision.token
        : undefined;
    };
    const a = tokenOf({ to: "a" });
    expect(a).toBeDefined();
    expect(tokenOf({ to: "a" })).toBe(a);
    expect(tokenOf({ to: "b" })).not.toBe(a);
    expect(tokenOf(undefined)).not.toBe(a);
  });
});
