import { describe, expect, it } from "vitest";

import type { SupabaseRpcClient } from "../../src/supabase/index.ts";

import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";
import {
  definePermDock,
  subjectFromSupabaseClient,
} from "../../src/supabase/index.ts";

const permissions = definePermissions({
  post: resource({ actions: ["read"] }),
});
const policy = definePolicy(permissions, {
  roles: [role("member", [allow(permissions.post.read)])],
  subject: (user: { id: string; roles: string[] } | null) => user,
});

const claims = { sub: "u1", role: "authenticated", user_role: "member" };
const options = { claims: { roles: "user_role" } } as const;

function fakeClient(calls: string[]): SupabaseRpcClient {
  return {
    schema(name) {
      return {
        async rpc(fn) {
          calls.push(`${name}.${fn}`);
          return { data: null, error: null };
        },
      };
    },
  };
}

describe(definePermDock, () => {
  it("maps verified claims through subject options", async () => {
    const app = definePermDock(policy, { subject: options });
    const permdock = await app.fromClaims(claims);
    expect(permdock.can(permissions.post.read, {})).toBe(true);
    expect((await app.fromClaims(null)).can(permissions.post.read, {})).toBe(
      false,
    );
  });

  it("never reads user_metadata", async () => {
    const app = definePermDock(policy, { subject: options });
    const permdock = await app.fromClaims({
      sub: "u1",
      user_metadata: { user_role: "member" },
    });
    expect(permdock.can(permissions.post.read, {})).toBe(false);
  });

  it("loads the client once and owns its caches", async () => {
    let loads = 0;
    const calls: string[] = [];
    const first = definePermDock(policy, {
      client: () => {
        loads += 1;
        return fakeClient(calls);
      },
    });
    expect(loads).toBe(0);
    await first.client();
    await first.client();
    expect(loads).toBe(1);
    expect(() => definePermDock(policy).client()).toThrow(/client option/u);
  });

  it("checks a token's authz_ver against the database instead of trusting it", async () => {
    const calls: string[] = [];
    const app = definePermDock(policy, {
      subject: options,
      client: () => fakeClient(calls),
    });
    const permdock = await app.fromClaims({ ...claims, authz_ver: 9 });
    permdock.can(permissions.post.read, {});
    expect(calls).toContain("permdock.authz_version_for");
  });

  it("answers a permission map and denies all for a failing build", async () => {
    const app = definePermDock(policy, { subject: options });
    const map = await app.getPermissions(claims, {
      read: permissions.post.read,
    });
    expect(map.read.allowed).toBe(true);
  });

  it("reads a session through getClaims, never getSession", async () => {
    const client = {
      auth: {
        getClaims: async () => ({ data: { claims }, error: null }),
        getSession: () => {
          throw new Error("getSession must not be called");
        },
      },
    };
    const subject = await subjectFromSupabaseClient(client, options);
    expect(subject.principal?.id).toBe("u1");
    const app = definePermDock(policy, { subject: options });
    expect((await app.fromClient(client)).can(permissions.post.read, {})).toBe(
      true,
    );
  });

  it("is anonymous on an error or a throwing client", async () => {
    const failing = {
      auth: { getClaims: async () => ({ data: null, error: new Error("x") }) },
    };
    const throwing = {
      auth: {
        getClaims: (): never => {
          throw new Error("boom");
        },
      },
    };
    expect((await subjectFromSupabaseClient(failing)).principal).toBeNull();
    expect((await subjectFromSupabaseClient(throwing)).principal).toBeNull();
  });
});
