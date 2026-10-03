import type {
  AuthInfo,
  ClientCapabilities,
} from "@modelcontextprotocol/server";

import { Client } from "@modelcontextprotocol/client";
import {
  InMemoryTransport,
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  memoryApprovalStore,
  resolveApproval,
} from "../../src/approvals/index.ts";
import { allow, assurance, definePolicy } from "../../src/index.ts";
import {
  APPROVAL_META_KEY,
  createPermDock,
  subjectFromMcp,
} from "../../src/mcp/index.ts";
import {
  adminUser,
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

type Session = { authInfo: AuthInfo | undefined };

function auth(scopes: readonly string[], extra: Record<string, unknown> = {}) {
  return { token: "t", clientId: "mcp-tester", scopes: [...scopes], extra };
}

async function connect(
  server: McpServer,
  session: Session,
  capabilities: ClientCapabilities = {},
): Promise<{ readonly client: Client; readonly changes: () => number }> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const send = clientSide.send.bind(clientSide);
  clientSide.send = (message, options) =>
    send(
      message,
      session.authInfo === undefined
        ? options
        : { ...options, authInfo: session.authInfo },
    );
  await server.connect(serverSide);
  const client = new Client(
    { name: "tester", version: "1.0.0" },
    { capabilities },
  );
  let changed = 0;
  client.setNotificationHandler("notifications/tools/list_changed", () => {
    changed += 1;
  });
  await client.connect(clientSide);
  return { client, changes: () => changed };
}

const idInput = z.object({ id: z.string() });
const byId = (args: { readonly id: string }) =>
  args.id === "p1" ? ownPost : otherPost;

function text(result: { readonly content?: unknown }): string {
  // SAFETY: MCP tool results carry content as an array of blocks; only text blocks have text.
  const [first] = (result.content ?? []) as { readonly text?: string }[];
  return first?.text ?? "";
}

async function names(client: Client): Promise<string[]> {
  const listed = await client.listTools(undefined, { cacheMode: "bypass" });
  return listed.tools.map((tool) => tool.name).toSorted();
}

function postServer(options: Parameters<typeof createPermDock>[1]) {
  const server = new McpServer({ name: "posts", version: "1.0.0" });
  const guarded = createPermDock(policy, options).protectServer(server);
  guarded.registerTool(
    "list_posts",
    { permission: permissions.post.list, description: "List posts" },
    () => ({ content: [{ type: "text", text: "[]" }] }),
  );
  guarded.registerTool(
    "update_post",
    {
      permission: permissions.post.update,
      title: "Update a post",
      inputSchema: idInput,
      outputSchema: z.object({ id: z.string() }),
      annotations: { idempotentHint: true },
      _meta: { "example.com/owner": "posts" },
      data: byId,
    },
    ({ id }) => ({
      content: [{ type: "text", text: `updated ${id}` }],
      structuredContent: { id },
    }),
  );
  guarded.registerTool(
    "publish_post",
    { permission: permissions.post.publish, inputSchema: idInput, data: byId },
    ({ id }) => ({ content: [{ type: "text", text: `published ${id}` }] }),
  );
  guarded.registerTool(
    "delete_post",
    { permission: permissions.post.delete, inputSchema: idInput, data: byId },
    ({ id }) => ({ content: [{ type: "text", text: `deleted ${id}` }] }),
  );
  return { server, guarded };
}

