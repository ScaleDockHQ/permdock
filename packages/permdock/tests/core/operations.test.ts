import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineOperations } from "../../src/core/operations.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";

const Invoice = z.object({ id: z.string(), total: z.number() });

const permissions = definePermissions({
  invoice: resource(Invoice, {
    id: "id",
    actions: ["read", "send", "refund"],
    collection: ["list", "create"],
  }),
});

const other = definePermissions({
  invoice: resource(Invoice, { id: "id", actions: ["read"] }),
  report: resource(z.object({ id: z.string() }), {
    id: "id",
    actions: ["read"],
  }),
});

describe("defineOperations", () => {
  it("returns a frozen map of frozen operations named by their key", () => {
    const data = z.object({ id: z.string() });
    const operations = defineOperations(permissions, {
      sendInvoice: {
        permission: permissions.invoice.send,
        data,
        meta: { risk: "medium", effects: ["send", "external"], title: "Send" },
      },
      listInvoices: {
        permission: permissions.invoice.list,
        results: permissions.invoice.read,
      },
    });

    expect(Object.isFrozen(operations)).toBe(true);
    expect(Object.keys(operations)).toEqual(["sendInvoice", "listInvoices"]);
    const send = operations.sendInvoice;
    expect(Object.isFrozen(send)).toBe(true);
    expect(send.name).toBe("sendInvoice");
    expect(send.permission).toBe(permissions.invoice.send);
    expect(send.data).toBe(data);
    expect(send.meta).toEqual({
      risk: "medium",
      effects: ["send", "external"],
      title: "Send",
    });
    expect(Object.isFrozen(send.meta)).toBe(true);
    expect(Object.isFrozen(send.meta.effects)).toBe(true);
    expect("results" in send).toBe(false);

    const list = operations.listInvoices;
    expect(list.results).toBe(permissions.invoice.read);
    expect(list.meta).toEqual({});
    expect(Object.isFrozen(list.meta)).toBe(true);
    expect("data" in list).toBe(false);
  });

  it("copies meta, so a later change to the input does not reach it", () => {
    const effects: ("read" | "write")[] = ["read"];
    const operations = defineOperations(permissions, {
      readInvoice: { permission: permissions.invoice.read, meta: { effects } },
    });
    effects.push("write");
    expect(operations.readInvoice.meta.effects).toEqual(["read"]);
  });

  it("accepts a leaf of the tree that crossed JSON, matched by key", () => {
    const leaf: unknown = JSON.parse(JSON.stringify(permissions.invoice.read));
    const operations = defineOperations(permissions, {
      // SAFETY: a parsed leaf keeps key, scope, resource, action and meta.
      readInvoice: { permission: leaf as typeof permissions.invoice.read },
    });
    expect(operations.readInvoice.permission).toEqual(permissions.invoice.read);
  });

  it("throws for a permission or results leaf outside the tree", () => {
    expect(() =>
      defineOperations(permissions, {
        readReport: { permission: other.report.read },
      }),
    ).toThrow(/readReport.*report\.read/u);
    expect(() =>
      defineOperations(permissions, {
        listInvoices: {
          permission: permissions.invoice.list,
          results: other.report.read,
        },
      }),
    ).toThrow(/listInvoices.*results/u);
    expect(() =>
      defineOperations(permissions, {
        // SAFETY: deliberately not a permission, to reach the runtime check.
        bad: {
          permission:
            "invoice.read" as unknown as typeof permissions.invoice.read,
        },
      }),
    ).toThrow(TypeError);
  });

  it("throws for an empty, invalid or case-duplicated name", () => {
    expect(() =>
      defineOperations(permissions, {
        "": { permission: permissions.invoice.read },
      }),
    ).toThrow(/name/u);
    expect(() =>
      defineOperations(permissions, {
        "send invoice": { permission: permissions.invoice.send },
      }),
    ).toThrow(/name/u);
    expect(() =>
      defineOperations(permissions, {
        sendInvoice: { permission: permissions.invoice.send },
        SendInvoice: { permission: permissions.invoice.send },
      }),
    ).toThrow(/duplicate/u);
    expect(() =>
      defineOperations(permissions, {
        [`a${"b".repeat(128)}`]: { permission: permissions.invoice.send },
      }),
    ).toThrow(/name/u);
    const polluted: unknown = JSON.parse(
      '{"__proto__":{"permission":{"key":"invoice.read","scope":"invoice:read","resource":"invoice","action":"read","meta":{}}}}',
    );
    // SAFETY: a parsed definition object with an own __proto__ key.
    expect(() => defineOperations(permissions, polluted as never)).toThrow(
      /name/u,
    );
  });

  it("throws for meta outside the closed lists", () => {
    const bad = (meta: unknown) => () =>
      defineOperations(permissions, {
        // SAFETY: deliberately invalid meta, to reach the runtime check.
        op: { permission: permissions.invoice.read, meta: meta as never },
      });
    expect(bad({ risk: "extreme" })).toThrow(/risk/u);
    expect(bad({ effects: ["read", "mine"] })).toThrow(/effects/u);
    expect(bad({ effects: "read" })).toThrow(/effects/u);
    expect(bad({ effects: ["read", "read"] })).toThrow(/effects/u);
    expect(bad({ title: "" })).toThrow(/title/u);
    expect(bad({ title: 3 })).toThrow(/title/u);
    expect(bad({ colour: "red" })).toThrow(/colour/u);
    expect(bad([])).toThrow(/meta/u);
  });

  it("throws for a data value that is not a Standard Schema", () => {
    expect(() =>
      defineOperations(permissions, {
        // SAFETY: deliberately not a schema, to reach the runtime check.
        op: { permission: permissions.invoice.read, data: {} as never },
      }),
    ).toThrow(/data/u);
  });

  it("throws for a definition that is not an object, and ignores inherited keys", () => {
    expect(() =>
      // SAFETY: deliberately invalid, to reach the runtime check.
      defineOperations(permissions, { op: null as never }),
    ).toThrow(TypeError);
    const definitions: Record<string, unknown> = Object.create({
      inherited: { permission: permissions.invoice.read },
    });
    definitions["own"] = { permission: permissions.invoice.read };
    // SAFETY: a record of operation definitions with one inherited key.
    const operations = defineOperations(permissions, definitions as never);
    expect(Object.keys(operations)).toEqual(["own"]);
  });
});
