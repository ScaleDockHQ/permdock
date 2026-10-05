import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createPermDock as createAiSdkPermDock } from "../../src/ai-sdk/index.ts";
import { memoryApprovalStore } from "../../src/approvals/index.ts";
import { memoryApprovalPolicies } from "../../src/index.ts";
import { createPermDock as createMcpPermDock } from "../../src/mcp/index.ts";
import { createPermDock as createServerPermDock } from "../../src/server/index.ts";
import { memberUser, permissions, policy } from "../fixtures/quick-start.ts";

const src = path.join(import.meta.dirname, "../../src");

const listsNeedApproval = memoryApprovalPolicies([
  { permission: "post.list", approval: "human" },
]);

function sourceFiles(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return ["core", "cli", "testing"].includes(entry.name) && dir === src
        ? []
        : sourceFiles(full);
    }
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

describe("adapters forward approvalPolicies", () => {
  it("every adapter that builds an instance with a role source forwards approvalPolicies", () => {
    const builders = sourceFiles(src).filter((file) =>
      readFileSync(file, "utf8").includes("customRoles: options.customRoles"),
    );
    expect(builders.length).toBeGreaterThan(15);
    const missing = builders.filter(
      (file) =>
        !readFileSync(file, "utf8").includes(
          "approvalPolicies: options.approvalPolicies",
        ),
    );
    expect(missing.map((file) => path.relative(src, file))).toEqual([]);
  });

  it("the server kernel asks for approval an entry requires", async () => {
    const { protect } = createServerPermDock(policy, {
      subject: () => memberUser,
      approvalPolicies: listsNeedApproval,
    });
    const guard = await protect(permissions.post.list)(
      new Request("https://api.example/posts"),
    );
    expect(guard.ok).toBe(false);
    if (!guard.ok) {
      expect(guard.response.status).toBe(403);
      expect(await guard.response.json()).toMatchObject({
        type: "https://permdock.com/problems/approval-required",
      });
    }
  });

  it("an MCP tool parks the call an entry requires", async () => {
    const server = new McpServer({ name: "posts", version: "1.0.0" });
    createMcpPermDock(policy, {
      subject: () => memberUser,
      approvalPolicies: listsNeedApproval,
      store: memoryApprovalStore(),
    })
      .protectServer(server)
      .registerTool(
        "list_posts",
        { permission: permissions.post.list },
        () => ({
          content: [{ type: "text", text: "[]" }],
        }),
      );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "tester", version: "1.0.0" });
    await client.connect(clientSide);
    expect(await client.callTool({ name: "list_posts" })).toMatchObject({
      isError: true,
      structuredContent: { outcome: "approval-required" },
    });
  });

  it("AI SDK toolApproval returns user-approval for an entry", async () => {
    const { toolApproval } = createAiSdkPermDock(policy, {
      subject: () => memberUser,
      tools: { list_posts: { permission: permissions.post.list } },
      approvalPolicies: listsNeedApproval,
      store: memoryApprovalStore(),
    });
    expect(
      await toolApproval({ toolCall: { toolName: "list_posts", input: {} } }),
    ).toMatchObject({ type: "user-approval" });
  });
});
