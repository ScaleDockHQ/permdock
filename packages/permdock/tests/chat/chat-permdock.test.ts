import { describe, expect, it, vi } from "vitest";

import { memoryApprovalStore } from "../../src/approvals/index.ts";
import { createPermDock } from "../../src/chat/index.ts";
import { memoryDecisionSink } from "../../src/index.ts";
import {
  approver,
  billing,
  chatMemberships,
  chatOperations,
  chatPolicy,
  chatPrincipals,
  member,
  stranger,
} from "../fixtures/chat.ts";

function chat(store = memoryApprovalStore()) {
  return {
    store,
    chat: createPermDock(chatPolicy, {
      principals: chatPrincipals,
      memberships: chatMemberships,
      approvals: store,
    }),
  };
}

describe("ChatPermDock.protect", () => {
  it("runs the handler for a granted author with the loaded row", async () => {
    const { chat: permdock } = chat();
    const handler = vi.fn<(context: { readonly row: unknown }) => string>(
      ({ row }) => `shown ${JSON.stringify(row)}`,
    );
    const show = permdock.protect(chatOperations["invoice.show"], handler);
    const result = await show(member, { id: "i1" });
    expect(result).toEqual({
      outcome: "granted",
      value: 'shown {"id":"i1","orgId":"o1"}',
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      author: member,
      input: { id: "i1" },
    });
  });

  it("denies an unlinked author, another tenant's row and a missing row", async () => {
    const { chat: permdock } = chat();
    const handler = vi.fn<() => string>(() => "ran");
    const show = permdock.protect(chatOperations["invoice.show"], handler);
    const unlinked = await show(stranger, { id: "i1" });
    expect(unlinked.outcome).toBe("denied");
    expect(
      unlinked.outcome === "denied" && unlinked.decision.denials[0]?.reason,
    ).toBe("anonymous");
    expect((await show(member, { id: "i2" })).outcome).toBe("denied");
    const missing = await show(member, { id: "nope" });
    expect(
      missing.outcome === "denied" && missing.decision.denials[0]?.reason,
    ).toBe("validation");
    expect((await show(null, { id: "i1" })).outcome).toBe("denied");
    expect(handler).not.toHaveBeenCalled();
  });

  it("denies when the operation's loader throws", async () => {
    const { chat: permdock } = chat();
    const handler = vi.fn<() => string>(() => "ran");
    const run = permdock.protect(
      {
        ...chatOperations["invoice.show"],
        data: () => {
          throw new Error("db down");
        },
      },
      handler,
    );
    expect((await run(member, { id: "i1" })).outcome).toBe("denied");
    expect(handler).not.toHaveBeenCalled();
  });

  it("opens one approval request with a prompt and no token", async () => {
    const { chat: permdock, store } = chat();
    const handler = vi.fn<() => string>(() => "paid");
    const pay = permdock.protect(chatOperations["invoice.pay"], handler);
    const first = await pay(billing, { id: "i1" });
    expect(first.outcome).toBe("approval-required");
    if (first.outcome !== "approval-required" || first.prompt === null) {
      throw new Error("expected a prompt");
    }
    expect(first.prompt).toMatchObject({
      v: 1,
      permission: "invoice.pay",
      resource: { type: "invoice", id: "i1" },
      requester: { principal: { id: "u_1" } },
      operation: { name: "invoice.pay", title: "Pay an invoice", risk: "high" },
    });
    expect(JSON.stringify(first.prompt)).not.toContain(first.decision.token);
    const again = await pay(billing, { id: "i1" });
    expect(again.outcome === "approval-required" && again.prompt?.id).toBe(
      first.prompt.id,
    );
    expect((await store.list({})).items).toHaveLength(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs once after an approver approves through resolveAction", async () => {
    const { chat: permdock } = chat();
    const handler = vi.fn<() => string>(() => "paid");
    const pay = permdock.protect(chatOperations["invoice.pay"], handler);
    const first = await pay(billing, { id: "i1" });
    const id = first.outcome === "approval-required" ? first.prompt?.id : "";
    const resolved = await permdock.resolveAction(approver, {
      approval: id ?? "",
      status: "approved",
    });
    expect(resolved).toEqual({ ok: true, id, status: "approved" });
    expect(await pay(billing, { id: "i1" })).toEqual({
      outcome: "granted",
      value: "paid",
    });
    expect(handler).toHaveBeenCalledOnce();
    const next = await pay(billing, { id: "i1" });
    expect(next.outcome === "denied" && next.decision.denials[0]?.detail).toBe(
      "approval-consumed",
    );
    expect(handler).toHaveBeenCalledOnce();
  });

  it("denies after a rejection", async () => {
    const { chat: permdock } = chat();
    const pay = permdock.protect(chatOperations["invoice.pay"], () => "paid");
    const first = await pay(billing, { id: "i1" });
    const id = first.outcome === "approval-required" ? first.prompt?.id : "";
    await permdock.resolveAction(approver, {
      approval: id ?? "",
      status: "rejected",
    });
    const after = await pay(billing, { id: "i1" });
    expect(after.outcome).toBe("denied");
  });

  it("returns approval-required without a prompt when there is no store", async () => {
    const permdock = createPermDock(chatPolicy, {
      principals: chatPrincipals,
      memberships: chatMemberships,
    });
    const handler = vi.fn<() => string>(() => "paid");
    const pay = permdock.protect(chatOperations["invoice.pay"], handler);
    const result = await pay(billing, { id: "i1" });
    expect(result.outcome === "approval-required" && result.prompt).toBeNull();
    expect(handler).not.toHaveBeenCalled();
  });

  it("writes decision events with adapter chat", async () => {
    const sink = memoryDecisionSink();
    const permdock = createPermDock(chatPolicy, {
      principals: chatPrincipals,
      memberships: chatMemberships,
      sink,
    });
    await permdock.protect(chatOperations["invoice.show"], () => "ok")(member, {
      id: "i1",
    });
    expect(sink.events()).toContainEqual(
      expect.objectContaining({ type: "decision", adapter: "chat" }),
    );
  });
});

describe("ChatPermDock.resolveAction", () => {
  async function opened() {
    const setup = chat();
    const pay = setup.chat.protect(chatOperations["invoice.pay"], () => "paid");
    const first = await pay(billing, { id: "i1" });
    const id =
      first.outcome === "approval-required" ? (first.prompt?.id ?? "") : "";
    return { ...setup, id };
  }

  it("refuses an unlinked author", async () => {
    const { chat: permdock, id } = await opened();
    expect(
      await permdock.resolveAction(stranger, {
        approval: id,
        status: "approved",
      }),
    ).toEqual({ ok: false, cause: "approver-unauthenticated" });
    expect(
      await permdock.resolveAction(null, { approval: id, status: "approved" }),
    ).toEqual({ ok: false, cause: "approver-unauthenticated" });
  });

  it("refuses the requester approving their own request", async () => {
    const { chat: permdock, id } = await opened();
    expect(
      await permdock.resolveAction(billing, {
        approval: id,
        status: "approved",
      }),
    ).toEqual({ ok: false, cause: "approver-is-principal" });
  });

  it("refuses an unknown request id, a bad status and a second verdict", async () => {
    const { chat: permdock, id } = await opened();
    expect(
      await permdock.resolveAction(approver, {
        approval: "apr_missing",
        status: "approved",
      }),
    ).toEqual({ ok: false, cause: "approval-not-found" });
    expect(
      await permdock.resolveAction(approver, {
        approval: id,
        // SAFETY: a status from an untrusted button payload.
        status: "maybe" as never,
      }),
    ).toEqual({ ok: false, cause: "invalid-action" });
    await permdock.resolveAction(approver, {
      approval: id,
      status: "rejected",
    });
    expect(
      await permdock.resolveAction(approver, {
        approval: id,
        status: "approved",
      }),
    ).toEqual({ ok: false, cause: "approval-not-pending" });
  });
});
