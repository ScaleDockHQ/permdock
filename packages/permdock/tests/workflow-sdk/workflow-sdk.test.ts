import type { start as workflowStart } from "workflow/api";

import { describe, expect, expectTypeOf, it } from "vitest";

import type { Automation } from "../../src/core/automation.ts";
import type {
  WorkflowSdkCreateHook,
  WorkflowSdkHook,
  WorkflowSdkResumeHook,
  WorkflowSdkStart,
} from "../../src/workflow-sdk/index.ts";

import { resolveApproval } from "../../src/approvals/helpers.ts";
import { memoryApprovalStore } from "../../src/approvals/store.ts";
import { memoryApprovalPolicySource } from "../../src/core/approval-policies.ts";
import { joseTokenSigner } from "../../src/jwt/signer.ts";
import { joseTokenVerifier } from "../../src/jwt/verifier.ts";
import {
  approvalHookToken,
  authorizeHook,
  startAutomation,
  workflowSdkWaiter,
} from "../../src/workflow-sdk/index.ts";
import {
  createPermDock,
  memoryAutomationSource,
} from "../../src/workflow/index.ts";
import {
  invoice,
  permdockFor,
  permissions,
  person,
  policy,
  userSubject,
} from "../fixtures/automation.ts";

const PRIVATE_JWK = {
  crv: "Ed25519",
  d: "qco_Uh5slpzay2a-eC3woOxpC4DlS6aEzLtBRjrdtd4",
  x: "79ab4WR6Eb9LkefWpmh5ZlvjXg7wqVGNMwIEHQqduIQ",
  kty: "OKP",
  kid: "2026-09",
  alg: "Ed25519",
};
const { d: _d, ...PUBLIC_JWK } = PRIVATE_JWK;
const ISSUER = "https://app.example.com";
const AUDIENCE = "https://runs.example.com";

const published: Automation = {
  v: 1,
  id: "auto_1",
  version: 1,
  mode: "publisher",
  principal: "u_1",
  publishedBy: "u_1",
  publishedAt: "2026-10-14T09:00:00.000Z",
  tenant: "o_1",
  operations: ["read_invoice", "send_invoice"],
  permissions: ["invoice.read", "invoice.send"],
  run: "report.run",
};

/** An in-memory stand-in for Workflow SDK hooks: one pending promise per token. */
function fakeHooks() {
  const parked = new Map<string, (payload: unknown) => void>();
  const disposed: string[] = [];
  const createHook: WorkflowSdkCreateHook = ({ token }) => {
    const payload = new Promise<unknown>((resolve) => {
      parked.set(token, resolve);
    });
    const hook: WorkflowSdkHook = {
      // oxlint-disable-next-line unicorn/no-thenable -- a Workflow SDK Hook is a bare thenable
      then: (onFulfilled, onRejected) => payload.then(onFulfilled, onRejected),
      dispose: () => {
        parked.delete(token);
        disposed.push(token);
      },
    };
    return hook;
  };
  const resumeHook: WorkflowSdkResumeHook = (token, payload) => {
    const resolve = parked.get(token);
    if (resolve === undefined) {
      return Promise.reject(new Error("HookNotFoundError"));
    }
    resolve(payload);
    return Promise.resolve({ token });
  };
  const settled = async (token: string): Promise<void> => {
    while (!parked.has(token)) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1);
      });
    }
  };
  return { createHook, resumeHook, parked, disposed, settled };
}

function setup() {
  const hooks = fakeHooks();
  const store = memoryApprovalStore();
  const workflow = createPermDock(policy, {
    signer: joseTokenSigner({
      key: PRIVATE_JWK,
      alg: "Ed25519",
      kid: "2026-09",
      issuer: ISSUER,
      audience: AUDIENCE,
    }),
    verifier: joseTokenVerifier({
      jwks: { keys: [PUBLIC_JWK] },
      algorithms: ["Ed25519"],
    }),
    principals: {
      principal: (id: string) =>
        id === "u_1" ? person("u_1", ["owner"]) : null,
    },
    automations: memoryAutomationSource([published]),
    audience: AUDIENCE,
    issuer: ISSUER,
    approvals: store,
    approvalPolicies: memoryApprovalPolicySource([
      { permission: "invoice.send", approval: "human" },
    ]),
    waiter: workflowSdkWaiter(hooks),
  });
  return { hooks, store, workflow };
}

