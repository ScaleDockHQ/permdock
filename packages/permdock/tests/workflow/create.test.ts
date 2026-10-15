import { describe, expect, it } from "vitest";

import type { ApprovalStore } from "../../src/approvals/types.ts";
import type { Automation } from "../../src/core/automation.ts";
import type { Principal } from "../../src/core/subject.ts";

import { resolveApproval } from "../../src/approvals/helpers.ts";
import { memoryApprovalStore } from "../../src/approvals/store.ts";
import { memoryApprovalPolicySource } from "../../src/core/approval-policies.ts";
import { memoryDecisionSink } from "../../src/core/sink.ts";
import { joseTokenSigner } from "../../src/jwt/signer.ts";
import { joseTokenVerifier } from "../../src/jwt/verifier.ts";
import {
  type WorkflowPermDockOptions,
  createPermDock,
  memoryAutomationSource,
  pollingApprovalWaiter,
} from "../../src/workflow/index.ts";
import {
  cappedPolicy,
  invoice,
  operations,
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

const signer = joseTokenSigner({
  key: PRIVATE_JWK,
  alg: "Ed25519",
  kid: "2026-09",
  issuer: ISSUER,
  audience: AUDIENCE,
});
const verifier = joseTokenVerifier({
  jwks: { keys: [PUBLIC_JWK] },
  algorithms: ["Ed25519"],
});

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

const serviceRun: Automation = {
  ...published,
  id: "auto_svc",
  mode: "service",
  principal: "automation:auto_svc",
  roles: ["billing"],
};

function setup(
  people: readonly Principal[] = [person("u_1", ["owner"])],
  extra: Partial<WorkflowPermDockOptions> = {},
  using = policy,
) {
  const directory = new Map(people.map((entry) => [entry.id, entry]));
  const principals = {
    principal: (id: string) => directory.get(id) ?? null,
  };
  const automations = memoryAutomationSource([published, serviceRun]);
  const workflow = createPermDock(using, {
    signer,
    verifier,
    principals,
    automations,
    audience: AUDIENCE,
    issuer: ISSUER,
    ...extra,
  });
  const ticketFor = async (
    id = "auto_1",
    options: Parameters<typeof workflow.start>[1] = {},
  ): Promise<string> => {
    const started = await workflow.start(id, options);
    if (started.outcome !== "started") {
      throw new Error(`expected a started run: ${JSON.stringify(started)}`);
    }
    return started.ticket;
  };
  return { workflow, directory, automations, ticketFor };
}

async function pendingToken(store: ApprovalStore): Promise<string> {
  for (;;) {
    const token = (await store.list({ status: "pending" })).items[0]?.token;
    if (token !== undefined) {
      return token;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 2);
    });
  }
}

