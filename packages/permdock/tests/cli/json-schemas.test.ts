import { Ajv2020 } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type {
  ApprovalRequest,
  ApprovalStore,
} from "../../src/approvals/index.ts";

import { memoryApprovalStore } from "../../src/approvals/index.ts";
import { APPROVAL_REQUEST_SCHEMA } from "../../src/cli/approval-schema.ts";
import { PERMDOCK_CLAIMS_SCHEMA } from "../../src/cli/claims-schema.ts";
import { testApprovalStore } from "../../src/testing/index.ts";

function schemaFile(name: string): Readonly<Record<string, unknown>> {
  return JSON.parse(
    readFileSync(new URL(`../../schemas/${name}`, import.meta.url), "utf8"),
  );
}

const ajv = new Ajv2020({ strict: true, allErrors: true });
const isRequest = ajv.compile(APPROVAL_REQUEST_SCHEMA);
const seen: unknown[] = [];

function checked<T>(value: T): T {
  for (const item of Array.isArray(value) ? value : [value]) {
    if (item !== null && item !== undefined) {
      seen.push(item);
      expect(isRequest(item) ? [] : isRequest.errors).toEqual([]);
    }
  }
  return value;
}

const inner = memoryApprovalStore();
const validated: ApprovalStore = {
  create: (request) => inner.create(checked(request)),
  get: async (token) => checked(await inner.get(token)),
  resolve: async (token, verdict) =>
    checked(await inner.resolve(token, verdict)),
  consume: async (token, now) => checked(await inner.consume(token, now)),
  list: async (query) => {
    const page = await inner.list(query);
    checked(page.items);
    return page;
  },
  expire: (now) => inner.expire(now),
  cancel: (filter, meta) => inner.cancel?.(filter, meta) ?? 0,
};

const REQUEST: ApprovalRequest = {
  v: 1,
  token: "t1",
  permission: "invoice.void",
  scope: "invoice:void",
  resource: { type: "invoice", id: "inv_1" },
  subject: { principal: { id: "u1", roles: ["member"], tenant: "org_1" } },
  detail: "void invoice inv_1",
  createdAt: "2026-10-06T09:00:00Z",
  expiresAt: "2026-10-06T10:00:00.123Z",
  status: "pending",
};

describe("schemas/approval-request-v1.json", () => {
  it("is the schema rls.jsonSchema inlines", () => {
    expect(schemaFile("approval-request-v1.json")).toEqual(
      APPROVAL_REQUEST_SCHEMA,
    );
  });

  describe("accepts every request an approval store holds", () => {
    testApprovalStore(validated);
    it("saw requests", () => {
      expect(seen.length).toBeGreaterThan(10);
    });
  });

  it.each<[string, Readonly<Record<string, unknown>>]>([
    ["a missing token", { token: undefined }],
    ["an empty permission", { permission: "" }],
    ["v 2", { v: 2 }],
    ["an unknown status", { status: "open" }],
    ["an expiresAt Postgres cannot cast", { expiresAt: "tomorrow" }],
    ["a principal without roles", { subject: { principal: { id: "u1" } } }],
    [
      "an approval without at",
      { status: "approved", approvals: [{ by: "u2" }] },
    ],
  ])("rejects %s", (_name, change) => {
    expect(
      isRequest(JSON.parse(JSON.stringify({ ...REQUEST, ...change }))),
    ).toBe(false);
  });
});

describe("the claims supabase.hook.validate inlines", () => {
  it("are the permdockClaims and membership definitions of supabase-claims-v1.json", () => {
    const defs = schemaFile("supabase-claims-v1.json")["$defs"];
    if (typeof defs !== "object" || defs === null) {
      throw new Error("supabase-claims-v1.json has no $defs");
    }
    expect(PERMDOCK_CLAIMS_SCHEMA["$defs"]).toEqual({
      permdockClaims: Reflect.get(defs, "permdockClaims"),
      membership: Reflect.get(defs, "membership"),
    });
  });

  it("accept the hook's claims and reject a bad membership", () => {
    const isClaims = new Ajv2020({ strictRequired: false }).compile(
      PERMDOCK_CLAIMS_SCHEMA,
    );
    const membership = { scope: "organization", id: "o1", roles: ["admin"] };
    expect(
      isClaims({
        sub: "u1",
        roles: [],
        memberships: [membership],
        authz_ver: 2,
      }),
    ).toBe(true);
    expect(isClaims({ memberships: [{ ...membership, roles: [] }] })).toBe(
      false,
    );
  });
});
