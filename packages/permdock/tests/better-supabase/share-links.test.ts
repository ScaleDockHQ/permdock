import { Temporal } from "temporal-polyfill";
import { describe, expect, it, vi } from "vitest";

import type { AuthEvent } from "../../src/core/event-types.ts";
import type { Subject } from "../../src/core/subject.ts";

import {
  type ShareLinkResolver,
  type ShareLinkRow,
  type ShareLinkSubjectOptions,
  subjectFromShareLink,
} from "../../src/better-supabase/index.ts";
import { allow } from "../../src/core/grant-builders.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";
import { exchangeCapability } from "../../src/supabase/index.ts";

const permissions = definePermissions({
  quote: resource({ actions: ["read", "accept", "update"] }),
});

const policy = definePolicy(
  { permissions },
  {
    subject: (user: Subject) => user.principal,
    roles: [
      role("guest", [allow(permissions.quote.read)], { on: permissions.quote }),
      role(
        "signer",
        [allow(permissions.quote.read), allow(permissions.quote.accept)],
        { on: permissions.quote },
      ),
    ],
  },
);

const NOW = Temporal.Instant.from("2026-10-16T12:00:00Z");
const nowSeconds = NOW.epochMilliseconds / 1000;

const row: ShareLinkRow = {
  id: "lnk_1",
  organizationId: "org_1",
  subjectType: "quotes",
  subjectId: "q_1",
  role: "view",
};

function resolver(
  result: Awaited<ReturnType<ShareLinkResolver["resolve"]>>,
): ShareLinkResolver {
  return {
    resolve: vi.fn<ShareLinkResolver["resolve"]>(() => Promise.resolve(result)),
  };
}

function options(
  overrides: Partial<ShareLinkSubjectOptions> = {},
): ShareLinkSubjectOptions {
  return {
    shareLinks: resolver({ ok: true, data: row }),
    links: {
      quotes: {
        resource: permissions.quote,
        roles: { view: ["guest"], edit: ["signer"] },
      },
    },
    now: NOW,
    ...overrides,
  };
}

function permdockFor(subject: Subject) {
  const permdock = createPermDock(policy, subject);
  if (permdock instanceof Promise) {
    throw new TypeError("expected a synchronous instance");
  }
  return permdock;
}

