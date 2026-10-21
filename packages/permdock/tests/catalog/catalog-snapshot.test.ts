import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { ScanResult } from "../../src/cli/types.ts";

import { policyFromCatalog, pushedPolicy } from "../../src/catalog/index.ts";
import { buildCatalog } from "../../src/cli/catalog-doc.ts";
import {
  allow,
  definePermissions,
  definePlans,
  definePolicy,
  getPermDockSync,
  hostedPolicies,
  memoryPolicySource,
  parsePolicyDocument,
  resource,
  role,
} from "../../src/index.ts";

const scan: ScanResult = {
  roots: [],
  definitionFiles: {},
  usages: {},
  unknown: [],
  dynamic: [],
  roleNames: [],
  planNames: ["pro"],
  allowKeys: [],
  snapshots: [],
  unparsed: [],
};

const permissions = definePermissions({
  doc: resource(z.object({ id: z.string(), ownerId: z.string() }), {
    id: "id",
    actions: ["read", "update", "export"],
  }),
});

const policy = definePolicy(
  { permissions, plans: definePlans({ pro: {} }) },
  {
    roles: [
      role("member", [
        allow(permissions.doc.read),
        allow(permissions.doc.update, () => true),
      ]),
    ],
    subject: (user: { id: string; roles: string[]; plans?: string[] }) => user,
    hostable: [permissions.doc.export],
  },
);

describe("snapshot on an instance built from a catalog", () => {
  it("lists the code grants and the merged hosted grants the subject reaches", () => {
    const catalog = JSON.parse(
      JSON.stringify(
        buildCatalog(policy.permissions, scan, "2026-10-01T00:00:00Z", policy),
      ),
    );
    const rebuilt = policyFromCatalog(
      catalog,
      JSON.parse(JSON.stringify(pushedPolicy(policy))),
    );
    const document = parsePolicyDocument({
      v: 1,
      id: "doc_1",
      fingerprint: "fp_1",
      catalog: catalog.fingerprint ?? "",
      issuedAt: "2026-10-01T00:00:00Z",
      grants: [
        {
          id: "g1",
          permission: "doc.export",
          to: { kind: "plan", plan: "pro" },
        },
      ],
    });
    const snapshot = getPermDockSync(
      rebuilt,
      { id: "u1", roles: ["member"], plans: ["pro"] },
      { policies: hostedPolicies(memoryPolicySource(document)) },
    ).snapshot();
    const listed = snapshot.grants.map((grant) => [
      grant.permission,
      grant.portable ?? true,
    ]);
    expect(listed).toStrictEqual(
      expect.arrayContaining([
        ["doc.read", true],
        ["doc.export", true],
      ]),
    );
    const update = snapshot.grants.find(
      (grant) => grant.permission === "doc.update",
    );
    expect(update === undefined || update.portable === false).toBe(true);
  });
});
