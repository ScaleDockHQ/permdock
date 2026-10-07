import { describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";
import type { Principal } from "../../src/core/subject.ts";

import { pd061 } from "../../src/cli/doctor-suspension.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import { allow, definePolicy, role } from "../../src/core/policy.ts";

const permissions = definePermissions(
  {
    workspace: resource({
      actions: ["read", "restore", "export"],
      relations: { workspace: { field: "id", memberOf: "workspace" } },
    }),
  },
  { renamed: { "workspace.recover": "workspace.restore" } },
);

const policy = definePolicy(
  { permissions },
  {
    subject: (user: Principal | null) => user,
    scopes: { workspace: { key: "workspace_id" } },
    roles: [
      role("owner", [allow(permissions.workspace.restore)], {
        on: "workspace",
      }),
    ],
  },
);

function input(keep: unknown) {
  // SAFETY: keep is deliberately untyped to exercise malformed configs.
  const config = {
    policy: "./policy.ts",
    rls: {
      suspension: {
        scopes: {
          workspace: {
            table: "workspaces",
            id: "id",
            disabledAt: "disabled_at",
            keep,
          },
        },
      },
    },
  } as PermDockConfig;
  return { cwd: ".", config, policy: () => Promise.resolve(policy) };
}

describe("PD061", () => {
  it("lists the keys a suspended scope keeps", async () => {
    expect(
      await pd061(input([permissions.workspace.restore, "workspace.export"])),
    ).toEqual([
      expect.objectContaining({
        code: "PD061",
        severity: "warning",
        message:
          "members of a suspended workspace still hold workspace.export, workspace.restore",
      }),
    ]);
  });

  it("names a key the definitions do not declare and a former key", async () => {
    const findings = await pd061(
      input(["workspace.restore", "workspace.recover", "workspace.purge"]),
    );
    expect(findings.map((item) => item.message)).toEqual([
      "members of a suspended workspace still hold workspace.purge, workspace.recover, workspace.restore",
      "rls.suspension.scopes.workspace.keep names workspace.purge, workspace.recover (renamed to workspace.restore), which the definitions do not declare, so a suspended workspace keeps nothing for them",
    ]);
  });

  it("reports a keep it cannot read and stays quiet without one", async () => {
    expect(await pd061(input([7]))).toMatchObject([
      { code: "PD061", message: expect.stringContaining("neither") },
    ]);
    expect(await pd061(input(undefined))).toEqual([]);
    expect(
      await pd061({
        ...input(["workspace.purge"]),
        policy: () => Promise.resolve(undefined),
      }),
    ).toMatchObject([{ message: expect.stringContaining("workspace.purge") }]);
  });
});
