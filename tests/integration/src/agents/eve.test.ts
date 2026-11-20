import type {
  ApprovalContext,
  ApprovalResponseContext,
  ApprovalStatus,
} from "eve/tools/approval";
import type { EvePermDock } from "permdock/eve";

import { createPermDock } from "permdock/eve";
import { saasPolicy } from "permdock/testing/saas";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AgentDb } from "../support/agents.ts";

import {
  agentDelegation,
  agentSubject,
  agentTools,
  projectLoader,
  startAgentDb,
  TENANT,
} from "../support/agents.ts";

type Principal = ApprovalResponseContext["response"]["principal"];

function principal(id: string): Principal {
  return {
    principalId: id,
    principalType: "user",
    authenticator: "test",
    attributes: {},
  };
}

const alice = principal("alice");
const carol = principal("carol");
const turn = { id: "turn-1", sequence: 1 };

/** The context eve's harness passes `approval.request` (`decideApproval`). */
function requestContext(
  callId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): ApprovalContext {
  return {
    abortSignal: new AbortController().signal,
    callId,
    getSandbox: () => Promise.reject(new Error("no sandbox in this test")),
    session: {
      id: "session-1",
      auth: { initiator: alice, current: alice },
      turn,
    },
    toolInput,
    toolName,
  };
}

/** The context eve's responder check passes `approval.response` (`weigh`). */
function responseContext(
  callId: string,
  toolName: string,
  responder: Principal,
): ApprovalResponseContext {
  return {
    auth: {
      getToken: () => Promise.reject(new Error("no token in this test")),
      requireAuth: () => {
        throw new Error("no sign-in in this test");
      },
    },
    request: {
      callId,
      interactionId: `interaction-${callId}`,
      principal: alice,
      toolInput: {},
      toolName,
    },
    response: { decision: "approve", principal: responder },
    session: { id: "session-1", initiator: alice, turn },
  };
}

function isDenied(status: ApprovalStatus): boolean {
  return (
    status === false ||
    status === "denied" ||
    (typeof status === "object" && status.type === "denied")
  );
}

function asksPerson(status: ApprovalStatus): boolean {
  return (
    status === "user-approval" ||
    (typeof status === "object" && status.type === "user-approval")
  );
}

/**
 * One tool call as eve's harness runs it: `request` decides; a call that asks a
 * person parks; the re-check after the answer runs the tool unless it is denied
 * (`evaluateApproval` treats `user-approval` as cleared on a re-check). eve
 * exports no function that does this outside a running session.
 */
async function drive(
  adapter: EvePermDock,
  call: {
    readonly id: string;
    readonly tool: string;
    readonly input: Record<string, unknown>;
    readonly run: () => unknown;
    readonly recheck?: boolean;
  },
): Promise<"ran" | "parked" | "denied"> {
  const status = await adapter.approval.request(
    requestContext(call.id, call.tool, call.input),
  );
  if (isDenied(status)) {
    return "denied";
  }
  if (asksPerson(status) && call.recheck !== true) {
    return "parked";
  }
  call.run();
  return "ran";
}

let db: AgentDb;
let rows: ReturnType<typeof projectLoader>;

describe("eve", () => {
  beforeAll(async () => {
    db = await startAgentDb();
    rows = projectLoader(db.pg.uri);
  });

  afterAll(async () => {
    await rows.close();
    await db.stop();
  });

  async function permdock(): Promise<EvePermDock> {
    return createPermDock(saasPolicy, {
      subject: ({ session: current }) =>
        agentSubject({ user: current?.auth?.initiator?.principalId }),
      tenant: TENANT,
      delegation: agentDelegation,
      operations: agentTools(rows.load),
      store: await db.openStore(),
    });
  }

  describe("permdock/eve with eve 1.2.0 approval contexts on Postgres", () => {
    it("parks, takes an owner response on another instance, runs once on the re-check and denies the replay", async () => {
      const deleted = vi.fn<() => void>();
      const revoked = vi.fn<() => void>();
      const gate = await permdock();

      expect(
        await drive(gate, {
          id: "c1",
          tool: "delete_project",
          input: { id: "p1" },
          run: deleted,
        }),
      ).toBe("ran");
      expect(
        await drive(gate, {
          id: "c2",
          tool: "delete_project",
          input: { id: "p4" },
          run: deleted,
        }),
      ).toBe("denied");
      expect(deleted).toHaveBeenCalledTimes(1);

      const revoke = {
        id: "c3",
        tool: "revoke_api_keys",
        input: {},
        run: revoked,
      };
      expect(await drive(gate, revoke)).toBe("parked");

      const reviewer = await permdock();
      expect(
        await reviewer.approval.response(
          responseContext("c3", "revoke_api_keys", alice),
        ),
      ).toMatchObject({ status: "rejected" });
      expect(
        await reviewer.approval.response(
          responseContext("c3", "revoke_api_keys", carol),
        ),
      ).toStrictEqual({ status: "allowed" });

      expect(await drive(await permdock(), { ...revoke, recheck: true })).toBe(
        "ran",
      );
      expect(revoked).toHaveBeenCalledTimes(1);

      expect(await drive(await permdock(), { ...revoke, recheck: true })).toBe(
        "denied",
      );
      expect(revoked).toHaveBeenCalledTimes(1);
    });
  });
});