describe("permdock/workflow: runs of a publisher automation", () => {
  it("writes an automation run event to the sink, and a failing sink never stops a run", async () => {
    const sink = memoryDecisionSink();
    const { ticketFor } = setup(undefined, { sink });
    await ticketFor("auto_1", { id: "run_1" });
    expect(sink.events()).toEqual([
      expect.objectContaining({
        type: "automation",
        operation: "run",
        automation: { id: "auto_1", version: 1, mode: "publisher" },
        run: { id: "run_1" },
        permissions: ["invoice.read", "invoice.send"],
      }),
    ]);
    const broken = setup(undefined, {
      sink: {
        write: () => {
          throw new Error("sink down");
        },
      },
    });
    await expect(broken.ticketFor()).resolves.toEqual(expect.any(String));
  });

  it("acts as the publisher, capped at the automation's permissions", async () => {
    const { workflow, ticketFor } = setup();
    const run = await workflow.getPermDock(await ticketFor());
    expect(run.subject.principal?.id).toBe("u_1");
    expect(run.subject.actor).toMatchObject({
      id: "auto_1",
      kind: "automation",
    });
    expect(run.can(permissions.invoice.read, invoice)).toBe(true);
    expect(run.can(permissions.invoice.send, invoice)).toBe(true);
    expect(run.can(permissions.invoice.delete, invoice)).toBe(false);
    expect(run.can(permissions.report.run, invoice)).toBe(false);
  });

  it("is further capped by a policy delegation to actor('automation')", async () => {
    const { workflow, ticketFor } = setup(undefined, {}, cappedPolicy);
    const run = await workflow.getPermDock(await ticketFor());
    expect(run.can(permissions.invoice.read, invoice)).toBe(true);
    expect(run.can(permissions.invoice.send, invoice)).toBe(false);
  });

  it("denies once the publisher is demoted, and everything once they are removed", async () => {
    const { workflow, directory, ticketFor } = setup();
    const ticket = await ticketFor();
    directory.set("u_1", person("u_1", ["reader"]));
    const demoted = await workflow.getPermDock(ticket);
    expect(demoted.can(permissions.invoice.read, invoice)).toBe(true);
    expect(demoted.can(permissions.invoice.send, invoice)).toBe(false);
    directory.delete("u_1");
    const removed = await workflow.getPermDock(ticket);
    expect(removed.subject.principal).toBeNull();
    expect(removed.can(permissions.invoice.read, invoice)).toBe(false);
  });

  it("denies every ticket of an earlier version, and of a revoked automation", async () => {
    const causes: unknown[] = [];
    const { workflow, automations, ticketFor } = setup(undefined, {
      onAuth: (event) => {
        causes.push(event.cause);
      },
    });
    const ticket = await ticketFor();
    automations.put({ ...published, version: 2 });
    const changed = await workflow.getPermDock(ticket);
    expect(changed.subject.principal).toBeNull();
    expect(changed.can(permissions.invoice.read, invoice)).toBe(false);
    const fresh = await ticketFor();
    expect(
      (await workflow.getPermDock(fresh)).can(
        permissions.invoice.read,
        invoice,
      ),
    ).toBe(true);
    automations.put({ ...published, version: 2, revoked: true });
    expect((await workflow.getPermDock(fresh)).subject.principal).toBeNull();
    expect(causes).toEqual(["automation-changed", "automation-unavailable"]);
    expect(await workflow.start("auto_1")).toMatchObject({
      outcome: "denied",
      denials: [{ reason: "validation" }],
    });
  });

  it("refuses a ticket whose principal is not the automation's", async () => {
    const { workflow, automations, ticketFor } = setup([
      person("u_1", ["owner"]),
      person("u_2", ["owner"]),
    ]);
    const ticket = await ticketFor();
    automations.put({ ...published, principal: "u_2", publishedBy: "u_2" });
    expect((await workflow.getPermDock(ticket)).subject.principal).toBeNull();
  });
});

describe("permdock/workflow: the trigger never grants", () => {
  it("records the trigger and lends the run none of the caller's rights", async () => {
    const { workflow, ticketFor } = setup([
      person("u_1", ["billing"]),
      person("u_9", ["owner"]),
    ]);
    const caller = permdockFor(userSubject("u_9", ["owner"]));
    const trigger = {
      roles: ["owner"],
      principal: "u_9",
      grant: "invoice.delete",
    };
    const run = await workflow.getPermDock(
      await ticketFor("auto_1", { caller, trigger }),
    );
    expect(run.subject.principal?.id).toBe("u_1");
    expect(run.subject.context["trigger"]).toEqual(trigger);
    expect(run.can(permissions.invoice.delete, invoice)).toBe(false);
  });

  it("needs only the run permission from the caller", async () => {
    const { workflow } = setup();
    const reader = permdockFor(userSubject("u_3", ["reader"]));
    expect(await workflow.start("auto_1", { caller: reader })).toMatchObject({
      outcome: "denied",
      denials: [{ reason: "no-grant" }],
    });
    const billing = permdockFor(userSubject("u_4", ["billing"]));
    expect((await workflow.start("auto_1", { caller: billing })).outcome).toBe(
      "started",
    );
  });

  it("refuses any caller when the automation has no run permission", async () => {
    const { workflow, automations } = setup();
    const { run: _run, ...serverOnly } = published;
    automations.put(serverOnly);
    const owner = permdockFor(userSubject("u_9", ["owner"]));
    expect(await workflow.start("auto_1", { caller: owner })).toMatchObject({
      denials: [{ reason: "no-grant" }],
    });
    expect((await workflow.start("auto_1")).outcome).toBe("started");
  });
});

