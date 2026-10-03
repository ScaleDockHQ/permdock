import { afterEach, describe, expect, it, vi } from "vitest";

import { createPermDock } from "../../src/core/permdock.ts";
import { memoryRelations } from "../../src/core/relations.ts";
import { permissions, policy, rows } from "../fixtures/graph.ts";

const WIDTH = 3;

/** `layers` rows of `WIDTH` teams, every team holding every team of the next row. */
function lattice(layers: number) {
  const team = (layer: number, index: number) => `t${layer}-${index}`;
  const teamMembers: Record<string, string>[] = [];
  for (let layer = 0; layer < layers - 1; layer += 1) {
    for (let from = 0; from < WIDTH; from += 1) {
      for (let to = 0; to < WIDTH; to += 1) {
        teamMembers.push({
          team_id: team(layer, from),
          kind: "team",
          subject_id: team(layer + 1, to),
        });
      }
    }
  }
  for (let index = 0; index < WIDTH; index += 1) {
    teamMembers.push({
      team_id: team(layers - 1, index),
      kind: "user",
      subject_id: "tina",
    });
  }
  return memoryRelations(permissions, {
    rows,
    tables: {
      team_members: teamMembers,
      folder_members: Array.from({ length: WIDTH }, (_, index) => ({
        folder_id: "root",
        role: "viewer",
        kind: "team",
        subject_id: team(0, index),
      })),
    },
  });
}

const rootDoc = rows.doc.find((row) => row.id === "root-doc");

async function loaded(layers: number) {
  const permdock = await createPermDock(
    policy,
    { id: "nobody" },
    { relations: lattice(layers) },
  );
  await permdock.loadRelations(permissions.doc.read, rows.doc);
  return permdock;
}

async function stringifyCalls(layers: number): Promise<number> {
  const permdock = await loaded(layers);
  const spy = vi.spyOn(JSON, "stringify");
  expect(permdock.can(permissions.doc.read, rootDoc)).toBe(false);
  const calls = spy.mock.calls.length;
  spy.mockRestore();
  return calls;
}

async function whoCanCalls(layers: number): Promise<number> {
  const permdock = await loaded(layers);
  await permdock.whoCan(permissions.doc.read, rootDoc);
  const spy = vi.spyOn(JSON, "stringify");
  const result = await permdock.whoCan(permissions.doc.read, rootDoc);
  const calls = spy.mock.calls.length;
  spy.mockRestore();
  expect(
    result.holders.filter((holder) => holder.principal.id === "tina"),
  ).toHaveLength(1);
  return calls;
}

describe("group walks over a shared lattice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("visits each group once per budget, so work grows with the groups, not the paths", async () => {
    const shallow = await stringifyCalls(4);
    const deep = await stringifyCalls(8);
    // 3^8 paths against 3^4 without a memo; the groups only double.
    expect(deep / shallow).toBeLessThan(4);
  });

  it("expands a shared group once in whoCan and lists its members once", async () => {
    const shallow = await whoCanCalls(4);
    const deep = await whoCanCalls(8);
    expect(deep / shallow).toBeLessThan(4);
  });
});
