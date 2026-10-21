import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";

import type { Capability } from "../../src/core/capability.ts";
import type { TokenSigner } from "../../src/core/interfaces.ts";
import type { Subject } from "../../src/core/subject.ts";

import {
  capabilityFromClaims,
  capabilityOf,
  capabilitySubject,
  linkPolicyViolation,
  parseCapability,
  redeemerAllows,
  signCapability,
} from "../../src/core/capability.ts";
import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { allow } from "../../src/core/grant-builders.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";
import { parseSnapshot } from "../../src/core/snapshot.ts";
import { defined } from "../support/defined.ts";

const JKT = "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I";

const permissions = definePermissions({
  quote: resource({
    actions: ["read", "accept", "update"],
    relations: {
      organization: { field: "organizationId", memberOf: "organization" },
    },
  }),
  folder: resource({ actions: ["read"] }),
  file: resource({
    parent: { field: "folderId", resource: "folder" },
    actions: ["read", "comment", "update"],
  }),
});

const policy = definePolicy(
  { permissions },
  {
    subject: (user: Subject) => user.principal,
    scopes: { organization: { key: "organizationId" } },
    roles: [
      role(
        "guest",
        [
          allow(permissions.quote.read, { where: { status: "sent" } }),
          allow(permissions.quote.accept, { where: { status: "sent" } }),
        ],
        { on: permissions.quote },
      ),
      role(
        "commenter",
        [allow(permissions.file.read), allow(permissions.file.comment)],
        { on: permissions.folder },
      ),
      role(
        "admin",
        [allow(permissions.quote.update), allow(permissions.quote.read)],
        { on: "organization" },
      ),
    ],
  },
);

const HOUR = 3600;
const future = (): number => Math.floor(Date.now() / 1000) + HOUR;

function permdockFor(capability: Capability) {
  const permdock = getPermDockSync(policy, capabilitySubject(capability));
  if (permdock instanceof Promise) {
    throw new TypeError("expected a synchronous instance");
  }
  return permdock;
}

const quoteQ = { id: "q_1", organizationId: "o_1", status: "sent" };
const quoteOther = { id: "q_2", organizationId: "o_1", status: "sent" };
const draftQ = { id: "q_1", organizationId: "o_1", status: "draft" };

