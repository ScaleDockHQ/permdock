import { afterEach, describe, expect, it } from "vitest";

import type { RlsActions } from "../../src/cli/types.ts";

import { runDoctor } from "../../src/cli/doctor/doctor.ts";
import { pd071, pd076 } from "../../src/cli/doctor/rls.ts";
import {
  NOW,
  policyModule,
  project,
  quietIo,
  removeProjects,
} from "./doctor-kit.ts";

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

describe("PD076", () => {
  it("reports 'none' on a verb that compiles to none anyway, and verbs no permission uses", async () => {
    const findings = await pd076({
      cwd: invoices(),
      config: config({
        export: "none",
        market: "none",
        aprove: "update",
        approve: "none",
        read: "none",
        markPaid: "update",
      }),
    });
    expect(findings).toEqual([
      {
        code: "PD076",
        severity: "info",
        message:
          "rls.actions sets export, market to 'none', which is already what those verbs compile to",
        fix: "delete these entries: export, market",
      },
      {
        code: "PD076",
        severity: "info",
        message: "rls.actions maps aprove, which no permission uses",
        fix: "delete these entries, or fix the verb's spelling: aprove",
      },
    ]);
  });

  it("keeps a write-sounding 'none', which silences PD071, and a 'none' on a default verb", async () => {
    expect(
      await pd076({
        cwd: invoices(),
        config: config({ approve: "none", update: "none", read: "none" }),
      }),
    ).toEqual([]);
  });

  it("is a hint that --fail-on warning does not fail on", async () => {
    const result = await runDoctor({
      cwd: invoices(),
      config: config({ export: "none" }),
      only: ["pd076"],
      json: false,
      fix: false,
      strict: true,
      color: false,
      now: NOW,
      io: quietIo,
    });
    expect(result.code).toBe(0);
    expect(result.output).toContain("info PD076");
    expect(result.output).toContain("0 errors, 0 warnings, 1 note");
    expect(result.findings.map((finding) => finding.severity)).toEqual([
      "info",
    ]);
  });
});
