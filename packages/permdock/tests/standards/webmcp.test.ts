import { describe, expect, it } from "vitest";

import type {
  ModelContext,
  WebMcpPermDock,
  WebMcpRegisteredTool,
} from "../../src/webmcp/types.ts";

import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { registerTools } from "../../src/webmcp/register.ts";
import {
  adminUser,
  memberUser,
  permissions,
  policy,
  type User,
} from "../fixtures/quick-start.ts";

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/u;

async function clientOf(user: User): Promise<WebMcpPermDock> {
  const server = await createPermDock(policy, user);
  const snapshot = server.snapshot();
  if (snapshot instanceof Promise || typeof snapshot === "string") {
    throw new Error("expected JSON snapshot");
  }
  return fromSnapshot(snapshot);
}

type Strict = {
  readonly context: ModelContext;
  readonly active: Map<string, WebMcpRegisteredTool>;
  readonly signals: (AbortSignal | undefined)[];
};

function strictContext(): Strict {
  const active = new Map<string, WebMcpRegisteredTool>();
  const signals: (AbortSignal | undefined)[] = [];
  return {
    active,
    signals,
    context: {
      registerTool(tool, options) {
        if (typeof tool.name !== "string" || tool.name === "") {
          throw new TypeError("name is required");
        }
        if (active.has(tool.name)) {
          throw new DOMException(
            `${tool.name} is registered`,
            "InvalidStateError",
          );
        }
        signals.push(options?.signal);
        active.set(tool.name, tool);
        options?.signal?.addEventListener(
          "abort",
          () => {
            active.delete(tool.name);
          },
          { once: true },
        );
        return {};
      },
    },
  };
}

describe("WebMCP draft: ModelContext.registerTool", () => {
  it("every tool has a valid unique name, a description and an object input schema", async () => {
    const { context, active } = strictContext();
    registerTools(context, permissions.post, {
      permdock: await clientOf(adminUser),
    });
    expect(active.size).toBeGreaterThan(0);
    for (const tool of active.values()) {
      expect(tool.name).toMatch(TOOL_NAME);
      expect(
        typeof tool.description === "string" && tool.description !== "",
      ).toBe(true);
      if (tool.inputSchema !== undefined) {
        expect(tool.inputSchema["type"]).toBe("object");
      }
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("annotations carry only the draft hints, as booleans", async () => {
    const { context, active } = strictContext();
    registerTools(context, permissions.post, {
      permdock: await clientOf(memberUser),
      untrustedContentHint: true,
    });
    for (const tool of active.values()) {
      for (const [key, value] of Object.entries(tool.annotations ?? {})) {
        expect({ key, kind: typeof value }).toEqual({
          key: expect.stringMatching(/^(readOnlyHint|untrustedContentHint)$/u),
          kind: "boolean",
        });
      }
    }
    expect(active.get("post_read")?.annotations?.readOnlyHint).toBe(true);
    expect(active.get("post_update")?.annotations?.readOnlyHint).toBe(false);
    expect(active.get("post_read")?.annotations?.untrustedContentHint).toBe(
      true,
    );
  });

  it("passes an AbortSignal with every registration; aborting it unregisters", async () => {
    const { context, active, signals } = strictContext();
    const controller = new AbortController();
    registerTools(context, permissions.post, {
      permdock: await clientOf(memberUser),
      signal: controller.signal,
    });
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    controller.abort();
    expect(active.size).toBe(0);
  });

  it("re-registering on a snapshot change never registers a name that is still active", async () => {
    const permdock = await clientOf(memberUser);
    const listeners = new Set<() => void>();
    const subscribed: WebMcpPermDock = Object.assign({}, permdock, {
      subscribe(listener: () => void) {
        listeners.add(listener);
        return (): void => {
          listeners.delete(listener);
        };
      },
    });
    const { context, active } = strictContext();
    registerTools(context, permissions.post, { permdock: subscribed });
    const before = [...active.keys()].toSorted();
    for (const listener of listeners) {
      listener();
    }
    for (const listener of listeners) {
      listener();
    }
    expect([...active.keys()].toSorted()).toEqual(before);
  });

  it("execute resolves to a tool result of text content parts", async () => {
    const { context, active } = strictContext();
    registerTools(context, permissions.post, {
      permdock: await clientOf(memberUser),
      handlers: { list: async () => [] },
    });
    const result = await active.get("post_list")?.execute({});
    expect(result?.content).toEqual([{ type: "text", text: "[]" }]);
  });

  it("does nothing when the document exposes no modelContext", async () => {
    const warnings: string[] = [];
    const handle = registerTools(undefined, permissions.post, {
      permdock: await clientOf(memberUser),
      warn: (message) => {
        warnings.push(message);
      },
    });
    expect(warnings).toHaveLength(1);
    handle.unregister();
  });
});

describe("WebMCP: agent-supplied arguments are untrusted", () => {
  it("invalid input is a validation error before any handler runs", async () => {
    const ran: unknown[] = [];
    const { context, active } = strictContext();
    registerTools(context, permissions.post, {
      permdock: await clientOf(memberUser),
      handlers: {
        update: async ({ input }) => {
          ran.push(input);
          return "ok";
        },
      },
    });
    const result = await active.get("post_update")?.execute({ id: 42 });
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toMatchObject({
      denials: [{ reason: "validation" }],
    });
    expect(ran).toEqual([]);
  });

  it("a simulated snapshot exposes no tools at all", async () => {
    const server = await createPermDock(policy, adminUser);
    const snapshot = server.snapshot();
    if (snapshot instanceof Promise || typeof snapshot === "string") {
      throw new Error("expected JSON snapshot");
    }
    const { context, active } = strictContext();
    registerTools(context, permissions.post, {
      permdock: fromSnapshot(Object.assign({}, snapshot, { simulated: true })),
    });
    expect(active.size).toBe(0);
  });
});