describe("capabilities", () => {
  it("lets a quote link read and accept quote Q only", () => {
    const permdock = permdockFor(
      capabilityOf({
        id: "lnk_1",
        on: { resource: permissions.quote, id: "q_1" },
        roles: ["guest"],
        expiresAt: future(),
      }),
    );
    expect(permdock.can(permissions.quote.read, quoteQ)).toBe(true);
    expect(permdock.can(permissions.quote.accept, quoteQ)).toBe(true);
    expect(permdock.can(permissions.quote.read, quoteOther)).toBe(false);
    expect(permdock.can(permissions.quote.read, draftQ)).toBe(false);
    expect(permdock.can(permissions.quote.update, quoteQ)).toBe(false);
    expect(permdock.can(permissions.quote.read, undefined)).toBe(false);
  });

  it("narrows the role to the listed permissions", () => {
    const permdock = permdockFor(
      capabilityOf({
        id: "lnk_2",
        on: { resource: permissions.quote, id: "q_1" },
        roles: ["guest"],
        permissions: [permissions.quote.read],
        expiresAt: future(),
      }),
    );
    expect(permdock.can(permissions.quote.read, quoteQ)).toBe(true);
    const accept = permdock.decide(permissions.quote.accept, quoteQ);
    expect(accept.outcome).toBe("denied");
    expect(
      accept.outcome === "denied" &&
        accept.denials.some((denial) => denial.reason === "not-delegated"),
    ).toBe(true);
  });

  it("reaches a child file through a folder link, never a sibling", () => {
    const permdock = permdockFor(
      capabilityOf({
        id: "lnk_3",
        on: { resource: permissions.folder, id: "f_1" },
        roles: ["commenter"],
        expiresAt: future(),
      }),
    );
    expect(
      permdock.can(permissions.file.comment, { id: "x_1", folderId: "f_1" }),
    ).toBe(true);
    expect(
      permdock.can(permissions.file.read, { id: "x_2", folderId: "f_2" }),
    ).toBe(false);
    expect(
      permdock.can(permissions.file.update, { id: "x_1", folderId: "f_1" }),
    ).toBe(false);
    expect(permdock.where(permissions.file.read).condition).toStrictEqual({
      op: "eq",
      field: "folderId",
      value: "f_1",
    });
  });

  it("never exercises a scope role, even one named in the capability", () => {
    const permdock = permdockFor(
      capabilityOf({
        id: "lnk_4",
        on: { resource: permissions.quote, id: "q_1" },
        roles: ["admin"],
        expiresAt: future(),
      }),
    );
    expect(permdock.can(permissions.quote.update, quoteQ)).toBe(false);
    expect(permdock.can(permissions.quote.read, quoteQ)).toBe(false);
  });

  it("denies once the capability expires", () => {
    const permdock = permdockFor(
      capabilityOf({
        id: "lnk_5",
        on: { resource: permissions.quote, id: "q_1" },
        roles: ["guest"],
        expiresAt: Math.floor(Date.now() / 1000) - 1,
      }),
    );
    expect(permdock.can(permissions.quote.read, quoteQ)).toBe(false);
  });

  it("agrees with a client built from its snapshot", () => {
    const permdock = permdockFor(
      capabilityOf({
        id: "lnk_6",
        on: { resource: permissions.quote, id: "q_1" },
        roles: ["guest"],
        permissions: [permissions.quote.read],
        expiresAt: future(),
      }),
    );
    const client = fromSnapshot(
      parseSnapshot(JSON.stringify(permdock.snapshot())),
    );
    for (const [permission, row] of [
      [permissions.quote.read, quoteQ],
      [permissions.quote.accept, quoteQ],
      [permissions.quote.read, quoteOther],
      [permissions.quote.read, draftQ],
    ] as const) {
      expect(client.can(permission, row)).toBe(permdock.can(permission, row));
    }
  });

  it("resolves a reserved key holder to the anonymous subject", () => {
    const capability = parseCapability({
      v: 1,
      id: "key_1",
      holder: "key",
      on: { resource: "quote", id: "q_1" },
      roles: ["guest"],
      expiresAt: future(),
    });
    expect(capability).toBeDefined();
    expect(capabilitySubject(defined(capability)).principal).toBeNull();
  });
});

describe(parseCapability, () => {
  const valid = {
    v: 1,
    id: "lnk_1",
    holder: "link",
    on: { resource: "quote", id: "q_1" },
    roles: ["guest"],
    expiresAt: 2_000_000_000,
  };

  it("keeps only v1 fields and freezes the result", () => {
    const parsed = parseCapability({ ...valid, extra: true, once: true });
    expect(parsed).toStrictEqual({ ...valid, once: true });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.on)).toBe(true);
  });

  it.each([
    ["another version", { ...valid, v: 2 }],
    ["an unknown holder", { ...valid, holder: "user" }],
    ["no roles", { ...valid, roles: [] }],
    ["a non-string role", { ...valid, roles: [1] }],
    ["empty permissions", { ...valid, permissions: [] }],
    ["a bad redeemer", { ...valid, redeemer: { user: "u_1", scope: "x" } }],
    ["once: false", { ...valid, once: false }],
    ["a missing expiry", { ...valid, expiresAt: undefined }],
    ["a missing resource id", { ...valid, on: { resource: "quote" } }],
    ["an array", [valid]],
  ])("rejects %s", (_label, value) => {
    expect(parseCapability(value)).toBeUndefined();
  });

  it("never reads inherited properties", () => {
    // SAFETY: Object.create returns an object whose prototype holds the valid fields.
    const inherited = Object.create({ ...valid }) as object;
    expect(parseCapability(inherited)).toBeUndefined();
  });
});

