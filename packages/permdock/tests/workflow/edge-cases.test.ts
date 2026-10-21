import { describe, expect, it } from "vitest";

import type { Automation } from "../../src/core/automation.ts";
import type { TokenVerifier } from "../../src/core/interfaces.ts";
import type { Principal } from "../../src/core/subject.ts";
import type { WorkflowPermDockOptions } from "../../src/workflow/index.ts";

import { memoryApprovalStore } from "../../src/approvals/store.ts";
import { memoryApprovalPolicySource } from "../../src/core/approval-policies.ts";
import { joseTokenSigner } from "../../src/jwt/signer.ts";
import { joseTokenVerifier } from "../../src/jwt/verifier.ts";
import {
  signRunTicket,
  subjectFromRunTicket,
} from "../../src/server/run-ticket.ts";
import {
  createPermDock,
  memoryAutomationSource,
} from "../../src/workflow/index.ts";
import {
  invoice,
  permissions,
  person,
  policy,
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

const approvalPolicies = memoryApprovalPolicySource([
  { permission: "invoice.send", approval: "human" },
]);

function setup(
  extra: Partial<WorkflowPermDockOptions> = {},
  people: readonly Principal[] = [person("u_1", ["owner"])],
  records: readonly Automation[] = [published],
) {
  const directory = new Map(people.map((entry) => [entry.id, entry]));
  const looked: string[] = [];
  const principals = {
    principal: (id: string) => {
      looked.push(id);
      return directory.get(id) ?? null;
    },
  };
  const automations = memoryAutomationSource(records);
  const workflow = createPermDock(policy, {
    signer,
    verifier,
    principals,
    automations,
    audience: AUDIENCE,
    issuer: ISSUER,
    ...extra,
  });
  const ticketFor = async (id = "auto_1"): Promise<string> => {
    const started = await workflow.start(id);
    if (started.outcome !== "started") {
      throw new Error(`expected a started run: ${JSON.stringify(started)}`);
    }
    return started.ticket;
  };
  return { workflow, looked, ticketFor };
}

describe("permdock/workflow: start fails closed", () => {
  it("denies with validation when the automation source throws", async () => {
    const { workflow } = setup({
      automations: {
        automation: () => {
          throw new Error("automations down");
        },
      },
    });
    expect(await workflow.start("auto_1")).toStrictEqual({
      outcome: "denied",
      denials: [
        {
          role: null,
          reason: "validation",
          detail: { cause: "automation-unavailable" },
        },
      ],
    });
  });

  it("denies with validation when the automation names a permission the policy lacks", async () => {
    const { workflow } = setup({}, undefined, [
      { ...published, permissions: ["invoice.read", "invoice.archive"] },
    ]);
    expect(await workflow.start("auto_1")).toStrictEqual({
      outcome: "denied",
      denials: [
        {
          role: null,
          reason: "validation",
          detail: { permission: "invoice.archive" },
        },
      ],
    });
  });

  it("starts the run when the sink rejects asynchronously", async () => {
    const written: unknown[] = [];
    const { workflow } = setup({
      sink: {
        write: (events) => {
          written.push(...events);
          return Promise.reject(new Error("sink down"));
        },
      },
    });
    const started = await workflow.start("auto_1");
    expect(started.outcome).toBe("started");
    expect(written).toStrictEqual([
      expect.objectContaining({ type: "automation", operation: "run" }),
    ]);
  });
});

describe("permdock/workflow: getPermDock", () => {
  it("loads the principal of a ticket that names no automation and keeps its delegation", async () => {
    const { workflow, looked } = setup();
    const ticket = await signRunTicket(
      {
        principal: "u_1",
        kind: "job",
        tenant: "o_1",
        delegation: { scopes: ["invoice:read"] },
        expiresIn: 60,
      },
      signer,
      { audience: AUDIENCE },
    );
    const run = await workflow.getPermDock(ticket);
    expect(looked).toStrictEqual(["u_1"]);
    expect(run.subject.principal?.id).toBe("u_1");
    expect(run.can(permissions.invoice.read, invoice)).toBe(true);
    expect(run.can(permissions.invoice.send, invoice)).toBe(false);
  });

  it("gives an anonymous instance when the verifier's result throws on read", async () => {
    const broken: TokenVerifier = {
      verify: () =>
        Promise.resolve({
          ok: true,
          header: { alg: "Ed25519", typ: "vnd.permdock.run+jwt" },
          get claims(): never {
            throw new Error("claims unreadable");
          },
        }),
    };
    const { workflow } = setup({ verifier: broken });
    const run = await workflow.getPermDock("any.ticket.value");
    expect(run.subject.principal).toBeNull();
    expect(run.can(permissions.invoice.read, invoice)).toBe(false);
  });

  it("resolves the anonymous subject without throwing when the verifier's result throws on read", async () => {
    const causes: unknown[] = [];
    const subject = await subjectFromRunTicket("any.ticket.value", {
      verifier: {
        verify: () =>
          Promise.resolve({
            ok: true,
            header: { alg: "Ed25519", typ: "vnd.permdock.run+jwt" },
            get claims(): never {
              throw new Error("claims unreadable");
            },
          }),
      },
      principals: { principal: () => null },
      onAuth: (event) => {
        causes.push(event.cause);
      },
    });
    expect(subject.principal).toBeNull();
    expect(causes).toStrictEqual(["malformed"]);
  });
});

describe("permdock/workflow: approvals without a row or a store", () => {
  it("opens a request against the permission's resource type when the data is no object", async () => {
    const store = memoryApprovalStore();
    const { workflow, ticketFor } = setup({ approvalPolicies, store: store });
    const decision = await workflow.openApproval(
      await ticketFor(),
      permissions.invoice.send,
      null,
    );
    expect(decision.outcome).toBe("approval-required");
    const { items } = await store.list({ status: "pending" });
    expect(items).toHaveLength(1);
    expect(items[0]?.resource).toStrictEqual({ type: "invoice" });
  });

  it("returns the fresh decision from resumeApproval when no store is configured", async () => {
    const { workflow, ticketFor } = setup({ approvalPolicies });
    const ticket = await ticketFor();
    expect(
      (
        await workflow.resumeApproval(
          ticket,
          permissions.invoice.send,
          "pd1.unknown",
          invoice,
        )
      ).outcome,
    ).toBe("approval-required");
    expect(
      (
        await workflow.resumeApproval(
          ticket,
          permissions.invoice.read,
          "pd1.unknown",
          invoice,
        )
      ).outcome,
    ).toBe("granted");
  });
});
