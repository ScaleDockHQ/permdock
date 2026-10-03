import { describe, expect, it } from "vitest";
import { z } from "zod";

import { relation } from "../../src/core/grantee.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import { allow, definePolicy } from "../../src/core/policy.ts";
import { memoryRelations } from "../../src/core/relations.ts";
import { testRelationSource } from "../../src/testing/conformance.ts";
import {
  engAdmin,
  permissions,
  policy,
  relations,
  rows,
} from "../fixtures/graph.ts";

type User = Parameters<typeof policy.subject>[0];

const docs = Object.fromEntries(rows.doc.map((row) => [row.id, row]));

async function permdock(user: User | string) {
  const instance = await createPermDock(
    policy,
    typeof user === "string" ? { id: user } : user,
    { relations },
  );
  await instance.loadRelations(permissions.doc.read, rows.doc);
  await instance.loadRelations(permissions.doc.review, rows.doc);
  return instance;
}

async function readers(id: string): Promise<string[]> {
  const out: string[] = [];
  for (const user of [
    "vera",
    "eddie",
    "carl",
    "tina",
    "ex",
    "hana",
    "lena",
    engAdmin,
  ]) {
    const instance = await permdock(user);
    if (instance.can(permissions.doc.read, docs[id])) {
      out.push(typeof user === "string" ? user : user.id);
    }
  }
  return out;
}

describe("relationship graph: match, includes, groups, links", () => {
  testRelationSource(relations, {
    objects: [
      { resource: "folder", id: "deep", relation: "viewer" },
      { resource: "folder", id: "platform", relation: "viewer" },
      { resource: "team", id: "eng-team", relation: "member" },
    ],
    expect: {
      ancestors: { "folder:deep": ["platform", "eng", "root"] },
      holders: {
        "folder:platform#viewer": ["team:eng-team#member"],
        "team:eng-team#member": ["carl", "team:sre#member"],
      },
      links: { "doc:deep-doc>folder": "deep", "folder:deep>team": "sre" },
    },
  });

  it("reaches a deep document through ancestors, included relations and nested groups", async () => {
    expect(await readers("deep-doc")).toEqual([
      "vera",
      "eddie",
      "carl",
      "tina",
      "ada",
    ]);
  });

  it("never reads above a folder role or a relation holder", async () => {
    expect(await readers("root-doc")).toEqual(["vera"]);
    expect(await readers("eng-doc")).toEqual(["vera", "eddie", "ada"]);
  });

  it("reads a restricted branch only through its own holders", async () => {
    expect(await readers("pay-doc")).toEqual(["hana"]);
  });

  it("denies an expired share", async () => {
    const ex = await permdock("ex");
    expect(ex.can(permissions.doc.read, docs["eng-doc"])).toBe(false);
  });

  it("follows named links to the owning team", async () => {
    const lena = await permdock("lena");
    expect(lena.can(permissions.doc.review, docs["deep-doc"])).toBe(true);
    expect(lena.can(permissions.doc.review, docs["eng-doc"])).toBe(false);
    const lee = await permdock("lee");
    expect(lee.can(permissions.doc.review, docs["eng-doc"])).toBe(true);
    expect(lee.can(permissions.doc.review, docs["root-doc"])).toBe(false);
  });

  it("matches the edge role column literally", async () => {
    const edit = memoryRelations(permissions, {
      rows,
      tables: {
        folder_members: [
          {
            folder_id: "root",
            role: "owner",
            kind: "user",
            subject_id: "vera",
          },
        ],
      },
    });
    const vera = await createPermDock(
      policy,
      { id: "vera" },
      {
        relations: edit,
      },
    );
    await vera.loadRelations(permissions.doc.read, rows.doc);
    expect(vera.can(permissions.doc.read, docs["root-doc"])).toBe(false);
  });

  it("ignores a row whose kind names no declared group", async () => {
    const odd = memoryRelations(permissions, {
      rows,
      tables: {
        folder_members: [
          {
            folder_id: "root",
            role: "viewer",
            kind: "robot",
            subject_id: "vera",
          },
        ],
      },
    });
    const vera = await createPermDock(
      policy,
      { id: "vera" },
      {
        relations: odd,
      },
    );
    await vera.loadRelations(permissions.doc.read, rows.doc);
    expect(vera.can(permissions.doc.read, docs["root-doc"])).toBe(false);
  });

  it("denies a group cycle with relation-depth", async () => {
    const cyclic = memoryRelations(permissions, {
      rows,
      tables: {
        team_members: [
          { team_id: "eng-team", kind: "team", subject_id: "sre" },
          { team_id: "sre", kind: "team", subject_id: "eng-team" },
        ],
        folder_members: [
          {
            folder_id: "root",
            role: "viewer",
            kind: "team",
            subject_id: "eng-team",
          },
        ],
      },
    });
    const sam = await createPermDock(
      policy,
      { id: "sam" },
      {
        relations: cyclic,
      },
    );
    await sam.loadRelations(permissions.doc.read, rows.doc);
    const decision = sam.decide(permissions.doc.read, docs["root-doc"]);
    expect(decision).toMatchObject({
      outcome: "denied",
      denials: expect.arrayContaining([
        expect.objectContaining({ reason: "relation-depth" }),
      ]),
    });
  });

  it("keeps a folder role to its own folder without a relation source", async () => {
    const ada = await createPermDock(policy, engAdmin);
    expect(ada.can(permissions.doc.read, docs["eng-doc"])).toBe(true);
    expect(ada.can(permissions.doc.read, docs["deep-doc"])).toBe(false);
    expect(
      JSON.stringify(ada.where(permissions.doc.read).condition),
    ).not.toContain('"ids"');
  });

  it("puts graph grants and walking folder roles into where()", async () => {
    const ada = await permdock(engAdmin);
    const where = ada.where(permissions.doc.read);
    expect(where.partial).toBe(false);
    expect(JSON.stringify(where.condition)).toContain('"ids":["eng"]');
  });

  it("whoCan expands groups and names the concrete relation", async () => {
    const owner = await permdock("vera");
    const result = await owner.whoCan(permissions.doc.read, docs["deep-doc"]);
    // Folder-role holders need a MembershipSource that lists folder memberships.
    expect(result.complete).toBe(false);
    const ids = result.holders.map((holder) => holder.principal.id);
    expect(ids).toEqual(
      expect.arrayContaining(["vera", "eddie", "carl", "tina"]),
    );
    expect(ids).not.toContain("ex");
    const tina = result.holders.find(
      (holder) => holder.principal.id === "tina",
    );
    expect(tina?.via).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "share",
          relation: "viewer",
          id: "platform",
          group: { resource: "team", id: "eng-team", relation: "member" },
        }),
      ]),
    );
    const eddie = result.holders.find(
      (holder) => holder.principal.id === "eddie",
    );
    expect(eddie?.via).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relation: "editor", id: "eng" }),
      ]),
    );
  });
});