describe("permdock/mcp on @modelcontextprotocol/server 2", () => {
  it("runs a granted call and refuses a denied one with a Decision", async () => {
    const { server } = postServer({ subject: () => memberUser });
    const { client } = await connect(server, {
      authInfo: auth(["post:update"]),
    });

    const granted = await client.callTool({
      name: "update_post",
      arguments: { id: "p1" },
    });
    expect(granted.isError).not.toBe(true);
    expect(granted.structuredContent).toEqual({ id: "p1" });

    const denied = await client.callTool({
      name: "update_post",
      arguments: { id: "p2" },
    });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({
      outcome: "denied",
      permission: "post.update",
      resource: { type: "post", id: "p2" },
    });
    expect(text(denied)).toContain("Denied");
  });

  it("validates the object built from tool arguments before deciding", async () => {
    const server = new McpServer({ name: "posts", version: "1.0.0" });
    const guarded = createPermDock(policy, {
      subject: () => adminUser,
    }).protectServer(server);
    let ran = false;
    guarded.registerTool(
      "publish_post",
      {
        permission: permissions.post.publish,
        inputSchema: z.object({ id: z.string() }),
        data: (args: { readonly id: string }) => ({ id: args.id }),
      },
      () => {
        ran = true;
        return { content: [{ type: "text", text: "published" }] };
      },
    );
    const { client } = await connect(server, { authInfo: undefined });
    const result = await client.callTool({
      name: "publish_post",
      arguments: { id: "p2" },
    });
    expect(result.isError).toBe(true);
    expect(ran).toBe(false);
  });

  it("lists only tools the caller may use, with every registered field", async () => {
    const session: Session = {
      authInfo: auth(["post:list", "post:update", "post:publish"]),
    };
    let user: unknown = memberUser;
    const { server } = postServer({ subject: () => user });
    const { client } = await connect(server, session);

    expect(await names(client)).toEqual(["list_posts", "update_post"]);
    const listed = await client.listTools(undefined, { cacheMode: "bypass" });
    const update = listed.tools.find((tool) => tool.name === "update_post");
    expect(update).toMatchObject({
      title: "Update a post",
      annotations: { idempotentHint: true },
      _meta: { "example.com/owner": "posts" },
      outputSchema: { type: "object" },
    });

    user = adminUser;
    expect(await names(client)).toEqual([
      "list_posts",
      "publish_post",
      "update_post",
    ]);

    session.authInfo = auth(["post:list"]);
    expect(await names(client)).toEqual(["list_posts"]);

    user = null;
    expect(await names(client)).toEqual([]);
  });

  it("refuses a call outside the granted scopes and names every scope the operation needs", async () => {
    const { server, guarded } = postServer({ subject: () => memberUser });
    const registered = guarded.registerTool(
      "read_post",
      { permission: permissions.post.read, inputSchema: idInput, data: byId },
      () => ({ content: [{ type: "text", text: "read" }] }),
    );
    const { client } = await connect(server, {
      authInfo: {
        ...auth(["post:read"]),
        resource: new URL("https://mcp.example.com/mcp"),
      },
    });
    const refused = await client.callTool({
      name: "update_post",
      arguments: { id: "p1" },
    });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({
      outcome: "denied",
      error: "insufficient_scope",
      scope: "post:update",
      resource_metadata:
        "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
      www_authenticate:
        'Bearer error="insufficient_scope", scope="post:update", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    });

    const request = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "tools/call",
      params: { name: "read_post" },
    };
    expect(
      await registered.scopeChallenge?.({
        request,
        authInfo: auth(["post:list"]),
      }),
    ).toEqual({ scopes: ["post:read"] });
    expect(
      await registered.scopeChallenge?.({
        request,
        authInfo: auth(["post:read"]),
      }),
    ).toBeUndefined();
    expect(await registered.scopeChallenge?.({ request })).toBeUndefined();
  });

  it("skips the scope check without auth info unless it is required", async () => {
    const local = postServer({ subject: () => memberUser });
    const { client } = await connect(local.server, { authInfo: undefined });
    const granted = await client.callTool({
      name: "update_post",
      arguments: { id: "p1" },
    });
    expect(granted.isError).not.toBe(true);

    const strict = postServer({
      subject: () => memberUser,
      requireAuthInfo: true,
    });
    const strictClient = await connect(strict.server, { authInfo: undefined });
    const refused = await strictClient.client.callTool({
      name: "update_post",
      arguments: { id: "p1" },
    });
    expect(refused.isError).toBe(true);
    expect(await names(strictClient.client)).toEqual([]);
  });

  it("parks an approval, resumes from _meta or the store, and consumes it once", async () => {
    const store = memoryApprovalStore();
    const { server } = postServer({ subject: () => memberUser, store });
    const { client } = await connect(server, {
      authInfo: auth(["post:delete"]),
    });

    const parked = await client.callTool({
      name: "delete_post",
      arguments: { id: "p1" },
    });
    expect(parked.isError).toBe(true);
    expect(parked.structuredContent).toMatchObject({
      outcome: "approval-required",
      permission: "post.delete",
    });
    // SAFETY: the approval-required result carries a token string in its structuredContent.
    const token = (parked.structuredContent as { readonly token: string })
      .token;
    await resolveApproval(store, token, {
      status: "approved",
      by: { principal: { id: "u2", roles: ["admin"] }, context: {} },
    });

    const resumed = await client.callTool({
      name: "delete_post",
      arguments: { id: "p1", token: "forged-by-the-model" },
      _meta: { [APPROVAL_META_KEY]: token },
    });
    expect(text(resumed)).toBe("deleted p1");

    const replayed = await client.callTool({
      name: "delete_post",
      arguments: { id: "p1" },
      _meta: { [APPROVAL_META_KEY]: token },
    });
    expect(replayed.isError).toBe(true);

    const again = await client.callTool({
      name: "delete_post",
      arguments: { id: "p1" },
    });
    expect(again.isError).toBe(true);
    expect(again.structuredContent).toMatchObject({
      outcome: "denied",
      denials: [{ detail: "approval-consumed" }],
    });
  });

  it("resumes without a token once the store holds the approval", async () => {
    const store = memoryApprovalStore();
    const { server } = postServer({ subject: () => memberUser, store });
    const { client } = await connect(server, {
      authInfo: auth(["post:delete"]),
    });
    await client.callTool({ name: "delete_post", arguments: { id: "p1" } });
    const [pending] = (await store.list({ status: "pending" })).items;
    if (pending === undefined) {
      throw new Error("expected a pending approval");
    }
    await resolveApproval(store, pending.token, {
      status: "approved",
      by: { principal: { id: "u2", roles: ["admin"] }, context: {} },
    });
    const resumed = await client.callTool({
      name: "delete_post",
      arguments: { id: "p1" },
    });
    expect(text(resumed)).toBe("deleted p1");
  });

  it("answers an approval with input_required when the client takes URL elicitations", async () => {
    const store = memoryApprovalStore();
    const { server } = postServer({
      subject: () => memberUser,
      store,
      approval: { at: "https://app.example.com/approvals" },
    });
    const { client } = await connect(
      server,
      { authInfo: auth(["post:delete"]) },
      { elicitation: { url: {} } },
    );
    const asked: string[] = [];
    client.setRequestHandler("elicitation/create", async (request) => {
      const url = new URL("url" in request.params ? request.params.url : "");
      asked.push(`${url.origin}${url.pathname}`);
      await resolveApproval(store, url.searchParams.get("token") ?? "", {
        status: "approved",
        by: { principal: { id: "u2", roles: ["admin"] }, context: {} },
      });
      return { action: "accept" };
    });
    const resumed = await client.callTool({
      name: "delete_post",
      arguments: { id: "p1" },
    });
    expect(text(resumed)).toBe("deleted p1");
    expect(asked).toEqual(["https://app.example.com/approvals"]);
  });

  it("keeps the plain approval refusal for a client without URL elicitation", async () => {
    const { server } = postServer({
      subject: () => memberUser,
      store: memoryApprovalStore(),
      approval: { at: "https://app.example.com/approvals" },
    });
    const { client } = await connect(server, {
      authInfo: auth(["post:delete"]),
    });
    const parked = await client.callTool({
      name: "delete_post",
      arguments: { id: "p1" },
    });
    expect(parked.structuredContent).toMatchObject({
      outcome: "approval-required",
      token: expect.any(String),
    });
    expect(parked.structuredContent).not.toHaveProperty("elicitation");
  });

  it("asks for a step-up with acr_values and max_age", async () => {
    const stepUpPolicy = definePolicy(permissions, {
      subject: (user: { readonly id: string } | null) =>
        user === null ? null : { id: user.id, roles: [] },
      grants: [
        allow(permissions.post.list, {
          to: assurance({ acr: "mfa", maxAge: 300 }),
        }),
      ],
    });
    const server = new McpServer({ name: "posts", version: "1.0.0" });
    createPermDock(stepUpPolicy, {
      subject: () => ({ id: "u1" }),
      stepUp: { at: "https://app.example.com/reauth" },
    })
      .protectServer(server)
      .registerTool(
        "list_posts",
        { permission: permissions.post.list },
        () => ({
          content: [{ type: "text", text: "[]" }],
        }),
      );

    const plain = await connect(server, { authInfo: auth(["post:list"]) });
    const refused = await plain.client.callTool({ name: "list_posts" });
    expect(refused.structuredContent).toMatchObject({
      error: "insufficient_user_authentication",
      acr_values: "mfa",
      max_age: 300,
      www_authenticate:
        'Bearer error="insufficient_user_authentication", acr_values="mfa", max_age="300"',
    });

    const urls: string[] = [];
    const eliciting = await connect(
      server,
      { authInfo: auth(["post:list"]) },
      { elicitation: { url: {} } },
    );
    eliciting.client.setRequestHandler(
      "elicitation/create",
      async (request) => {
        urls.push("url" in request.params ? request.params.url : "");
        return { action: "decline" };
      },
    );
    await eliciting.client
      .callTool({ name: "list_posts" })
      .catch(() => undefined);
    expect(urls[0]).toBe(
      "https://app.example.com/reauth?acr_values=mfa&max_age=300",
    );
  });

  it("refuses a token issued for another resource", async () => {
    const { server } = postServer({
      subject: () => memberUser,
      resource: "https://mcp.example.com/mcp",
    });
    const session: Session = {
      authInfo: {
        ...auth(["post:list"]),
        resource: new URL("https://other.example.com/mcp"),
      },
    };
    const { client } = await connect(server, session);
    expect(await names(client)).toEqual([]);
    const refused = await client.callTool({ name: "list_posts" });
    expect(refused.structuredContent).toMatchObject({
      error: "invalid_token",
    });

    session.authInfo = {
      ...auth(["post:list"]),
      resource: new URL("https://MCP.example.com/mcp"),
    };
    expect(await names(client)).toEqual(["list_posts"]);
    session.authInfo = auth(["post:list"]);
    expect(await names(client)).toEqual([]);
  });

  it("fills tool annotations the author left out from the permission", async () => {
    const { server } = postServer({ subject: () => adminUser });
    const { client } = await connect(server, {
      authInfo: auth(["post:list", "post:update", "post:delete"]),
    });
    const listed = await client.listTools(undefined, { cacheMode: "bypass" });
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
    expect(byName.get("list_posts")?.annotations).toEqual({
      readOnlyHint: true,
    });
    expect(byName.get("update_post")?.annotations).toEqual({
      readOnlyHint: false,
      idempotentHint: true,
    });
  });

  it("fails closed when the data loader throws or finds nothing", async () => {
    const server = new McpServer({ name: "posts", version: "1.0.0" });
    const guarded = createPermDock(policy, {
      subject: () => memberUser,
    }).protectServer(server);
    guarded.registerTool(
      "boom",
      {
        permission: permissions.post.read,
        inputSchema: idInput,
        data: () => {
          throw new Error("database down");
        },
      },
      () => ({ content: [{ type: "text", text: "read" }] }),
    );
    guarded.registerTool(
      "missing",
      {
        permission: permissions.post.read,
        inputSchema: idInput,
        data: () => null,
      },
      () => ({ content: [{ type: "text", text: "read" }] }),
    );
    const { client } = await connect(server, { authInfo: undefined });
    const boom = await client.callTool({
      name: "boom",
      arguments: { id: "p1" },
    });
    expect(boom.isError).toBe(true);
    expect(text(boom)).not.toContain("database down");
    const missing = await client.callTool({
      name: "missing",
      arguments: { id: "p1" },
    });
    expect(missing.structuredContent).toMatchObject({
      denials: [{ reason: "validation" }],
    });
  });

  it("never takes the subject from tool arguments", async () => {
    const { server } = postServer({
      subject: (authInfo) => authInfo.extra?.["subject"] ?? null,
    });
    const { client } = await connect(server, {
      authInfo: auth(["post:update"]),
    });
    const refused = await client.callTool({
      name: "update_post",
      arguments: { id: "p1", subject: { id: "u2", roles: ["admin"] } },
    });
    expect(refused.isError).toBe(true);
  });

  it("tells the client when a call changed the tools it may use", async () => {
    let user: unknown = memberUser;
    const server = new McpServer({ name: "posts", version: "1.0.0" });
    const guarded = createPermDock(policy, {
      subject: () => user,
    }).protectServer(server);
    guarded.registerTool(
      "promote_me",
      { permission: permissions.post.list },
      () => {
        user = adminUser;
        return { content: [{ type: "text", text: "promoted" }] };
      },
    );
    guarded.registerTool(
      "publish_post",
      {
        permission: permissions.post.publish,
        inputSchema: idInput,
        data: byId,
      },
      () => ({ content: [{ type: "text", text: "published" }] }),
    );
    const { client, changes } = await connect(server, { authInfo: undefined });
    expect(await names(client)).toEqual(["promote_me"]);
    const before = changes();
    await client.callTool({ name: "promote_me", arguments: {} });
    await expect.poll(changes).toBeGreaterThan(before);
    expect(await names(client)).toEqual(["promote_me", "publish_post"]);
  });

  it("guards resources and prompts, and their lists", async () => {
    const server = new McpServer({ name: "posts", version: "1.0.0" });
    const guarded = createPermDock(policy, {
      subject: () => memberUser,
    }).protectServer(server);
    guarded.registerResource(
      "post",
      new ResourceTemplate("posts://{id}", { list: undefined }),
      {
        permission: permissions.post.update,
        data: (_uri, variables) => byId({ id: String(variables["id"]) }),
      },
      (uri) => ({ contents: [{ uri: uri.href, text: "post body" }] }),
    );
    guarded.registerResource(
      "drafts",
      "posts://drafts",
      { permission: permissions.post.publish, data: () => ownPost },
      (uri) => ({ contents: [{ uri: uri.href, text: "drafts" }] }),
    );
    guarded.registerPrompt(
      "summarise",
      { permission: permissions.post.list, description: "Summarise posts" },
      () => ({ messages: [] }),
    );
    guarded.registerPrompt(
      "announce",
      { permission: permissions.post.publish },
      () => ({ messages: [] }),
    );
    const { client } = await connect(server, { authInfo: undefined });

    const read = await client.readResource({ uri: "posts://p1" });
    expect(read.contents[0]).toMatchObject({ text: "post body" });
    await expect(client.readResource({ uri: "posts://p2" })).rejects.toThrow(
      /Denied/u,
    );
    await expect(
      client.readResource({ uri: "posts://drafts" }),
    ).rejects.toThrow(/Denied/u);

    const resources = await client.listResources(undefined, {
      cacheMode: "bypass",
    });
    expect(resources.resources.map((resource) => resource.uri)).toEqual([]);
    const templates = await client.listResourceTemplates(undefined, {
      cacheMode: "bypass",
    });
    expect(
      templates.resourceTemplates.map((template) => template.uriTemplate),
    ).toEqual(["posts://{id}"]);

    const prompts = await client.listPrompts(undefined, {
      cacheMode: "bypass",
    });
    expect(prompts.prompts.map((prompt) => prompt.name)).toEqual(["summarise"]);
    await expect(client.getPrompt({ name: "announce" })).rejects.toThrow(
      /Denied/u,
    );
    expect(await client.getPrompt({ name: "summarise" })).toMatchObject({
      messages: [],
    });
  });

  it("filters list handlers installed before protectServer", async () => {
    const server = new McpServer(
      { name: "posts", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    const guarded = createPermDock(policy, {
      subject: () => memberUser,
    }).protectServer(server);
    guarded.registerTool(
      "publish_post",
      {
        permission: permissions.post.publish,
        inputSchema: idInput,
        data: byId,
      },
      () => ({ content: [{ type: "text", text: "published" }] }),
    );
    guarded.registerTool(
      "list_posts",
      { permission: permissions.post.list },
      () => ({ content: [{ type: "text", text: "[]" }] }),
    );
    const { client } = await connect(server, { authInfo: undefined });
    expect(await names(client)).toEqual(["list_posts"]);
  });

  it("refuses to register a tool without a permission", () => {
    const server = new McpServer({ name: "posts", version: "1.0.0" });
    const guarded = createPermDock(policy, {
      subject: () => memberUser,
    }).protectServer(server);
    // SAFETY: deliberately omits the required permission to exercise fail-closed registration.
    expect(() =>
      guarded.registerTool("open", {} as never, () => ({ content: [] })),
    ).toThrow(TypeError);
  });

  it.each([
    [true, true],
    [false, false],
  ])(
    "with longRunning %s, a grant revoked while the handler runs refuses the result: %s",
    async (longRunning, refused) => {
      let row = ownPost;
      const server = new McpServer({ name: "posts", version: "1.0.0" });
      createPermDock(policy, { subject: () => memberUser })
        .protectServer(server)
        .registerTool(
          "rewrite_post",
          {
            permission: permissions.post.update,
            inputSchema: idInput,
            data: () => row,
            longRunning,
          },
          ({ id }) => {
            row = otherPost;
            return { content: [{ type: "text", text: `rewrote ${id}` }] };
          },
        );
      const { client } = await connect(server, {
        authInfo: auth(["post:update"]),
      });
      const result = await client.callTool({
        name: "rewrite_post",
        arguments: { id: "p1" },
      });
      expect(result.isError === true).toBe(refused);
      expect(text(result).startsWith("rewrote")).toBe(!refused);
    },
  );
});

describe("subjectFromMcp", () => {
  it("maps verified auth info to a principal, an mcp-client actor and a delegation", () => {
    const subject = subjectFromMcp(
      auth(["post:read", "post:update"], {
        sub: "u1",
        roles: ["member"],
        iss: "https://issuer.example",
      }),
    );
    expect(subject.principal).toMatchObject({ id: "u1", roles: ["member"] });
    expect(subject.actor).toEqual({ id: "mcp-tester", kind: "mcp-client" });
    expect(subject.delegation?.scopes).toEqual(["post:read", "post:update"]);
  });

  it("returns the anonymous subject for missing or malformed material", () => {
    expect(subjectFromMcp(undefined).principal).toBeNull();
    expect(subjectFromMcp({}).principal).toBeNull();
    // SAFETY: a numeric sub is deliberately malformed to exercise the anonymous fallback.
    expect(
      subjectFromMcp(auth([], { sub: 42 as unknown as string })).principal,
    ).toBeNull();
    expect(
      subjectFromMcp(auth([], { sub: "u1", plan: "gold" }), {
        schema: z.object({ plan: z.enum(["free", "pro"]) }),
      }).principal,
    ).toBeNull();
  });

  it("plugs into createPermDock as the subject", async () => {
    const { server } = postServer({ subject: subjectFromMcp });
    const { client } = await connect(server, {
      authInfo: auth(["post:update"], { sub: "u1", roles: ["member"] }),
    });
    const granted = await client.callTool({
      name: "update_post",
      arguments: { id: "p1" },
    });
    expect(granted.isError).not.toBe(true);
  });
});
