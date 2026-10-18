import { afterEach, describe, expect, it } from "vitest";

import type { RlsActions } from "../../src/cli/types.ts";

import { pd071 } from "../../src/cli/doctor/rls.ts";
import { policyModule, project, removeProjects } from "./doctor-kit.ts";

afterEach(removeProjects);

const PERMISSIONS = `import { definePermissions, resource } from 'permdock';

export const permissions = definePermissions({
  invoice: resource({
    actions: ['read', 'update', 'approve', 'markPaid', 'writeOff', 'market', 'export', 'send_reminder'],
  }),
  order: resource({ actions: ['approve', 'cancel'] }),
});
`;

function invoices(): string {
  return project({
    "src/permissions.ts": PERMISSIONS,
    "src/policy.ts": policyModule("roles: [],"),
  });
}

const config = (actions?: RlsActions) => ({
  permissions: "src/permissions.ts",
  policy: "src/policy.ts",
  rls: {
    dialect: "supabase" as const,
    ...(actions === undefined ? {} : { actions }),
  },
});

describe("PD071", () => {
  it("names each unmapped verb that reads as a write, with its permissions", async () => {
    const findings = await pd071({ cwd: invoices(), config: config() });
    expect(findings.map((finding) => finding.message)).toEqual([
      "action 'approve' (invoice.approve, order.approve) reads as a write but has no rls.actions entry, so it compiles to 'none' and adds no SQL policy",
      "action 'cancel' (order.cancel) reads as a write but has no rls.actions entry, so it compiles to 'none' and adds no SQL policy",
      "action 'markPaid' (invoice.markPaid) reads as a write but has no rls.actions entry, so it compiles to 'none' and adds no SQL policy",
      "action 'send_reminder' (invoice.send_reminder) reads as a write but has no rls.actions entry, so it compiles to 'none' and adds no SQL policy",
      "action 'writeOff' (invoice.writeOff) reads as a write but has no rls.actions entry, so it compiles to 'none' and adds no SQL policy",
    ]);
    expect(findings[0]).toMatchObject({
      code: "PD071",
      severity: "warning",
      fix: 'map it on purpose in rls.actions: approve: "insert", "update", "delete" or "none"',
    });
  });

  it("passes verbs mapped on purpose, including to 'none'", async () => {
    const actions: RlsActions = {
      approve: "none",
      cancel: "update",
      markPaid: "update",
      send_reminder: "none",
      writeOff: "update",
    };
    expect(await pd071({ cwd: invoices(), config: config(actions) })).toEqual(
      [],
    );
  });

  it("does nothing without rls", async () => {
    expect(
      await pd071({
        cwd: invoices(),
        config: { permissions: "src/permissions.ts", policy: "src/policy.ts" },
      }),
    ).toEqual([]);
  });
});
