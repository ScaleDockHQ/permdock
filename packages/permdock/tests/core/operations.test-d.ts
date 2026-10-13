import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";

import type {
  Operation,
  OperationInput,
  OperationMap,
} from "../../src/index.ts";

import { defineOperations } from "../../src/core/operations.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";

const permissions = definePermissions({
  invoice: resource(z.object({ id: z.string() }), {
    id: "id",
    actions: ["read", "send"],
  }),
});

const operations = defineOperations(permissions, {
  sendInvoice: {
    permission: permissions.invoice.send,
    data: z.object({ id: z.string(), note: z.string().optional() }),
    meta: { risk: "medium", effects: ["send"] },
  },
  readInvoice: { permission: permissions.invoice.read },
});

describe("defineOperations types", () => {
  it("types each entry by name, permission and data output", () => {
    expectTypeOf(operations.sendInvoice.name).toEqualTypeOf<"sendInvoice">();
    expectTypeOf(operations.sendInvoice.permission).toEqualTypeOf<
      typeof permissions.invoice.send
    >();
    expectTypeOf<
      OperationInput<typeof operations.sendInvoice>
    >().toEqualTypeOf<{
      id: string;
      note?: string | undefined;
    }>();
    expectTypeOf<
      OperationInput<typeof operations.readInvoice>
    >().toEqualTypeOf<undefined>();
    expectTypeOf(operations).toExtend<OperationMap>();
    expectTypeOf(operations.sendInvoice).toExtend<Operation>();
  });

  it("rejects meta outside the closed lists and unknown names", () => {
    defineOperations(permissions, {
      // @ts-expect-error -- not an OperationRisk
      a: { permission: permissions.invoice.read, meta: { risk: "extreme" } },
    });
    defineOperations(permissions, {
      // @ts-expect-error -- not an OperationEffect
      b: { permission: permissions.invoice.read, meta: { effects: ["mine"] } },
    });
    // @ts-expect-error -- no such operation
    void operations.deleteInvoice;
  });

  it("accepts a typed operation where an Operation<TInput> is expected", () => {
    const run = <TInput>(operation: Operation<TInput>, input: TInput) =>
      [operation, input] as const;
    run(operations.sendInvoice, { id: "i_1" });
    // @ts-expect-error -- id must be a string
    run(operations.sendInvoice, { id: 1 });
  });
});
