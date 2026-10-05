import { supabaseClaimFixtures } from "better-supabase/testing";
import { subjectFromSupabase, supabaseClaims } from "permdock/supabase";
import { describe, expect, it } from "vitest";

const NOW = Math.floor(Date.now() / 1000);

const IDENTITY_SCOPES = new Set([
  "openid",
  "profile",
  "email",
  "address",
  "phone",
  "offline_access",
]);

function delegatedScopes(
  scopes: readonly string[] | undefined,
): readonly string[] | undefined {
  const kept = scopes?.filter((scope) => !IDENTITY_SCOPES.has(scope)) ?? [];
  return kept.length === 0 ? undefined : kept;
}

describe("better-supabase claim fixtures", () => {
  for (const [name, fixture] of Object.entries(supabaseClaimFixtures)) {
    const claims = { ...fixture.claims, iat: NOW, exp: NOW + 3600 };

    it(`${name} passes supabaseClaims()`, async () => {
      const result = await supabaseClaims()["~standard"].validate(claims);
      expect(result.issues).toBeUndefined();
    });

    it(`${name} maps to the actor better-supabase reads`, () => {
      const subject = subjectFromSupabase(claims);
      const { actor, delegation } = fixture.expect;
      expect(subject.principal).not.toBeNull();
      expect(subject.actor).toMatchObject({ id: actor.id, kind: actor.kind });
      if (actor.kind === "support") {
        expect(subject.actor).toMatchObject({
          sessionId: actor.sessionId,
          readOnly: actor.readOnly,
        });
      }
      expect(subject.delegation?.scopes).toEqual(
        delegatedScopes(delegation?.scopes),
      );
    });
  }
});
