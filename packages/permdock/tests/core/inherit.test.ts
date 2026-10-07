import { describe, expect, it } from "vitest";

import type { Membership, RelationSource } from "../../src/index.ts";

import { compileGrants } from "../../src/cli/rls-compile.ts";
import { closureDepths, graphPlan, graphSql } from "../../src/cli/rls-graph.ts";
import { inheritTargets, rowHelpersSql } from "../../src/cli/rls-rows.ts";
import { relatedSql } from "../../src/conditions/graph-sql.ts";
import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { matchGrantee } from "../../src/core/grantee.ts";
import { scopeList } from "../../src/core/scopes.ts";
import { parseSnapshot } from "../../src/core/snapshot.ts";
import {
  allow,
  anyone,
  createPermDock,
  definePermissions,
  definePolicy,
  deny,
  inherit,
  memoryRelations,
  relation,
  resource,
  role,
} from "../../src/index.ts";

const permissions = definePermissions({
  drive: resource({
    actions: ["read", "manage"],
    relations: {
      org: { field: "orgId", memberOf: "tenant" },
      viewer: { edge: "drive_shares", object: "drive_id" },
    },
  }),
  folder: resource({
    actions: ["read"],
    links: { drive: { field: "driveId", resource: "drive" } },
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
  node: resource({
    actions: ["read", "delete"],
    parent: { field: "folderId", resource: "folder" },
    links: {
      drive: { field: "driveId", resource: "drive" },
      folder: { field: "folderId", resource: "folder" },
    },
    relations: { org: { field: "orgId", memberOf: "tenant" } },
    restricted: "restricted",
  }),
});

const { drive, folder, node } = permissions;

type User = {
  readonly id: string;
  readonly tenant?: string;
  readonly memberships?: readonly Membership[];
};

const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role("member", [allow(drive.read)], { on: "tenant" }),
    role("blocked", [deny(drive.read)], { on: "tenant" }),
  ],
  grants: [
    allow(drive.read, { to: relation(drive, "viewer") }),
    allow(drive.manage, { to: relation(drive, "viewer") }),
    allow(node.read, { to: inherit(drive.read, { through: ["drive"] }) }),
    allow(folder.read, { to: inherit(drive.read, { through: ["drive"] }) }),
    allow(node.delete, {
      to: inherit(folder.read, { through: "parent" }),
      where: { locked: false },
    }),
  ],
  subject: (user: User) => ({
    id: user.id,
    ...(user.tenant === undefined ? {} : { tenant: user.tenant }),
    memberships: user.memberships ?? [],
  }),
});

const drives = [
  { id: "d1", orgId: "acme" },
  { id: "d2", orgId: "acme" },
];
const folders = [{ id: "f1", orgId: "acme", driveId: "d2" }];
const nodes = [
  { id: "n1", orgId: "acme", driveId: "d1", folderId: "f1", locked: false },
  { id: "n2", orgId: "acme", driveId: "d2", folderId: "f1", locked: false },
  {
    id: "n3",
    orgId: "acme",
    driveId: "d2",
    folderId: "f1",
    locked: false,
    restricted: true,
  },
  { id: "n4", orgId: "acme", driveId: "missing", folderId: "f1" },
];

const relations = memoryRelations(permissions, {
  rows: { drive: drives, folder: folders, node: nodes },
  tables: { drive_shares: [{ drive_id: "d2", user_id: "vera" }] },
});

async function visible(
  user: User,
  source: RelationSource = relations,
): Promise<readonly string[]> {
  const permdock = await createPermDock(policy, user, { relations: source });
  await permdock.loadRelations(node.read, nodes);
  return nodes
    .filter((row) => permdock.can(node.read, row))
    .map((row) => row.id);
}

