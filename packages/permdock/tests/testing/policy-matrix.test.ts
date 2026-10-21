import { describe, expect, it } from "vitest";

import {
  allow,
  definePermissions,
  definePolicy,
  deny,
  resource,
  role,
} from "../../src/index.ts";
import {
  policyMatrix,
  policyMatrixLayout,
} from "../../src/testing/policy-matrix.ts";

const permissions = definePermissions({
  doc: resource({
    id: "id",
    actions: ["read", "update"],
    collection: ["list"],
  }),
});

const policy = definePolicy(permissions, {
  roles: [
    role("viewer", [allow(permissions.doc.read), allow(permissions.doc.list)]),
    role("editor", [
      allow([permissions.doc.read, permissions.doc.update]),
      deny(permissions.doc.update, { where: { id: "frozen" }, name: "freeze" }),
    ]),
  ],
  subject: (user: { readonly id: string; readonly role: string } | null) =>
    user === null ? null : { id: user.id, roles: [user.role] },
});

const subjects = {
  vera: { id: "vera", role: "viewer" },
  ed: { id: "ed", role: "editor" },
};

describe(policyMatrix, () => {
  it("decides each cell and lists no failures when the matrix holds", async () => {
    const report = await policyMatrix(policy, {
      subjects,
      fixtures: { open: { id: "d1" }, frozen: { id: "frozen" } },
      matrix: {
        [permissions.doc.read.key]: { vera: "granted", ed: "granted" },
        [permissions.doc.list.key]: { vera: "granted", ed: "denied" },
        [permissions.doc.update.key]: {
          open: { vera: "denied", ed: "granted" },
          frozen: { ed: { outcome: "denied", deniedBy: "freeze" } },
        },
      },
    });
    expect(report.missing).toStrictEqual([]);
    expect(report.cells.map((cell) => [cell.name, cell.actual])).toStrictEqual([
      ["doc.read / vera", "granted"],
      ["doc.read / ed", "granted"],
      ["doc.update / open / vera", "denied"],
      ["doc.update / open / ed", "granted"],
      ["doc.update / frozen / ed", "denied"],
      ["doc.list / vera", "granted"],
      ["doc.list / ed", "denied"],
    ]);
    expect(report.cells.flatMap((cell) => cell.failures)).toStrictEqual([]);
    expect(report.cells[4]).toMatchObject({
      permission: "doc.update",
      fixture: "frozen",
      subject: "ed",
      decision: { outcome: "denied" },
    });
  });

  it("names each disagreement instead of throwing", async () => {
    const report = await policyMatrix(policy, {
      subjects,
      fixtures: { frozen: { id: "frozen" } },
      matrix: {
        [permissions.doc.read.key]: {
          vera: "denied",
          ed: { outcome: "granted", obligations: ["audit"] },
        },
        [permissions.doc.update.key]: {
          vera: { denials: [{ reason: "condition-failed" }] },
          ed: { outcome: "denied", deniedBy: "lock" },
        },
      },
    });
    expect(
      Object.fromEntries(
        report.cells.map((cell) => [cell.name, cell.failures]),
      ),
    ).toStrictEqual({
      "doc.read / vera": ["expected denied, got granted"],
      "doc.read / ed": ["obligations: expected [audit], got []"],
      "doc.update / vera": ["no denial condition-failed; got [no-grant]"],
      "doc.update / ed": [
        "deniedBy: expected lock, explain answered denied by freeze",
      ],
    });
    expect(report.missing).toStrictEqual([permissions.doc.list.key]);
  });

  it("names a denial role, the alternatives and a denial with no named deny", async () => {
    const report = await policyMatrix(policy, {
      subjects,
      exhaustive: false,
      matrix: {
        [permissions.doc.update.key]: {
          vera: {
            denials: [{ reason: "no-grant", role: "editor" }],
            alternatives: [permissions.doc.list.key],
            deniedBy: "freeze",
          },
        },
      },
    });
    expect(report.cells[0]?.failures).toStrictEqual([
      "no denial no-grant for role editor; got [no-grant]",
      "alternatives: expected [doc.list], got [doc.read, doc.list]",
      "deniedBy: expected freeze, explain answered denied",
    ]);
  });

  it("leaves missing empty when the matrix is not exhaustive", async () => {
    const report = await policyMatrix(policy, {
      subjects,
      exhaustive: false,
      matrix: { [permissions.doc.read.key]: { vera: "granted" } },
    });
    expect(report.missing).toStrictEqual([]);
  });

  it("checks the snapshot client with snapshot: true", async () => {
    const report = await policyMatrix(policy, {
      subjects,
      snapshot: true,
      exhaustive: false,
      matrix: { [permissions.doc.list.key]: { vera: "granted" } },
    });
    expect(report.cells[0]?.failures).toStrictEqual([]);
  });

  it("lays out the cells without deciding them", () => {
    expect(
      policyMatrixLayout(policy, {
        subjects,
        fixtures: { open: { id: "d1" } },
        matrix: { [permissions.doc.update.key]: { open: { ed: "granted" } } },
      }),
    ).toStrictEqual([
      {
        name: "doc.update / open / ed",
        permission: "doc.update",
        subject: "ed",
        fixture: "open",
      },
    ]);
  });
});
