import { describe } from "vitest";

import type { Automation } from "../../src/index.ts";

import { memoryAutomationSource } from "../../src/index.ts";
import {
  testAutomationSource,
  testSupportSessionSource,
} from "../../src/testing/index.ts";

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
