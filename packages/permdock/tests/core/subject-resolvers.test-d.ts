import { describe, expectTypeOf, it } from "vitest";

import type {
  BetterAuthLike,
  BetterAuthPrincipal,
  BetterAuthSubjectOptions,
} from "../../src/better-auth/index.ts";
import type {
  ClerkPrincipal,
  ClerkSubjectOptions,
} from "../../src/clerk/index.ts";
import type { CredentialPrincipal, SubjectResolver } from "../../src/index.ts";
import type { JwtPrincipal, JwtSubjectOptions } from "../../src/jwt/index.ts";
import type {
  McpAuthInfo,
  McpPrincipal,
  McpSubjectOptions,
} from "../../src/mcp/index.ts";
import type { ApiKeySubjectOptions } from "../../src/server/index.ts";
import type {
  SupabasePrincipal,
  SupabaseSubjectOptions,
} from "../../src/supabase/index.ts";

import { subjectFromBetterAuth } from "../../src/better-auth/index.ts";
import { subjectFromClerk } from "../../src/clerk/index.ts";
import {
  createJwtSubjectResolver,
  subjectFromJwt,
} from "../../src/jwt/index.ts";
import { subjectFromMcp } from "../../src/mcp/index.ts";
import { subjectFromApiKey } from "../../src/server/index.ts";
import { subjectFromSupabase } from "../../src/supabase/index.ts";

declare const apiKey: ApiKeySubjectOptions;
declare const jwt: JwtSubjectOptions;
declare const supabase: SupabaseSubjectOptions;
declare const clerk: ClerkSubjectOptions;
declare const auth: BetterAuthLike;
declare const betterAuth: BetterAuthSubjectOptions;
declare const mcp: McpSubjectOptions;

type Token = string | undefined | null;

describe("SubjectResolver", () => {
  it("is what subjectFromApiKey returns, tenant argument included", () => {
    expectTypeOf(subjectFromApiKey(apiKey)).toExtend<
      SubjectResolver<Token, CredentialPrincipal>
    >();
  });

  it("is what a provider mapper becomes once its options are bound", () => {
    const resolver = createJwtSubjectResolver(jwt);
    expectTypeOf((token: Token) => resolver(token)).toExtend<
      SubjectResolver<Token, JwtPrincipal>
    >();
    expectTypeOf((token: Token) => subjectFromJwt(token, jwt)).toExtend<
      SubjectResolver<Token, JwtPrincipal>
    >();
    expectTypeOf((claims: unknown) =>
      subjectFromSupabase(claims, supabase),
    ).toExtend<SubjectResolver<unknown, SupabasePrincipal>>();
    expectTypeOf((object: unknown) => subjectFromClerk(object, clerk)).toExtend<
      SubjectResolver<unknown, ClerkPrincipal>
    >();
    expectTypeOf((session: unknown) =>
      subjectFromBetterAuth(auth, session, betterAuth),
    ).toExtend<SubjectResolver<unknown, BetterAuthPrincipal>>();
    expectTypeOf((info: McpAuthInfo | undefined) =>
      subjectFromMcp(info, mcp),
    ).toExtend<SubjectResolver<McpAuthInfo | undefined, McpPrincipal>>();
  });

  it("is not createJwtSubjectResolver's own shape, whose second argument is the Request", () => {
    expectTypeOf(createJwtSubjectResolver(jwt)).not.toExtend<
      SubjectResolver<Token, JwtPrincipal>
    >();
  });
});