describe(redeemerAllows, () => {
  const member: Subject = {
    principal: {
      id: "u_1",
      memberships: [{ scope: "organization", id: "o_1", roles: ["member"] }],
    },
    context: {},
  };

  it("checks the viewer, never the capability", () => {
    expect(redeemerAllows(undefined, undefined)).toBe(true);
    expect(redeemerAllows("anyone", undefined)).toBe(true);
    expect(redeemerAllows("signed-in", undefined)).toBe(false);
    expect(redeemerAllows("signed-in", member)).toBe(true);
    expect(redeemerAllows({ user: "u_1" }, member)).toBe(true);
    expect(redeemerAllows({ user: "u_2" }, member)).toBe(false);
    expect(redeemerAllows({ scope: "organization", id: "o_1" }, member)).toBe(
      true,
    );
    expect(redeemerAllows({ scope: "organization", id: "o_2" }, member)).toBe(
      false,
    );
  });

  it("never lets one link redeem another", () => {
    const link = capabilitySubject(
      capabilityOf({
        id: "lnk_1",
        on: { resource: permissions.quote, id: "q_1" },
        roles: ["guest"],
        expiresAt: future(),
      }),
    );
    expect(redeemerAllows("signed-in", link)).toBe(false);
  });

  it("ignores an expired scope membership", () => {
    const stale: Subject = {
      principal: {
        id: "u_1",
        memberships: [
          { scope: "organization", id: "o_1", roles: ["member"], expiresAt: 1 },
        ],
      },
      context: {},
    };
    expect(redeemerAllows({ scope: "organization", id: "o_1" }, stale)).toBe(
      false,
    );
  });
});

describe(signCapability, () => {
  it("signs the capability under typ vnd.permdock.capability+jwt", async () => {
    const calls: unknown[] = [];
    const signer: TokenSigner = {
      sign(payload, options) {
        calls.push({ payload, options });
        return Promise.resolve("jws");
      },
    };
    const expiresAt = future();
    await signCapability(
      {
        id: "lnk_1",
        on: { resource: permissions.quote, id: "q_1" },
        roles: ["guest"],
        permissions: [permissions.quote.read],
        once: true,
        expiresAt,
        cnf: { jkt: JKT },
      },
      signer,
      {
        audience: "https://app.example.com",
        issuedAt: Temporal.Instant.fromEpochMilliseconds(
          (expiresAt - 60) * 1000,
        ),
      },
    );
    expect(calls).toStrictEqual([
      {
        payload: {
          sub: "lnk_1",
          capability: {
            v: 1,
            holder: "link",
            on: { resource: "quote", id: "q_1" },
            roles: ["guest"],
            permissions: ["quote.read"],
            once: true,
          },
          cnf: { jkt: JKT },
        },
        options: {
          typ: "vnd.permdock.capability+jwt",
          audience: "https://app.example.com",
          expiresAt,
          issuedAt: expiresAt - 60,
        },
      },
    ]);
  });

  it("rebuilds the capability from verified claims and refuses a malformed cnf", () => {
    const expiresAt = future();
    const claim = {
      v: 1,
      holder: "link",
      on: { resource: "quote", id: "q_1" },
      roles: ["guest"],
    };
    expect(
      capabilityFromClaims({
        capability: claim,
        sub: "lnk_1",
        exp: expiresAt,
        cnf: { jkt: JKT },
      }),
    ).toStrictEqual({ ...claim, id: "lnk_1", expiresAt, cnf: { jkt: JKT } });
    expect(
      capabilityFromClaims({ capability: claim, sub: "lnk_1", exp: expiresAt }),
    ).toStrictEqual({ ...claim, id: "lnk_1", expiresAt });
    expect(
      capabilityFromClaims({
        capability: claim,
        sub: "lnk_1",
        exp: expiresAt,
        cnf: { jkt: "short" },
      }),
    ).toBeUndefined();
    expect(
      capabilityFromClaims({ capability: claim, exp: expiresAt }),
    ).toBeUndefined();
    expect(
      capabilityFromClaims({ capability: claim, sub: "lnk_1" }),
    ).toBeUndefined();
  });

  it("refuses a capability spanning two resources", () => {
    expect(() =>
      capabilityOf({
        id: "lnk_1",
        on: { resource: permissions, id: "q_1" },
        roles: ["guest"],
        expiresAt: future(),
      }),
    ).toThrow(/exactly one resource/u);
  });

  it("refuses an input no resolver would accept", () => {
    expect(() =>
      capabilityOf({
        id: "",
        on: { resource: permissions.quote, id: "q_1" },
        roles: ["guest"],
        expiresAt: future(),
      }),
    ).toThrow(/invalid capability/u);
  });
});

