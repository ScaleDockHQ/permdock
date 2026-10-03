import type { AuthInfo } from "@modelcontextprotocol/server";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  memoryApprovalStore,
  resolveApproval,
} from "../../src/approvals/index.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";
import { createPermDock } from "../../src/mcp/index.ts";

const Refund = z.object({ amount: z.number(), to: z.string() });
const permissions = definePermissions({
  refund: resource(Refund, { collection: ["create"] }),
});
const policy = definePolicy(permissions, {
  roles: [
    role("clerk", [allow(permissions.refund.create, { approval: "human" })]),
  ],
  subject: (
    user: { readonly id: string; readonly roles: readonly string[] } | null,
  ) => (user === null ? null : { id: user.id, roles: user.roles }),
});
const authInfo: AuthInfo = {
  token: "t",
  clientId: "mcp-tester",
  scopes: [permissions.refund.create.scope],
};

describe("an MCP approval covers the arguments it was given", () => {
  it("does not run the handler for a retried call with other arguments", async () => {
    const store = memoryApprovalStore();
    const server = new McpServer({ name: "refunds", version: "1.0.0" });
    const ran: unknown[] = [];
    createPermDock(policy, {
      subject: () => ({ id: "u1", roles: ["clerk"] }),
      store,
    })
      .protectServer(server)
      .registerTool(
        "create_refund",
        {
          permission: permissions.refund.create,
          inputSchema: Refund,
          data: (args: z.infer<typeof Refund>) => args,
        },
        (args) => {
          ran.push(args);
          return { content: [{ type: "text", text: "refunded" }] };
        },
      );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const send = clientSide.send.bind(clientSide);
    clientSide.send = (message, options) =>
      send(message, { ...options, authInfo });
    await server.connect(serverSide);
    const client = new Client({ name: "tester", version: "1.0.0" });
    await client.connect(clientSide);

    const parked = await client.callTool({
      name: "create_refund",
      arguments: { amount: 5, to: "c_1" },
    });
    expect(parked.isError).toBe(true);
    // SAFETY: the approval-required result carries a token string in its structuredContent.
    const token = (parked.structuredContent as { readonly token: string })
      .token;
    await resolveApproval(store, token, {
      status: "approved",
      by: { principal: { id: "u2", roles: ["clerk"] }, context: {} },
    });

    const swapped = await client.callTool({
      name: "create_refund",
      arguments: { amount: 5000, to: "c_attacker" },
    });
    expect(swapped.isError).toBe(true);
    expect(ran).toEqual([]);

    const approved = await client.callTool({
      name: "create_refund",
      arguments: { amount: 5, to: "c_1" },
    });
    expect(approved.isError).not.toBe(true);
    expect(ran).toEqual([{ amount: 5, to: "c_1" }]);
  });
});
