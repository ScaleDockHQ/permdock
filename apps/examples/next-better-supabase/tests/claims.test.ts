import { createServer } from "better-supabase/server";
import { createTestSigner } from "better-supabase/testing";
import { subjectFromBetterSupabase } from "permdock/better-supabase";
import { supabaseClaimFixtures } from "permdock/testing";
import { describe, expect, expectTypeOf, it } from "vitest";

import { betterSupabase } from "../src/lib/supabase/index.ts";

const PROJECT_URL = "https://abcdefghijklmnopqrst.supabase.co";
const signer = await createTestSigner();
const server = createServer(betterSupabase, {
  env: {
    url: PROJECT_URL,
    publishableKey: "sb_publishable_test",
    jwksUrl: new URL(`${PROJECT_URL}/auth/v1/.well-known/jwks.json`),
  },
  auth: { jwks: { keys: [...signer.jwks.keys] } },
});

const sessionFor = async (claims: Readonly<Record<string, unknown>>) => {
  const { iat: _iat, exp: _exp, iss: _iss, sub, ...rest } = claims;
  const jwt = await signer.sign({ ...rest, sub: String(sub) });
  return (
    await server.context(
      new Request("https://api.test/", {
        headers: { authorization: `Bearer ${jwt}` },
      }),
    )
  ).auth;
};

const { full, portalContact } = supabaseClaimFixtures;

describe("PermDock's claims through betterSupabase.claims()", () => {
  it("keeps PermDock's claims and adds the app's", async () => {
    const session = await sessionFor(full.claims);
    expect(session.kind).toBe("user");
    if (session.kind !== "user") return;
    expect(session.claims.memberships).toHaveLength(3);
    expect(session.claims.tenant_id).toBe(full.claims["tenant_id"]);
    expect(session.claims.datetime_preferences).toEqual({
      timezone: "Europe/Amsterdam",
      week_start: "monday",
      date_format: "dd-MM-yyyy",
      time_format: "24h",
    });
    expect(session.claims.authz_ver).toBe(7);
    expectTypeOf(session.claims.datetime_preferences).toEqualTypeOf<
      | {
          timezone: string;
          week_start: "monday" | "sunday";
          date_format: string;
          time_format: "12h" | "24h";
        }
      | undefined
    >();
    expect(subjectFromBetterSupabase(session).principal).toMatchObject(
      full.expect,
    );
  });

  it("reads a portal contact's customer membership", async () => {
    const session = await sessionFor(portalContact.claims);
    expect(session.kind === "user" && session.claims.memberships).toEqual(
      portalContact.claims["memberships"],
    );
  });

  it("rejects claims either schema rejects", async () => {
    expect(
      await sessionFor({
        ...full.claims,
        datetime_preferences: { timezone: "UTC", week_start: "tuesday" },
      }),
    ).toMatchObject({ kind: "invalid", reason: "claims" });
    expect(
      await sessionFor({ ...portalContact.claims, memberships: [{}] }),
    ).toMatchObject({ kind: "invalid", reason: "claims" });
  });
});