describe("permdock/workflow: service automations", () => {
  it("runs as a service principal with the automation's roles", async () => {
    const { workflow, ticketFor } = setup();
    const run = await workflow.getPermDock(await ticketFor("auto_svc"));
    expect(run.subject.principal).toMatchObject({
      id: "automation:auto_svc",
      kind: "service",
    });
    expect(run.can(permissions.invoice.send, invoice)).toBe(true);
    expect(run.can(permissions.invoice.delete, invoice)).toBe(false);
  });

  it("denies once the publisher could no longer assign its roles", async () => {
    const { workflow, directory, ticketFor } = setup();
    const ticket = await ticketFor("auto_svc");
    directory.set("u_1", person("u_1", ["reader"]));
    const demoted = await workflow.getPermDock(ticket);
    expect(demoted.subject.principal).toBeNull();
    directory.delete("u_1");
    expect((await workflow.getPermDock(ticket)).subject.principal).toBeNull();
  });
});

describe("permdock/workflow: awaitApproval", () => {
  const approvalPolicies = memoryApprovalPolicySource([
    { permission: "invoice.send", approval: "human" },
  ]);

  it("opens a request, waits, and resumes with the token once approved", async () => {
    const store = memoryApprovalStore();
    const waiter = pollingApprovalWaiter({ store, interval: 5 });
    const { workflow, ticketFor } = setup(undefined, {
      approvalPolicies,
      store: store,
      waiter,
    });
    const ticket = await ticketFor();
    const pending = workflow.awaitApproval(
      ticket,
      permissions.invoice.send,
      invoice,
      { operation: operations.send_invoice },
    );
    const token = await pendingToken(store);
    await resolveApproval(store, token, {
      status: "approved",
      by: userSubject("u_9", ["owner"]),
    });
    waiter.wake(token);
    expect((await pending).outcome).toBe("granted");
    expect(
      (await workflow.awaitApproval(ticket, permissions.invoice.read, invoice))
        .outcome,
    ).toBe("granted");
  });

  it("denies when the publisher is demoted while the run waits", async () => {
    const store = memoryApprovalStore();
    const waiter = pollingApprovalWaiter({ store, interval: 5 });
    const { workflow, directory, ticketFor } = setup(undefined, {
      approvalPolicies,
      store: store,
      waiter,
    });
    const ticket = await ticketFor();
    const pending = workflow.awaitApproval(
      ticket,
      permissions.invoice.send,
      invoice,
    );
    const token = await pendingToken(store);
    directory.set("u_1", person("u_1", ["reader"]));
    await resolveApproval(store, token, {
      status: "approved",
      by: userSubject("u_9", ["owner"]),
    });
    expect((await pending).outcome).toBe("denied");
  });

  it("denies a rejected request and returns approval-required without a waiter", async () => {
    const store = memoryApprovalStore();
    const waiter = pollingApprovalWaiter({ store, interval: 5 });
    const { workflow, ticketFor } = setup(undefined, {
      approvalPolicies,
      store: store,
      waiter,
    });
    const ticket = await ticketFor();
    const pending = workflow.awaitApproval(
      ticket,
      permissions.invoice.send,
      invoice,
    );
    const token = await pendingToken(store);
    await resolveApproval(store, token, {
      status: "rejected",
      by: userSubject("u_9", ["owner"]),
    });
    expect(await pending).toMatchObject({
      outcome: "denied",
      denials: [{ reason: "approval", detail: "approval-rejected" }],
    });
    const bare = setup(undefined, { approvalPolicies });
    expect(
      (
        await bare.workflow.awaitApproval(
          await bare.ticketFor(),
          permissions.invoice.send,
          invoice,
        )
      ).outcome,
    ).toBe("approval-required");
  });
});

describe("pollingApprovalWaiter", () => {
  it("rejects on abort and refuses a non-positive interval", async () => {
    const store = memoryApprovalStore();
    const waiter = pollingApprovalWaiter({ store, interval: 5 });
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(
      waiter.wait("pd1.x", { signal: controller.signal }),
    ).rejects.toThrow("stop");
    expect(() => pollingApprovalWaiter({ store, interval: 0 })).toThrow(
      RangeError,
    );
  });

  it("ends at expiry and treats an unknown token as decided", async () => {
    const pendingStore = {
      ...memoryApprovalStore(),
      get: () => {
        throw new Error("down");
      },
    };
    const waiter = pollingApprovalWaiter({ store: pendingStore, interval: 1 });
    await expect(
      waiter.wait("pd1.y", {
        expiresAt: { epochMilliseconds: Date.now() + 10 },
      }),
    ).resolves.toBeUndefined();
    const empty = pollingApprovalWaiter({ store: memoryApprovalStore() });
    await expect(empty.wait("pd1.z")).resolves.toBeUndefined();
  });
});
