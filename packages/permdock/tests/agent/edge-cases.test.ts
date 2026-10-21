import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { PermDock } from "../../src/core/permdock.ts";

import { refusalText } from "../../src/agent/denied-text.ts";
import { createPermDock } from "../../src/agent/index.ts";
import { wrapPermDock } from "../../src/core/wrap.ts";
import {
  allow,
  defineOperations,
  definePermissions,
  definePolicy,
  principal,
  resource,
  role,
} from "../../src/index.ts";

const Doc = z.object({ id: z.string(), ownerId: z.string() });
const Model = z.object({ id: z.string() });

const permissions = definePermissions({
  doc: resource(Doc, { id: "id", actions: ["read"], collection: ["search"] }),
  model: resource(Model, { id: "id", actions: ["use"], collection: ["basic"] }),
});

type User = { readonly id: string; readonly roles: readonly string[] };

const policy = definePolicy(permissions, {
  roles: [
    role("member", [
      allow(permissions.doc.search),
      allow(permissions.doc.read, { where: { ownerId: principal.id } }),
      allow(permissions.model.basic),
    ]),
    role("guest", [allow(permissions.doc.read)]),
  ],
  subject: (user: User | null) => user,
});

const operations = defineOperations(permissions, {
  list_docs: {
    permission: permissions.doc.read,
    results: permissions.doc.search,
  },
  read_doc: {
    permission: permissions.doc.read,
    data: (input: { readonly id: string }) =>
      input.id === "d1" ? { id: "d1", ownerId: "u1" } : null,
  },
});

const models = {
  "openai/gpt-5": permissions.model.use,
  "openai/gpt-5-mini": permissions.model.basic,
};

type Context = { readonly user: User | null };

const member: Context = { user: { id: "u1", roles: ["member"] } };
const guest: Context = { user: { id: "u3", roles: ["guest"] } };

const rows = [
  { id: "d1", ownerId: "u1" },
  { id: "d2", ownerId: "u9" },
];

function failingWrap(): never {
  throw new Error("wrap failed");
}

describe("permdock/agent: a failing instance fails closed", () => {
  const agent = createPermDock(policy, {
    subject: (context: Context) => context.user,
    operations,
    models,
    wrap: failingWrap,
  });

  it("denies every model and lists none", async () => {
    expect(await agent.decideModel("openai/gpt-5-mini", member)).toEqual({
      outcome: "denied",
      denials: [
        {
          role: null,
          reason: "no-grant",
          detail: { model: "openai/gpt-5-mini" },
        },
      ],
      alternatives: [],
    });
    expect(await agent.permittedModels(member)).toEqual([]);
  });

  it("returns no results and empty gateway options", async () => {
    expect(await agent.filterResults("list_docs", rows, member)).toEqual([]);
    expect(await agent.gatewayOptions(member)).toEqual({ gateway: {} });
  });
});

describe("permdock/agent: model gate", () => {
  it("denies with closure-error when the instance's decide throws", async () => {
    const agent = createPermDock(policy, {
      subject: (context: Context) => context.user,
      operations,
      models,
      wrap: (permdock) =>
        wrapPermDock(permdock, () => ({
          decide: (): never => {
            throw new Error("decide failed");
          },
        })),
    });
    expect(await agent.decideModel("openai/gpt-5-mini", member)).toMatchObject({
      outcome: "denied",
      denials: [{ reason: "closure-error" }],
    });
    expect(await agent.permittedModels(member)).toEqual([]);
  });
});

describe("permdock/agent: results by a collection permission", () => {
  it("returns every row when the subject holds the collection permission, else none", async () => {
    const agent = createPermDock(policy, {
      subject: (context: Context) => context.user,
      operations,
    });
    expect(await agent.filterResults("list_docs", rows, member)).toEqual(rows);
    expect(await agent.filterResults("list_docs", rows, guest)).toEqual([]);
  });
});

describe("permdock/agent: deniedText", () => {
  function agentWith(
    deniedText: (event: { readonly text: string }) => unknown,
  ) {
    let instance: PermDock | undefined;
    const agent = createPermDock(policy, {
      subject: (context: Context) => context.user,
      operations,
      // SAFETY: the hook returns a non-string on purpose to exercise the runtime check.
      deniedText: deniedText as (event: { readonly text: string }) => string,
      wrap: (permdock) => {
        instance = permdock;
        return permdock;
      },
    });
    const errorsOf = (): unknown[] => {
      const seen: unknown[] = [];
      instance?.on("error", (error) => {
        seen.push(error);
      });
      return seen;
    };
    return { agent, errorsOf };
  }

  it("keeps PermDock's text when the hook returns undefined", async () => {
    const plain = createPermDock(policy, {
      subject: (context: Context) => context.user,
      operations,
    });
    const expected = await plain.decideOperation(
      "read_doc",
      { id: "d1" },
      { user: null },
    );
    const { agent, errorsOf } = agentWith(() => undefined);
    const verdict = await agent.decideOperation(
      "read_doc",
      { id: "d1" },
      { user: null },
    );
    expect(verdict).toEqual(expected);
    expect(errorsOf()).toEqual([]);
  });

  it("keeps PermDock's text and reports an error when the hook returns a non-string", async () => {
    const plain = createPermDock(policy, {
      subject: (context: Context) => context.user,
      operations,
    });
    const expected = await plain.decideOperation(
      "read_doc",
      { id: "d1" },
      { user: null },
    );
    const { agent, errorsOf } = agentWith(() => 42);
    const verdict = await agent.decideOperation(
      "read_doc",
      { id: "d1" },
      { user: null },
    );
    expect(verdict).toEqual(expected);
    expect(errorsOf()).toEqual([
      expect.objectContaining({
        name: "TypeError",
        message:
          "PermDock: deniedText must return a non-empty string or undefined",
      }),
    ]);
  });

  it("returns the event text when there is no hook", () => {
    const report: unknown[] = [];
    expect(
      refusalText(
        undefined,
        { decision: null, permission: undefined, text: "Not allowed." },
        (error) => {
          report.push(error);
        },
      ),
    ).toBe("Not allowed.");
    expect(report).toEqual([]);
  });
});
