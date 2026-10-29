import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";

import { pd084 } from "../../src/cli/doctor/powersync.ts";
import { powersyncFiles } from "../../src/cli/powersync/powersync.ts";
import { POSTGRES, powersyncPlan } from "../../src/cli/powersync/streams.ts";
import { powersyncYaml } from "../../src/cli/powersync/yaml.ts";
import {
  allow,
  authenticated,
  definePermissions,
  definePolicy,
  principal,
  resource,
} from "../../src/index.ts";

const claim = (name: string) => ({ ref: `principal.claims.${name}` });

const permissions = definePermissions({
  job: resource({ id: "id", actions: ["read"] }),
  note: resource({ id: "id", actions: ["read"] }),
});

const policy = definePolicy(permissions, {
  subject: () => null,
  grants: [
    allow(permissions.job.read, {
      to: authenticated(),
      where: {
        op: "or",
        conditions: [
          { op: "in", field: "team_id", value: claim("team_ids") },
          { op: "eq", field: "region", value: claim("region") },
        ],
      },
    }),
    allow(permissions.note.read, {
      to: authenticated(),
      where: { author_id: principal.id },
    }),
  ],
});

const config: PermDockConfig = {
  policy: "policy.ts",
  rls: { tables: { job: "jobs", note: "notes" } },
  powersync: {},
};

const cwd = mkdtempSync(join(tmpdir(), "permdock-pd084-"));

describe("PowerSync streams that read token claims", () => {
  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("lists the claims each stream reads, in both dialects", () => {
    for (const plan of [
      powersyncPlan(policy, config),
      powersyncPlan(policy, config, POSTGRES),
    ]) {
      expect(
        plan.streams.map((stream) => [stream.name, stream.claims]),
      ).toStrictEqual([
        ["job", ["region", "team_ids"]],
        ["note", []],
      ]);
    }
  });

  it("notes the reconnect in the generated file header", () => {
    const yaml = powersyncYaml(powersyncPlan(policy, config));
    expect(yaml).toContain(
      "# Streams that read token claims keep the claims a connection started with:\n# refresh the session and reconnect PowerSync after a role or tenant change.\n# https://permdock.com/docs/adapters/react-native#role-and-tenant-changes\n#   job reads region, team_ids\nconfig:",
    );
    const plain = definePolicy(permissions, {
      subject: () => null,
      grants: [allow(permissions.note.read, { to: authenticated() })],
    });
    expect(powersyncYaml(powersyncPlan(plain, config))).not.toContain(
      "token claims",
    );
  });

  it("reports PD084 per claim stream in doctor and the command output", async () => {
    const line =
      "stream job reads token claims region, team_ids: PowerSync keeps the claims it connected with, so refresh the session and reconnect after a role or tenant change (/docs/adapters/react-native#role-and-tenant-changes)";
    expect(powersyncFiles(policy, config).claims).toStrictEqual([line]);
    expect(
      await pd084({ cwd, config, policy: async () => policy }),
    ).toStrictEqual([
      {
        code: "PD084",
        severity: "warning",
        message: line,
        fix: "pass nativeRefresh from permdock/react-native to refreshOn, which refreshes the session and reconnects PowerSync on each authz:<uid> message",
      },
    ]);
    expect(
      await pd084({
        cwd,
        config: { policy: "policy.ts" },
        policy: async () => policy,
      }),
    ).toStrictEqual([]);
  });
});
