import type { StandardSchemaV1 } from "@standard-schema/spec";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { Decision } from "../../src/core/decision.ts";
import type { Snapshot } from "../../src/core/interfaces.ts";
import type {
  ModelContext,
  RegisterToolsOptions,
  WebMcpPermDock,
  WebMcpRegisteredTool,
} from "../../src/webmcp/types.ts";

import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { definePermissions, resource } from "../../src/index.ts";
import { registerTools } from "../../src/webmcp/register.ts";
import {
  memberUser,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

async function memberSnapshot(): Promise<Snapshot> {
  const server = await createPermDock(policy, memberUser);
  const snapshot = server.snapshot();
  if (snapshot instanceof Promise || typeof snapshot === "string") {
    throw new Error("expected JSON snapshot");
  }
  return snapshot;
}

async function member(): Promise<WebMcpPermDock> {
  return fromSnapshot(await memberSnapshot());
}

function fakeContext(): {
  readonly context: ModelContext;
  readonly tools: Map<string, WebMcpRegisteredTool>;
} {
  const tools = new Map<string, WebMcpRegisteredTool>();
  return {
    tools,
    context: {
      registerTool(tool, options) {
        tools.set(tool.name, tool);
        options?.signal?.addEventListener(
          "abort",
          () => {
            tools.delete(tool.name);
          },
          {
            once: true,
          },
        );
        return {};
      },
    },
  };
}

function toolOf(
  tools: Map<string, WebMcpRegisteredTool>,
  name: string,
): WebMcpRegisteredTool {
  const tool = tools.get(name);
  if (tool === undefined) {
    throw new Error(`expected ${name}`);
  }
  return tool;
}

async function register(
  options: Partial<RegisterToolsOptions> = {},
  group: Parameters<typeof registerTools>[1] = permissions.post,
): Promise<Map<string, WebMcpRegisteredTool>> {
  const { context, tools } = fakeContext();
  registerTools(context, group, { permdock: await member(), ...options });
  return tools;
}

function schemaWith(standard: Record<string, unknown>): StandardSchemaV1 {
  // SAFETY: a hand-built Standard Schema whose jsonSchema shape is the input under test.
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) => ({ value }),
      ...standard,
    },
  } as StandardSchemaV1;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registerTools input schemas", () => {
  it("takes the resource schema from a registry root and a nested plain tree", async () => {
    const root = await register({}, permissions);
    expect(toolOf(root, "post_update").inputSchema).toMatchObject({
      type: "object",
      properties: { id: { type: "string" } },
    });
    const nested = await register({}, { posts: permissions.post });
    expect(toolOf(nested, "post_update").inputSchema).toMatchObject({
      properties: { authorId: { type: "string" } },
    });
  });

  it("registers a lone leaf with an object schema and no schema for a collection", async () => {
    const leaf = await register({}, permissions.post.update);
    expect(toolOf(leaf, "post_update").inputSchema).toBeUndefined();
    const list = await register({}, permissions.post.list);
    expect(toolOf(list, "post_list")).not.toHaveProperty("inputSchema");
  });

  it("picks the matching resource among sibling resources", async () => {
    const other = definePermissions({
      note: resource(z.object({ id: z.string(), body: z.string() }), {
        id: "id",
        actions: ["read"],
      }),
    });
    const tools = await register(
      {},
      { note: other.note, post: permissions.post },
    );
    expect(toolOf(tools, "post_update").inputSchema).toMatchObject({
      properties: { published: { type: "boolean" } },
    });
  });

  it.each<[string, Record<string, unknown>, unknown]>([
    [
      "a converter that throws",
      {
        jsonSchema: {
          input: () => {
            throw new Error("unsupported");
          },
        },
      },
      { type: "object" },
    ],
    [
      "a converter returning a non-object",
      { jsonSchema: { input: () => "nope" } },
      { type: "object" },
    ],
    [
      "a plain JSON Schema object",
      { jsonSchema: { type: "object", title: "Post" } },
      { type: "object", title: "Post" },
    ],
    ["no JSON Schema at all", {}, { type: "object" }],
  ])("reads %s", async (_label, standard, expected) => {
    const tools = await register({ schema: schemaWith(standard) });
    expect(toolOf(tools, "post_update").inputSchema).toEqual(expected);
  });
});