describe("relationship graph declarations", () => {
  const Row = z.object({ id: z.string(), parentId: z.string().nullable() });

  it("rejects an includes cycle and an unknown include", () => {
    expect(() =>
      definePermissions({
        folder: resource(Row, {
          actions: ["read"],
          relations: {
            a: { edge: "a", includes: ["b"] },
            b: { edge: "b", includes: ["a"] },
          },
        }),
      }),
    ).toThrow(/cycle/);
    expect(() =>
      definePermissions({
        folder: resource(Row, {
          actions: ["read"],
          relations: { a: { edge: "a", includes: ["missing"] } },
        }),
      }),
    ).toThrow(/missing/);
  });

  it("rejects a group resource that is not declared", () => {
    expect(() =>
      definePermissions({
        folder: resource(Row, {
          actions: ["read"],
          relations: {
            viewer: {
              edge: "folder_members",
              groups: { column: "kind", resources: { team: "member" } },
            },
          },
        }),
      }),
    ).toThrow(/team/);
  });

  it("rejects a link named parent and a path that does not end at the relation", () => {
    expect(() =>
      definePermissions({
        folder: resource(Row, {
          actions: ["read"],
          links: { parent: { field: "parentId", resource: "folder" } },
        }),
      }),
    ).toThrow(/parent/);
    expect(() =>
      definePolicy(permissions, {
        grants: [
          allow(permissions.doc.review, {
            to: relation(permissions.team, "lead", { through: ["folder"] }),
          }),
        ],
        subject: (user: { readonly id: string }) => ({ id: user.id }),
      }),
    ).toThrow(/do not end on team/);
  });
});
