import type {
  AuthorizationFunctions,
  AuthorizationMembership,
  AuthorizationPermission,
  AuthorizationProvider,
  AuthorizationTokenHook,
} from "better-supabase/contract";

import { describe, expectTypeOf, it } from "vitest";

import type { PermissionKeyOf } from "../../src/core/type-helpers.ts";
import type { permissions } from "../fixtures/quick-start.ts";

import { authorizationProvider } from "../../src/better-supabase/index.ts";

type RequiredKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? never : K;
}[keyof T];

declare const tree: typeof permissions;

type Provider = ReturnType<typeof authorizationProvider>;
type Suspension = NonNullable<AuthorizationProvider["suspension"]>;

describe(authorizationProvider, () => {
  it("returns better-supabase's AuthorizationProvider", () => {
    expectTypeOf<Provider>().toEqualTypeOf<AuthorizationProvider>();
    expectTypeOf(
      authorizationProvider({ manifest: {}, permissions: tree }),
    ).toEqualTypeOf<
      AuthorizationProvider<PermissionKeyOf<typeof permissions>>
    >();
  });

  it("sets every key the contract requires", () => {
    expectTypeOf<RequiredKeys<Provider>>().toEqualTypeOf<
      RequiredKeys<AuthorizationProvider>
    >();
    expectTypeOf<RequiredKeys<Provider["functions"]>>().toEqualTypeOf<
      RequiredKeys<AuthorizationFunctions>
    >();
    expectTypeOf<RequiredKeys<AuthorizationProvider>>().toEqualTypeOf<
      "apiVersion" | "name" | "scopes" | "tenantScope" | "functions"
    >();
    expectTypeOf<RequiredKeys<AuthorizationFunctions>>().toEqualTypeOf<
      "idsWith" | "isPlatform"
    >();
  });

  it("keeps the 0.58 fields optional", () => {
    expectTypeOf<
      RequiredKeys<
        Pick<
          AuthorizationFunctions,
          | "subjectForTenant"
          | "bootstrapPermissions"
          | "approverFor"
          | "managedUsers"
          | "canIn"
          | "canApprove"
        >
      >
    >().toBeNever();
    expectTypeOf<
      RequiredKeys<
        Pick<
          AuthorizationProvider,
          "approvals" | "personas" | "fixtureRoles" | "wildcards"
        >
      >
    >().toBeNever();
    expectTypeOf<
      RequiredKeys<Pick<AuthorizationMembership, "userKey">>
    >().toBeNever();
    expectTypeOf<RequiredKeys<Pick<Suspension, "userKey">>>().toBeNever();
    expectTypeOf<
      RequiredKeys<Pick<AuthorizationPermission, "levels">>
    >().toBeNever();
    expectTypeOf<
      RequiredKeys<Pick<AuthorizationTokenHook, "teamIdsTruncatedClaim">>
    >().toBeNever();
  });
});
