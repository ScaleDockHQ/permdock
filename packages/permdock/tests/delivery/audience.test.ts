import { describe, expect, it } from "vitest";

import { createPermDock } from "../../src/core/permdock.ts";
import { audience, subscribersFor } from "../../src/delivery/index.ts";
import {
  deliveryPermissions as p,
  deliveryPolicy,
  deliveryPrincipals,
  invoice,
  sender,
} from "../fixtures/delivery.ts";

describe("audience", () => {
  it("lists the holders whoCan finds that decideFor grants", async () => {
    const permdock = await sender();
    const found = await audience(permdock, p.invoice.read, invoice);
    expect(found.principals.toSorted()).toEqual(["u_1", "u_2"]);
    expect(typeof found.complete).toBe("boolean");
  });

  it("keeps only the candidates decideFor grants, in their order", async () => {
    const permdock = await sender();
    const found = await audience(permdock, p.invoice.read, invoice, {
      candidates: ["c_1", "u_3", "u_2", "u_4", "nobody", "u_2"],
    });
    expect(found).toEqual({ principals: ["c_1", "u_2"], complete: true });
  });

  it("narrows to the holders of a stronger permission", async () => {
    const permdock = await sender();
    const found = await audience(permdock, p.invoice.pay, invoice);
    expect(found.principals).toEqual(["u_1"]);
  });

  it("is empty for an anonymous sender", async () => {
    const anonymous = createPermDock(deliveryPolicy, null, {
      principals: deliveryPrincipals,
    });
    expect(
      await audience(anonymous, p.invoice.read, invoice, {
        candidates: ["u_2"],
      }),
    ).toEqual({ principals: [], complete: true });
  });
});

describe("subscribersFor", () => {
  it("keeps the subscribers whose principal is granted the event's permission", async () => {
    const permdock = await sender();
    const subscribers = [
      { id: "s1", principal: "u_2", url: "https://a.test/hook" },
      { id: "s2", principal: "u_3", url: "https://b.test/hook" },
      { id: "s3", principal: "u_1", url: "https://c.test/hook" },
    ];
    const kept = await subscribersFor(
      permdock,
      { permission: p.invoice.read, row: invoice },
      subscribers,
    );
    expect(kept.map((entry) => entry.id)).toEqual(["s1", "s3"]);
    expect(kept[0]).toBe(subscribers[0]);
  });

  it("drops a subscriber without a string principal", async () => {
    const permdock = await sender();
    const kept = await subscribersFor(
      permdock,
      { permission: p.invoice.read, row: invoice },
      // SAFETY: a malformed subscriber row, as a database could return it.
      [{ principal: 42 } as unknown as { principal: string }],
    );
    expect(kept).toEqual([]);
  });
});