describe("subjectFromShareLink", () => {
  it("builds a link subject holding the mapped roles on the row's subject", async () => {
    const subject = await subjectFromShareLink("tok", options());
    expect(subject.principal).toMatchObject({
      id: "lnk_1",
      kind: "link",
      capability: {
        holder: "link",
        on: { resource: "quote", id: "q_1" },
        roles: ["guest"],
        expiresAt: nowSeconds + 300,
      },
    });
    const permdock = permdockFor(subject);
    const granted = (
      permission: (typeof permissions.quote)["read" | "accept"],
      id: string,
    ) =>
      permdock.decide(permission, { id }, { now: NOW }).outcome === "granted";
    expect(granted(permissions.quote.read, "q_1")).toBe(true);
    expect(granted(permissions.quote.read, "q_2")).toBe(false);
    expect(granted(permissions.quote.accept, "q_1")).toBe(false);
  });

  it("caps the subject at the link's own expiry and at 3600 seconds", async () => {
    const soon = await subjectFromShareLink(
      "tok",
      options({
        shareLinks: resolver({
          ok: true,
          data: { ...row, expiresAt: NOW.add({ seconds: 60 }) },
        }),
      }),
    );
    expect(soon.expiresAt).toBe(nowSeconds + 60);
    const long = await subjectFromShareLink("tok", options({ ttl: 86_400 }));
    expect(long.expiresAt).toBe(nowSeconds + 3600);
  });

  it("is a subject exchangeCapability accepts", async () => {
    const subject = await subjectFromShareLink(
      "tok",
      options({ now: Temporal.Now.instant() }),
    );
    const token = await exchangeCapability(subject, {
      key: { secret: "s".repeat(32) },
      alg: "HS256",
    });
    expect(token).toBeTypeOf("string");
  });

  it("is anonymous for a missing, unknown or expired token", async () => {
    const onAuth = vi.fn<(event: AuthEvent) => void>();
    expect((await subjectFromShareLink(undefined, options())).principal).toBe(
      null,
    );
    expect((await subjectFromShareLink("", options())).principal).toBe(null);
    const unknown = await subjectFromShareLink(
      "tok",
      options({ shareLinks: resolver({ ok: true, data: null }), onAuth }),
    );
    expect(unknown.principal).toBe(null);
    const expired = await subjectFromShareLink(
      "tok",
      options({
        shareLinks: resolver({
          ok: true,
          data: { ...row, expiresAt: NOW.subtract({ seconds: 1 }) },
        }),
        onAuth,
      }),
    );
    expect(expired.principal).toBe(null);
    expect(onAuth.mock.calls.map(([event]) => event.cause)).toEqual([
      "share-link-unknown",
      "expired",
    ]);
  });

  it("is anonymous for an unknown subject type or role", async () => {
    const onAuth = vi.fn<(event: AuthEvent) => void>();
    const type = await subjectFromShareLink(
      "tok",
      options({
        shareLinks: resolver({
          ok: true,
          data: { ...row, subjectType: "__proto__" },
        }),
        onAuth,
      }),
    );
    const unknownRole = await subjectFromShareLink(
      "tok",
      options({
        shareLinks: resolver({ ok: true, data: { ...row, role: "comment" } }),
        onAuth,
      }),
    );
    expect(type.principal).toBe(null);
    expect(unknownRole.principal).toBe(null);
    expect(onAuth.mock.calls.map(([event]) => event.reason)).toEqual([
      "invalid-token",
      "unknown-role",
    ]);
  });

  it("is anonymous when resolve fails, throws or returns a malformed row", async () => {
    const onAuth = vi.fn<(event: AuthEvent) => void>();
    const failed = await subjectFromShareLink(
      "tok",
      options({ shareLinks: resolver({ ok: false }), onAuth }),
    );
    const threw = await subjectFromShareLink(
      "tok",
      options({
        shareLinks: { resolve: () => Promise.reject(new Error("down")) },
        onAuth,
      }),
    );
    const malformed = await subjectFromShareLink(
      "tok",
      options({
        shareLinks: resolver({
          ok: true,
          // SAFETY: a row from an older or broken resolver, missing organizationId.
          data: {
            ...row,
            organizationId: undefined,
          } as unknown as ShareLinkRow,
        }),
        onAuth,
      }),
    );
    expect([failed, threw, malformed].map((s) => s.principal)).toEqual([
      null,
      null,
      null,
    ]);
    expect(onAuth.mock.calls.map(([event]) => event.reason)).toEqual([
      "source-threw",
      "source-threw",
      "schema",
    ]);
  });

  it("applies the organization's link policy, and a lifetime rule fails closed", async () => {
    const linkPolicy = vi.fn<
      NonNullable<ShareLinkSubjectOptions["linkPolicy"]>
    >(() => ({ redeemers: ["anyone"] }));
    const allowed = await subjectFromShareLink("tok", options({ linkPolicy }));
    expect(allowed.principal?.kind).toBe("link");
    expect(linkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "lnk_1" }),
      row,
    );
    const lifetime = await subjectFromShareLink(
      "tok",
      options({ linkPolicy: () => ({ maxLifetime: 86_400 }) }),
    );
    expect(lifetime.principal).toBe(null);
    const threw = await subjectFromShareLink(
      "tok",
      options({
        linkPolicy: () => {
          throw new Error("policy store down");
        },
      }),
    );
    expect(threw.principal).toBe(null);
  });

  it("reads the row on every call, so revocation is live", async () => {
    const resolve = vi
      .fn<ShareLinkResolver["resolve"]>()
      .mockResolvedValueOnce({ ok: true, data: row })
      .mockResolvedValueOnce({ ok: true, data: null });
    const shareLinks = { resolve };
    expect(
      (await subjectFromShareLink("tok", options({ shareLinks }))).principal,
    ).not.toBe(null);
    expect(
      (await subjectFromShareLink("tok", options({ shareLinks }))).principal,
    ).toBe(null);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