describe(linkPolicyViolation, () => {
  const issuedAt = 1_900_000_000;
  const base = capabilityOf({
    id: "lnk_1",
    on: { resource: permissions.quote, id: "q_1" },
    roles: ["guest"],
    expiresAt: issuedAt + 7 * 86_400,
  });

  it("passes a link inside every policy", () => {
    expect(
      linkPolicyViolation(
        base,
        [{ maxLifetime: 30 * 86_400 }, { redeemers: ["anyone", "user"] }],
        issuedAt,
      ),
    ).toBeUndefined();
  });

  it("refuses a link that outlives the maximum lifetime", () => {
    expect(linkPolicyViolation(base, { maxLifetime: 86_400 }, issuedAt)).toBe(
      "lifetime",
    );
  });

  it("fails closed on an unknown issue time or a malformed maximum", () => {
    expect(
      linkPolicyViolation(base, { maxLifetime: 30 * 86_400 }, undefined),
    ).toBe("lifetime");
    expect(
      linkPolicyViolation(base, { maxLifetime: Number.NaN }, issuedAt),
    ).toBe("lifetime");
    expect(linkPolicyViolation(base, { maxLifetime: -1 }, issuedAt)).toBe(
      "lifetime",
    );
  });

  it("refuses a redeemer kind the policy does not allow", () => {
    expect(
      linkPolicyViolation(base, { redeemers: ["signed-in"] }, issuedAt),
    ).toBe("redeemer");
    expect(linkPolicyViolation(base, { redeemers: [] }, issuedAt)).toBe(
      "redeemer",
    );
    const scoped = { ...base, redeemer: { scope: "organization", id: "o_1" } };
    expect(
      linkPolicyViolation(scoped, { redeemers: ["scope"] }, issuedAt),
    ).toBeUndefined();
  });

  it("requires one-time links when the policy says so", () => {
    expect(linkPolicyViolation(base, { once: true }, issuedAt)).toBe("once");
    expect(
      linkPolicyViolation({ ...base, once: true }, { once: true }, issuedAt),
    ).toBeUndefined();
  });

  it("applies the strictest of several scope policies", () => {
    expect(
      linkPolicyViolation(base, [{}, { maxLifetime: 3600 }], issuedAt),
    ).toBe("lifetime");
  });

  it("refuses to sign a link the policy would refuse", async () => {
    const signer: TokenSigner = { sign: () => Promise.resolve("jws") };
    await expect(
      signCapability(
        {
          id: "lnk_1",
          on: { resource: permissions.quote, id: "q_1" },
          roles: ["guest"],
          expiresAt: future(),
        },
        signer,
        { linkPolicy: { once: true } },
      ),
    ).rejects.toThrow(/link policy \(once\)/u);
    await expect(
      signCapability(
        {
          id: "lnk_1",
          on: { resource: permissions.quote, id: "q_1" },
          roles: ["guest"],
          once: true,
          expiresAt: future(),
        },
        signer,
        { linkPolicy: { once: true, maxLifetime: 2 * HOUR } },
      ),
    ).resolves.toBe("jws");
  });
});