describe("inherit(): a permission held through a link to another row", () => {
  it("grants the node wherever the subject may read its drive, by role or by share", async () => {
    expect(
      await visible({
        id: "ana",
        tenant: "acme",
        memberships: [{ tenant: "acme", roles: ["member"] }],
      }),
    ).toEqual(["n1", "n2"]);
    expect(await visible({ id: "vera" })).toEqual(["n2"]);
    expect(await visible({ id: "nobody" })).toEqual([]);
  });

  it("follows the target's denies and skips a restricted row and a missing target", async () => {
    expect(
      await visible({
        id: "vera",
        tenant: "acme",
        memberships: [{ tenant: "acme", roles: ["blocked"] }],
      }),
    ).toEqual([]);
  });

  it("chains through the parent and another inherit grant, ANDed with the grant's own where", async () => {
    const permdock = await createPermDock(
      policy,
      { id: "vera" },
      { relations },
    );
    await permdock.loadRelations(node.delete, nodes);
    expect(
      nodes
        .filter((row) => permdock.can(node.delete, row))
        .map((row) => row.id),
    ).toEqual(["n1", "n2"]);
  });

  it("denies with relation-unavailable when the source cannot read rows", async () => {
    const rowless: RelationSource = {
      ancestors: (query) => relations.ancestors(query),
      related: (query) => relations.related(query),
    };
    const permdock = await createPermDock(
      policy,
      { id: "vera" },
      { relations: rowless },
    );
    const decision = permdock.decide(node.read, nodes[1]);
    expect(decision.outcome).toBe("denied");
    expect(
      decision.outcome === "denied"
        ? decision.denials.map((denial) => denial.reason)
        : [],
    ).toContain("relation-unavailable");
  });

  it("denies with relation-unavailable when a row read throws, or rejects", async () => {
    const failing = (
      row: NonNullable<RelationSource["row"]>,
    ): RelationSource => ({
      ancestors: (query) => relations.ancestors(query),
      related: (query) => relations.related(query),
      row,
    });
    for (const source of [
      failing(() => {
        throw new Error("down");
      }),
      failing(() => Promise.reject(new Error("down"))),
    ]) {
      const permdock = await createPermDock(
        policy,
        { id: "vera" },
        { relations: source },
      );
      await permdock.loadRelations(node.read, nodes);
      const decision = permdock.decide(node.read, nodes[1]);
      expect(
        decision.outcome === "denied"
          ? decision.denials.map((denial) => denial.reason)
          : [],
      ).toContain("relation-unavailable");
    }
  });

  it("never matches without a row, so approvers and delegations cannot use it", () => {
    expect(
      matchGrantee(
        inherit(drive.read, { through: ["drive"] }),
        { principal: { id: "vera" }, context: {} },
        0,
        undefined,
      ).matched,
    ).toBe(false);
    expect(() =>
      definePolicy(permissions, {
        delegations: [
          {
            from: inherit(drive.read, { through: ["drive"] }),
            to: { kind: "agent" },
            permissions: [node.read],
          },
        ],
        subject: () => null,
      }),
    ).toThrow(/names a relation or inherit\(\)/u);
  });

  it("is server-only in snapshots and left out of where()", async () => {
    const permdock = await createPermDock(
      policy,
      {
        id: "ana",
        tenant: "acme",
        memberships: [{ tenant: "acme", roles: ["member"] }],
      },
      { relations },
    );
    const client = fromSnapshot(
      parseSnapshot(JSON.stringify(permdock.snapshot())),
    );
    expect(client.can(node.read, nodes[0])).toBe(false);
    expect(permdock.where(node.read).partial).toBe(true);
  });

  it("rejects an unreachable target, a deny, a collection action, an undeclared permission and a cycle", () => {
    expect(() => inherit(drive.read, { through: [] })).toThrow(/through/u);
    const build = (
      grants: NonNullable<Parameters<typeof definePolicy>[1]["grants"]>,
    ) => definePolicy(permissions, { grants, subject: () => null });
    expect(() =>
      build([
        allow(node.read, { to: inherit(drive.read, { through: ["folder"] }) }),
      ]),
    ).toThrow(/do not end on drive/u);
    expect(() =>
      build([
        allow(folder.read, { to: inherit(drive.read, { through: "parent" }) }),
      ]),
    ).toThrow(/has no parent on drive/u);
    expect(() =>
      build([
        deny(node.read, { to: inherit(drive.read, { through: ["drive"] }) }),
      ]),
    ).toThrow(/allowed on an allow only/u);
    const other = definePermissions({
      secret: resource({ actions: ["read"] }),
    });
    expect(() =>
      build([
        allow(node.read, {
          to: inherit(other.secret.read, { through: ["drive"] }),
        }),
      ]),
    ).toThrow(/does not declare it/u);
    const tree = definePermissions({
      item: resource({
        actions: ["read", "write"],
        parent: { field: "parentId", resource: "item" },
      }),
    });
    expect(() =>
      definePolicy(tree, {
        grants: [
          allow(tree.item.read, {
            to: inherit(tree.item.write, { through: "parent" }),
          }),
          allow(tree.item.write, {
            to: inherit(tree.item.read, { through: "parent" }),
          }),
        ],
        subject: () => null,
      }),
    ).toThrow(/cycle: item.read -> item.write -> item.read/u);
  });
});

