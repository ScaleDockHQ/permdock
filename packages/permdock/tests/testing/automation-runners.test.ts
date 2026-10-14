import { describe } from "vitest";

import type { ApprovalRequest } from "../../src/approvals/types.ts";
import type { Automation } from "../../src/index.ts";
import type {
  WorkflowSdkCreateHook,
  WorkflowSdkHook,
  WorkflowSdkResumeHook,
} from "../../src/workflow-sdk/index.ts";

import { memoryApprovalStore } from "../../src/approvals/store.ts";
import { memoryAutomationSource } from "../../src/index.ts";
import {
  testApprovalWaiter,
  testAutomationSource,
  testSupportSessionSource,
} from "../../src/testing/index.ts";
import {
  approvalHookToken,
  workflowSdkWaiter,
} from "../../src/workflow-sdk/index.ts";
import { pollingApprovalWaiter } from "../../src/workflow/index.ts";

const global: Automation = {
  v: 1,
  id: "auto_2",
  version: 1,
  mode: "publisher",
  principal: "u_1",
  publishedBy: "u_1",
  publishedAt: "2026-10-14T09:00:00.000Z",
  operations: ["read_invoice"],
  permissions: ["invoice.read"],
};

const published: Automation = { ...global, id: "auto_1", tenant: "o_1" };

describe("testAutomationSource over memoryAutomationSource", () => {
  testAutomationSource(memoryAutomationSource([published, global]), {
    automations: [
      { id: "auto_1", expect: published },
      { id: "auto_1", tenant: "o_1", expect: published },
      { id: "auto_2" },
      { id: "auto_missing", expect: null },
    ],
  });
});

describe("testAutomationSource over a source that throws", () => {
  testAutomationSource(
    {
      automation: () => {
        throw new Error("down");
      },
    },
    { automations: [{ id: "auto_1", expect: null }] },
  );
});

const sessions = new Map([
  ["ss_live", { id: "ss_live" }],
  ["ss_ended", { id: "ss_ended", ended: true }],
]);

describe("testSupportSessionSource over a map", () => {
  testSupportSessionSource(
    { session: (id) => Promise.resolve(sessions.get(id) ?? null) },
    {
      sessions: [
        { id: "ss_live", ended: false },
        { id: "ss_ended", ended: true },
        { id: "ss_missing", ended: null },
        { id: "ss_live" },
      ],
    },
  );
});

function pendingRequest(token: string): ApprovalRequest {
  return {
    v: 1,
    id: `apr_${token}`,
    token,
    permission: "invoice.send",
    scope: "invoice:send",
    resource: { type: "invoice", id: "inv_1" },
    subject: { principal: { id: "u_1", roles: ["billing"] } },
    detail: "invoice.send requires human approval.",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    status: "pending",
  };
}

describe("testApprovalWaiter over pollingApprovalWaiter", () => {
  const store = memoryApprovalStore();
  let count = 0;
  testApprovalWaiter(pollingApprovalWaiter({ store, interval: 5 }), {
    pending: async (label) => {
      count += 1;
      const token = `${label}-${count}`;
      await store.create(pendingRequest(token));
      return token;
    },
  });
});

describe("testApprovalWaiter over workflowSdkWaiter", () => {
  const parked = new Map<string, () => void>();
  const createHook: WorkflowSdkCreateHook = ({ token }) => {
    const payload = new Promise<unknown>((resolve) => {
      parked.set(token, () => {
        resolve(null);
      });
    });
    const hook: WorkflowSdkHook = {
      // oxlint-disable-next-line unicorn/no-thenable -- a Workflow SDK Hook is a bare thenable
      then: (onFulfilled, onRejected) => payload.then(onFulfilled, onRejected),
      dispose: () => {
        parked.delete(token);
      },
    };
    return hook;
  };
  const resumeHook: WorkflowSdkResumeHook = (token) => {
    const resume = parked.get(token);
    if (resume === undefined) {
      return Promise.reject(new Error("HookNotFoundError"));
    }
    resume();
    return Promise.resolve({ token });
  };
  testApprovalWaiter(
    workflowSdkWaiter({
      createHook,
      resumeHook,
      sleep: (until) =>
        new Promise((resolve) => {
          setTimeout(resolve, Math.max(0, until.getTime() - Date.now()));
        }),
    }),
    {
      abort: false,
      parked: async (token) => {
        while (!parked.has(approvalHookToken(token))) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 1);
          });
        }
      },
    },
  );
});