describe("registerTools registration", () => {
  it("registers nothing while the snapshot is asynchronous or signed", async () => {
    const base = await member();
    for (const snapshot of [
      () => Promise.resolve(base.snapshot()),
      () => "jws",
    ]) {
      const { context, tools } = fakeContext();
      // SAFETY: the fake snapshot() mimics an async or signed snapshot.
      registerTools(context, permissions.post, {
        permdock: { ...base, snapshot: snapshot as WebMcpPermDock["snapshot"] },
      });
      expect(tools.size).toBe(0);
    }
  });

  it("skips pending permissions", async () => {
    const tools = await register({
      permdock: { ...(await member()), status: () => "pending" },
    });
    expect(tools.size).toBe(0);
  });

  it("marks untrusted content from a tag or the option and titles the tenant", async () => {
    const base = await member();
    const tenant = vi.fn<(id: string) => WebMcpPermDock>(() => base);
    const tools = await register({
      permdock: { ...base, tenant },
      tenant: "o1",
      untrustedContentHint: true,
    });
    expect(tenant).toHaveBeenCalledWith("o1");
    expect(toolOf(tools, "post_read")).toMatchObject({
      description: "post.read [tenant o1]",
      title: "read",
      annotations: { readOnlyHint: true, untrustedContentHint: true },
    });
    const plain = await register();
    expect(toolOf(plain, "post_read").annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: false,
    });
  });

  it("warns on the console when modelContext is missing and no warn is given", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const handle = registerTools(null, permissions.post, {
      permdock: {
        can: () => false,
        decide: () => ({ outcome: "denied", denials: [], alternatives: [] }),
        snapshot: () => "x",
      },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("document.modelContext is absent"),
    );
    expect(handle.unregister()).toBeUndefined();
  });

  it("registers nothing when the parent signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const tools = await register({ signal: controller.signal });
    expect(tools.size).toBe(0);
  });

  it("unregisters and unsubscribes through the handle", async () => {
    const unsubscribe = vi.fn<() => void>();
    const { context, tools } = fakeContext();
    const handle = registerTools(context, permissions.post, {
      permdock: { ...(await member()), subscribe: () => unsubscribe },
    });
    expect(tools.size).toBeGreaterThan(0);
    handle.unregister();
    expect(tools.size).toBe(0);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

describe("registerTools execution", () => {
  it("denies invalid arguments with a validation denial and never calls the handler", async () => {
    const handler = vi.fn<() => Promise<unknown>>(() => Promise.resolve("ok"));
    const tools = await register({ handlers: { update: handler } });
    const result = await toolOf(tools, "post_update").execute({ id: 1 });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        outcome: "denied",
        permission: "post.update",
        denials: [{ role: null, reason: "validation" }],
        alternatives: [],
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("denies an async schema", async () => {
    const tools = await register({
      schema: schemaWith({ validate: () => Promise.resolve({ value: {} }) }),
      handlers: { update: () => Promise.resolve("ok") },
    });
    const result = await toolOf(tools, "post_update").execute(ownPost);
    expect(result.content[0]?.text).toBe("post.update: inputSchema is async.");
    expect(result.isError).toBe(true);
  });

  it("keeps the arguments when a schema result has no value", async () => {
    const handler = vi.fn<
      (call: { readonly input: unknown }) => Promise<unknown>
    >(() => Promise.resolve("ok"));
    const tools = await register({
      schema: schemaWith({ validate: () => ({ issues: undefined }) }),
      handlers: { update: handler },
    });
    await toolOf(tools, "post_update").execute(ownPost);
    expect(handler.mock.calls[0]?.[0].input).toEqual(ownPost);
  });

  it("answers a tool error when no handler is registered", async () => {
    const tools = await register();
    expect(await toolOf(tools, "post_read").execute(ownPost)).toEqual({
      isError: true,
      content: [{ type: "text", text: "post.read: no handler registered." }],
    });
  });

  it.each<[string, unknown, unknown]>([
    [
      "a text result as is",
      { content: [{ type: "text", text: "hi" }], isError: false },
      { content: [{ type: "text", text: "hi" }], isError: false },
    ],
    ["a string as text", "done", { content: [{ type: "text", text: "done" }] }],
    [
      "undefined as null",
      undefined,
      { content: [{ type: "text", text: "null" }] },
    ],
    [
      "an object as JSON",
      { id: 1 },
      { content: [{ type: "text", text: '{"id":1}' }] },
    ],
    [
      "non-text content as JSON",
      { content: [{ type: "image" }] },
      { content: [{ type: "text", text: '{"content":[{"type":"image"}]}' }] },
    ],
  ])("wraps %s", async (_label, value, expected) => {
    const tools = await register({
      handlers: { read: () => Promise.resolve(value) },
    });
    expect(await toolOf(tools, "post_read").execute(ownPost)).toEqual(expected);
  });

  it.each<[string, unknown, string]>([
    [
      "a PermDock error",
      { toProblemDetails: () => ({ title: "Forbidden", detail: "post.read" }) },
      "Forbidden: post.read",
    ],
    [
      "a Problem Details record",
      { type: "application/problem+json", title: "Gone", detail: "x" },
      "Gone: x",
    ],
    [
      "an untitled Problem Details record",
      { type: "application/problem+json" },
      "Denied: ",
    ],
    ["an Error", new Error("boom"), "boom"],
    ["a thrown string", "boom", "Tool failed."],
    ["null", null, "Tool failed."],
  ])("maps %s thrown by a handler", async (_label, thrown, text) => {
    const tools = await register({
      handlers: {
        read: async () => {
          throw thrown;
        },
      },
    });
    const result = await toolOf(tools, "post_read").execute(ownPost);
    expect({ isError: result.isError, text: result.content[0]?.text }).toEqual({
      isError: true,
      text,
    });
  });

  it("binds the tenant into the arguments", async () => {
    const handler = vi.fn<
      (call: { readonly input: unknown }) => Promise<unknown>
    >(() => Promise.resolve("ok"));
    const tools = await register({
      tenant: "o1",
      tenantKey: "orgId",
      handlers: { list: handler, read: handler },
    });
    await toolOf(tools, "post_list").execute("not-an-object");
    await toolOf(tools, "post_read").execute(ownPost);
    expect(handler.mock.calls.map((call) => call[0].input)).toEqual([
      { orgId: "o1" },
      ownPost,
    ]);
  });

  it("describes a denial with alternatives and the resource reference", async () => {
    const base = await member();
    const denied: Decision = {
      outcome: "denied",
      denials: [{ role: "member", reason: "no-grant" }],
      alternatives: [permissions.post.read],
    };
    const tools = await register({
      permdock: { ...base, decide: () => denied },
    });
    const numeric = await toolOf(tools, "post_update").execute(ownPost);
    expect(numeric.content[0]?.text).toBe(
      "Denied: post.update. You may: post.read.",
    );
    expect(numeric.structuredContent).toMatchObject({
      resource: { type: "post", id: "p1" },
      alternatives: ["post.read"],
    });
    const list = await toolOf(tools, "post_list").execute({ id: "x" });
    expect(list.structuredContent?.["resource"]).toEqual({ type: "post" });
  });

  it.each<[unknown, unknown]>([
    [{ id: 7 }, { type: "post", id: "7" }],
    [{ id: true }, { type: "post" }],
    ["scalar", { type: "post" }],
  ])("references %j in an approval result", async (input, ref) => {
    const base = await member();
    const approval = base.decide(permissions.post.delete, ownPost);
    if (approval.outcome !== "approval-required") {
      throw new Error("expected an approval-required decision");
    }
    const tools = await register({
      permdock: { ...base, decide: () => approval },
      schema: schemaWith({}),
      onApprovalRequired: () => Promise.resolve(undefined),
    });
    const result = await toolOf(tools, "post_read").execute(input);
    expect(result.structuredContent).toEqual({
      outcome: "approval-required",
      permission: "post.read",
      resource: ref,
      token: approval.token,
    });
  });
});
