import { describe, expectTypeOf, it } from "vitest";

import type { PolicyVocabulary } from "../../src/core/policy-types.ts";
import type {
  OperationNameOf,
  PermDock,
  Permission,
  PermissionOf,
  PlanNameOf,
  ScopeNameOf,
  VocabularyOf,
} from "../../src/index.ts";
import type { ClientPermDock } from "../../src/react/index.ts";
import type { policy as scopedPolicy } from "../fixtures/named-scopes.ts";
import type { plans, policy, roles } from "../fixtures/vocabulary.ts";

import {
  defineOperations,
  definePermissions,
  definePolicy,
  resource,
} from "../../src/index.ts";
import { usePermDock } from "../../src/react/index.ts";
import { permissions } from "../fixtures/quick-start.ts";

describe("type helpers", () => {
  it("names the leaves of a tree with PermissionOf", () => {
    expectTypeOf<PermissionOf<typeof permissions>>().toEqualTypeOf<
      (typeof permissions.post)[keyof typeof permissions.post]
    >();
    expectTypeOf<PermissionOf<typeof permissions>>().toExtend<Permission>();
    expectTypeOf(permissions.post.read).toExtend<
      PermissionOf<typeof permissions>
    >();
  });

  it("names a policy's scopes, plans and vocabulary", () => {
    expectTypeOf<ScopeNameOf<typeof scopedPolicy>>().toEqualTypeOf<
      "organization" | "customer" | "tenant" | "team"
    >();
    expectTypeOf<PlanNameOf<typeof policy>>().toEqualTypeOf<"pro">();
    expectTypeOf<VocabularyOf<typeof policy>>().toEqualTypeOf<{
      readonly permissions: typeof permissions;
      readonly roles: typeof roles;
      readonly plans: typeof plans;
    }>();
    expectTypeOf<
      PermDock<VocabularyOf<typeof policy>>["roles"]
    >().toEqualTypeOf<typeof roles>();
  });

  it("types usePermDock from the policy without a hand-written vocabulary", () => {
    function Component(): null {
      const permdock = usePermDock<VocabularyOf<typeof policy>>();
      expectTypeOf(permdock).toEqualTypeOf<
        ClientPermDock<VocabularyOf<typeof policy>>
      >();
      return null;
    }
    void Component;
  });

  it("names a map's operations with OperationNameOf", () => {
    const tree = definePermissions({
      invoice: resource({ actions: ["read", "send"] }),
    });
    const operations = defineOperations(tree, {
      sendInvoice: { permission: tree.invoice.send },
      readInvoice: { permission: tree.invoice.read },
    });
    expectTypeOf<OperationNameOf<typeof operations>>().toEqualTypeOf<
      "sendInvoice" | "readInvoice"
    >();
  });

  it("falls back to string and PolicyVocabulary for untyped input", () => {
    const loose = definePolicy(
      definePermissions({ doc: resource({ actions: ["read"] }) }),
      { roles: [], subject: () => null },
    );
    expectTypeOf<PlanNameOf<typeof loose>>().toEqualTypeOf<string>();
    expectTypeOf<PlanNameOf<unknown>>().toEqualTypeOf<string>();
    expectTypeOf<OperationNameOf<unknown>>().toEqualTypeOf<string>();
    expectTypeOf<VocabularyOf<unknown>>().toEqualTypeOf<PolicyVocabulary>();
    expectTypeOf<ScopeNameOf<unknown>>().toEqualTypeOf<string>();
  });
});