describe("workflowSdkWaiter", () => {
  it("parks on a hook named after the approval token and wakes on resume", async () => {
    const hooks = fakeHooks();
    const waiter = workflowSdkWaiter(hooks);
    const waiting = waiter.wait("tok_1");
    await hooks.settled(approvalHookToken("tok_1"));
    await waiter.wake("tok_1");
    await expect(waiting).resolves.toBeUndefined();
    expect(hooks.disposed).toEqual(["permdock:approval:tok_1"]);
  });

  it("ends a wait at expiresAt when given sleep", async () => {
    const hooks = fakeHooks();
    const slept: number[] = [];
    const waiter = workflowSdkWaiter({
      ...hooks,
      sleep: (until) => {
        slept.push(until.getTime());
        return Promise.resolve();
      },
    });
    await waiter.wait("tok_2", { expiresAt: { epochMilliseconds: 1000 } });
    expect(slept).toEqual([1000]);
    expect(hooks.parked.size).toBe(0);
  });

  it("treats waking a run that is not parked as done", async () => {
    await expect(
      workflowSdkWaiter(fakeHooks()).wake("nobody"),
    ).resolves.toBeUndefined();
  });

  it("drives awaitApproval: the run resumes only after the store has the verdict", async () => {
    const { hooks, store, workflow } = setup();
    const started = await workflow.start("auto_1");
    if (started.outcome !== "started") {
      throw new Error("expected a started run");
    }
    const pending = workflow.awaitApproval(
      started.ticket,
      permissions.invoice.send,
      invoice,
    );
    const token = await (async () => {
      for (;;) {
        const first = (await store.list({ status: "pending" })).items[0];
        if (first !== undefined) {
          return first.token;
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1);
        });
      }
    })();
    await hooks.settled(approvalHookToken(token));
    await resolveApproval(store, token, {
      status: "approved",
      by: userSubject("u_9", ["owner"]),
    });
    await workflowSdkWaiter(hooks).wake(token);
    expect((await pending).outcome).toBe("granted");
  });
});

describe("openApproval and resumeApproval", () => {
  it("split awaitApproval into step-sized halves", async () => {
    const { store, workflow } = setup();
    const started = await workflow.start("auto_1");
    if (started.outcome !== "started") {
      throw new Error("expected a started run");
    }
    const opened = await workflow.openApproval(
      started.ticket,
      permissions.invoice.send,
      invoice,
    );
    if (opened.outcome !== "approval-required") {
      throw new Error("expected approval-required");
    }
    const early = await workflow.resumeApproval(
      started.ticket,
      permissions.invoice.send,
      opened.token,
      invoice,
    );
    expect(early).toMatchObject({
      outcome: "denied",
      denials: [{ reason: "approval" }],
    });
    await resolveApproval(store, opened.token, {
      status: "approved",
      by: userSubject("u_9", ["owner"]),
    });
    const resumed = await workflow.resumeApproval(
      started.ticket,
      permissions.invoice.send,
      opened.token,
      invoice,
    );
    expect(resumed.outcome).toBe("granted");
  });
});

describe("startAutomation", () => {
  it("starts the Workflow SDK run with the ticket first, and nothing when denied", async () => {
    const { workflow } = setup();
    const calls: unknown[][] = [];
    const start = (
      _fn: (ticket: string, invoiceId: string) => Promise<unknown>,
      args: [string, string],
    ) => {
      calls.push([...args]);
      return Promise.resolve({ runId: "wrun_1" });
    };
    const run = (_ticket: string, _invoiceId: string): Promise<void> =>
      Promise.resolve();
    const started = await startAutomation(workflow, start, run, "auto_1", [
      "inv_1",
    ]);
    expect(started).toMatchObject({
      outcome: "started",
      workflowRun: { runId: "wrun_1" },
    });
    expect(calls).toEqual([[expect.any(String), "inv_1"]]);
    const denied = await startAutomation(workflow, start, run, "missing", [
      "inv_1",
    ]);
    expect(denied.outcome).toBe("denied");
    expect(calls).toHaveLength(1);
  });

  it("accepts the Workflow SDK start", () => {
    expectTypeOf<typeof workflowStart>().toExtend<
      WorkflowSdkStart<[string], unknown>
    >();
  });
});

describe("authorizeHook", () => {
  it("resumes a hook only for a caller granted the permission", async () => {
    const hooks = fakeHooks();
    const waiting = hooks.createHook({ token: "input:inv_1" });
    const owner = permdockFor(userSubject("u_1", ["owner"]));
    const stranger = permdockFor(userSubject("u_9", []));
    const refused = await authorizeHook(
      hooks.resumeHook,
      stranger,
      permissions.invoice.send,
      invoice,
      "input:inv_1",
      { note: "ship it" },
    );
    expect(refused.outcome).toBe("denied");
    expect(hooks.parked.has("input:inv_1")).toBe(true);
    const granted = await authorizeHook(
      hooks.resumeHook,
      owner,
      permissions.invoice.send,
      invoice,
      "input:inv_1",
      { note: "ship it" },
    );
    expect(granted.outcome).toBe("granted");
    await expect(waiting).resolves.toEqual({ note: "ship it" });
  });

  it("denies when the hook is gone", async () => {
    const owner = permdockFor(userSubject("u_1", ["owner"]));
    const decision = await authorizeHook(
      fakeHooks().resumeHook,
      owner,
      permissions.invoice.send,
      invoice,
      "input:gone",
      {},
    );
    expect(decision).toMatchObject({
      outcome: "denied",
      denials: [
        { reason: "validation", detail: { cause: "hook-unavailable" } },
      ],
    });
  });
});
