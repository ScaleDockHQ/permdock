import type {
  CredentialProvider,
  CredentialRef,
  CredentialSubject,
} from "better-supabase/credentials";

import { AsyncResult, dbError, ok } from "better-supabase";
import { testCredentialProvider } from "better-supabase/testing";
import { describe, expect, it } from "vitest";

import type { PermDock } from "../../src/core/permdock.ts";
import type { Subject } from "../../src/core/subject.ts";

import { credentialGuard } from "../../src/better-supabase/index.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import { allow, definePolicy, role } from "../../src/core/policy.ts";

const permissions = definePermissions({
  integration: resource({ actions: ["use", "revoke"] }),
});
const { integration } = permissions;
const policy = definePolicy(
  { permissions },
  {
    subject: (user: Subject) => user.principal,
    roles: [role("member", [allow(integration.use)])],
  },
);

const dock = (roles: readonly string[]): PermDock => {
  const instance = createPermDock(policy, {
    principal: { id: "u_1", kind: "user", roles: [...roles] },
    context: {},
  });
  if (instance instanceof Promise) throw new TypeError("expected sync");
  return instance;
};

const slot = (ref: CredentialRef, subject: CredentialSubject): string =>
  JSON.stringify([
    ref["name"],
    ref.tenant ?? null,
    subject.type === "user" ? subject.id : "app",
  ]);

function memoryProvider(): {
  readonly provider: CredentialProvider;
  readonly seed: (
    ref: CredentialRef,
    subject: CredentialSubject,
    value: string,
  ) => Promise<void>;
} {
  const stored = new Map<string, string>();
  const provider: CredentialProvider = {
    apiVersion: 1,
    name: "memory",
    getToken: (ref, options) => {
      if (ref.provider !== "memory") {
        return AsyncResult.err(dbError("invalid_input", "Not a memory ref"));
      }
      const token = stored.get(slot(ref, options.subject));
      return token === undefined
        ? AsyncResult.err(dbError("not_found", "No credential"))
        : AsyncResult.from(async () =>
            ok({ token, headers: { authorization: `Bearer ${token}` } }),
          );
    },
    capabilities: () => ({
      userSubjects: true,
      authorization: false,
      revoke: true,
      inbound: false,
    }),
    revoke: (ref, options) =>
      AsyncResult.from(async () =>
        ok(stored.delete(slot(ref, options.subject))),
      ),
  };
  return {
    provider,
    seed: async (ref, subject, value) => {
      stored.set(slot(ref, subject), value);
    },
  };
}

const ref = { provider: "memory", name: "github" } as const;

describe("credentialGuard", () => {
  it("passes better-supabase's credential kit when PermDock grants", async () => {
    const { provider, seed } = memoryProvider();
    const guarded = credentialGuard(provider, {
      permdock: () => dock(["member"]),
      use: integration.use,
      revoke: integration.use,
    });
    await expect(
      testCredentialProvider(guarded, {
        ref,
        seed,
        userRef: { provider: "memory", name: "github-user" },
      }),
    ).resolves.toBeDefined();
  });

  it("guards the authorization flow and passes inbound checks through", async () => {
    const { provider } = memoryProvider();
    const oauth: CredentialProvider = {
      ...provider,
      startAuthorization: () =>
        AsyncResult.from(async () => ok({ url: "https://example.test/auth" })),
      completeAuthorization: () => AsyncResult.from(async () => ok(undefined)),
      verifyInbound: () => AsyncResult.from(async () => ok(true)),
    };
    const subject = { type: "user", id: "u_1" } as const;
    const granted = credentialGuard(oauth, {
      permdock: () => dock(["member"]),
      use: integration.use,
    });
    expect(granted.capabilities(ref)).toMatchObject({ revoke: true });
    expect(
      await granted.startAuthorization?.(ref, {
        subject,
        redirectUri: "https://app.test/callback",
      }),
    ).toMatchObject({ ok: true, data: { url: "https://example.test/auth" } });
    expect(
      await granted.completeAuthorization?.(ref, {
        subject,
        callback: "https://app.test/callback?code=c",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await granted.verifyInbound?.(new Request("https://app.test/hook"), ref),
    ).toMatchObject({ ok: true, data: true });
    const denied = credentialGuard(oauth, {
      permdock: () => dock([]),
      use: integration.use,
    });
    expect(
      await denied.completeAuthorization?.(ref, {
        subject,
        callback: "https://app.test/callback?code=c",
      }),
    ).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(
      credentialGuard(provider, {
        permdock: () => dock(["member"]),
        use: integration.use,
      }),
    ).not.toHaveProperty("startAuthorization");
  });

  it("refuses with forbidden when PermDock denies or the check fails", async () => {
    const { provider, seed } = memoryProvider();
    await seed(ref, { type: "app" }, "secret");
    const denied = credentialGuard(provider, {
      permdock: () => dock([]),
      use: integration.use,
    });
    const result = await denied.getToken(ref, { subject: { type: "app" } });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "forbidden", hint: "PERMDOCK_DENIED" },
    });
    const revoking = credentialGuard(provider, {
      permdock: () => dock(["member"]),
      use: integration.use,
      revoke: integration.revoke,
    });
    expect(
      await revoking.revoke(ref, { subject: { type: "app" } }),
    ).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    const failing = credentialGuard(provider, {
      permdock: () => Promise.reject(new Error("down")),
      use: integration.use,
    });
    expect(
      await failing.getToken(ref, { subject: { type: "app" } }),
    ).toMatchObject({ ok: false, error: { kind: "forbidden" } });
  });
});