describe("inherit() in generated RLS", () => {
  it("checks the link column against the target's row helper", () => {
    const compiled = compileGrants(
      policy,
      {
        dialect: "supabase" as const,
        scopes: scopeList(policy.scopes),
        tenantClaim: "tenant_id",
        gucPrefix: "app",
        graph: { resources: policy.resources, closures: {} },
      },
      undefined,
      [],
      false,
    );
    const branch = compiled.branches.find(
      (item) => item.permissionKey === "node.read",
    );
    expect(branch?.using).toBe(
      `(coalesce("driveId"::text in (select "permdock".permitted_drive_rows('drive.read')), false) and "restricted" is not true)`,
    );
    expect(branch?.roles).toEqual(["authenticated"]);
  });

  it("writes a stub for each inherited row helper before the helpers that call it", () => {
    const ctx = {
      dialect: "supabase" as const,
      scopes: scopeList(policy.scopes),
      tenantClaim: "tenant_id",
      gucPrefix: "app",
      graph: { resources: policy.resources, closures: {} },
    };
    const compiled = compileGrants(policy, ctx, undefined, [], false, true);
    expect(inheritTargets(policy)).toEqual(["drive", "folder"]);
    const sql = rowHelpersSql(
      ctx,
      policy,
      [...compiled.branches, ...compiled.actionBranches],
      ["node"],
      undefined,
      [],
    );
    const stub = sql.indexOf("select null::text where false");
    const driveHelper = sql.indexOf(
      '"permdock".permitted_drive_rows(p_permission text)',
    );
    expect(stub).toBeGreaterThan(-1);
    expect(driveHelper).toBeGreaterThan(-1);
    expect(stub).toBeLessThan(sql.indexOf("when 'node.read' then"));
    expect(sql).toContain("permitted_folder_rows");
    expect(sql).toContain("permitted_node_rows");
  });

  it("adds the link helpers a multi-link inherit crosses and has no ORM form", () => {
    const tree = definePermissions({
      drive: resource({ actions: ["read"] }),
      folder: resource({
        actions: ["read"],
        links: { drive: { field: "driveId", resource: "drive" } },
      }),
      node: resource({
        actions: ["read"],
        links: { folder: { field: "folderId", resource: "folder" } },
      }),
    });
    const linked = definePolicy(tree, {
      grants: [
        allow(tree.drive.read, { to: anyone() }),
        allow(tree.node.read, {
          to: inherit(tree.drive.read, { through: ["folder", "drive"] }),
        }),
      ],
      subject: () => null,
    });
    const plan = graphPlan(linked);
    expect([...(plan.get("folder")?.links ?? [])]).toEqual(["drive"]);
    expect(closureDepths(plan)).toEqual({});
    expect(
      graphSql(
        {
          dialect: "supabase",
          scopes: scopeList(linked.scopes),
          tenantClaim: "tenant_id",
          gucPrefix: "app",
        },
        plan,
        undefined,
      ),
    ).toContain("permdock_link_folder_drive");
    expect(() =>
      relatedSql(
        {
          op: "related",
          resource: "drive",
          relation: "",
          permission: "drive.read",
          field: "driveId",
          depth: 0,
        },
        { resources: linked.resources },
      ),
    ).toThrow(/no query form outside generated RLS/u);
  });
});
