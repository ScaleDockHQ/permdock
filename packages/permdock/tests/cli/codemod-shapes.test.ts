import { describe, expect, it } from "vitest";

import { CODEMOD_0_5 as SET } from "../../src/cli/codemod/codemod.ts";
import { transformSource } from "../../src/cli/codemod/transform.ts";

function apply(lines: readonly string[], file = "file.tsx") {
  return transformSource(file, lines.join("\n"), SET);
}

describe("the denied slot", () => {
  it("renames fallback on a Protected element bound to a UI kit import", () => {
    const result = apply([
      'import { Protected } from "permdock/react";',
      "export const a = <Protected permission={p} fallback={<Locked />}>x</Protected>;",
      "export const b = <Protected permission={p} pending={null} />;",
    ]);
    expect(result.source.split("\n")[1]).toBe(
      "export const a = <Protected permission={p} denied={<Locked />}>x</Protected>;",
    );
    expect(result.changes).toEqual([
      { line: 2, column: 44, from: "fallback", to: "denied" },
    ]);
  });

  it("leaves fallback on other components and on a shadowed Protected alone", () => {
    const source = [
      'import { Protected } from "permdock/solid";',
      'import { Suspense } from "react";',
      "export const a = <Suspense fallback={null}>x</Suspense>;",
      "export function B(Protected: () => null) { return <Protected fallback={1} />; }",
    ];
    expect(apply(source).source).toBe(source.join("\n"));
  });

  it("renames the fallback key of the provider defaults", () => {
    const result = apply([
      'import { PermDockProvider } from "permdock/react-native";',
      "const fallback = null;",
      "export const a = <PermDockProvider defaults={{ fallback }} />;",
      "export const b = <PermDockProvider defaults={{ fallback: null, pending: null }} />;",
    ]);
    expect(result.source.split("\n").slice(2)).toEqual([
      "export const a = <PermDockProvider defaults={{ denied: fallback }} />;",
      "export const b = <PermDockProvider defaults={{ denied: null, pending: null }} />;",
    ]);
  });

  it("reports provider defaults it cannot read and an unbound provider", () => {
    const result = apply([
      'import { PermDockProvider } from "permdock/react";',
      'import { kit } from "./permdock";',
      "export const a = <PermDockProvider defaults={defaults} />;",
      "export const b = <kit.PermDockProvider defaults={{ fallback: null }} />;",
    ]);
    expect(result.changes).toEqual([]);
    expect(result.followUps.map((item) => [item.line, item.message])).toEqual([
      [3, "`defaults.fallback` of `<PermDockProvider>` is `defaults.denied`"],
      [4, "`defaults.fallback` of `<PermDockProvider>` is `defaults.denied`"],
    ]);
  });

  it("renames the fallback slot in a render function call", () => {
    const result = apply(
      [
        'import { h } from "vue";',
        'import { Protected } from "permdock/vue";',
        "export const a = () => h(Protected, { permission: p }, { fallback: () => 'no' });",
      ],
      "file.ts",
    );
    expect(result.source.split("\n")[2]).toBe(
      "export const a = () => h(Protected, { permission: p }, { denied: () => 'no' });",
    );
  });

  it("reports a Vue template slot and a Svelte snippet", () => {
    const vue = transformSource(
      "Gate.vue",
      [
        '<script setup lang="ts">',
        'import { Protected } from "permdock/vue";',
        "</script>",
        "<template>",
        '  <Protected :permission="p"><template #fallback>no</template></Protected>',
        "</template>",
      ].join("\n"),
      SET,
    );
    expect(vue.followUps).toEqual([
      {
        line: 5,
        column: 40,
        name: "fallback",
        message: "the `<Protected>` slot `fallback` is `denied`: `#denied`",
      },
    ]);
    const svelte = transformSource(
      "Gate.svelte",
      [
        "<script>",
        'import { Protected } from "permdock/svelte";',
        "</script>",
        "<Protected permission={p}>{#snippet fallback(decision)}no{/snippet}</Protected>",
      ].join("\n"),
      SET,
    );
    expect(svelte.followUps.map((item) => [item.line, item.column])).toEqual([
      [4, 27],
    ]);
  });

  it("reports no template slot when the file does not import Protected", () => {
    const vue = transformSource(
      "Other.vue",
      [
        "<script setup>",
        'import { useCan } from "permdock/vue";',
        "</script>",
        "<template><Suspense><template #fallback>…</template></Suspense></template>",
      ].join("\n"),
      SET,
    );
    expect(vue.followUps).toEqual([]);
  });
});

describe("awaited createPermDock", () => {
  it("calls loadPermDock where the instance is awaited and drops the unused import", () => {
    const result = apply(
      [
        'import { createPermDock } from "permdock";',
        'import { policy } from "./policy";',
        "export async function load(user: User) {",
        "  return await createPermDock(policy, user, { memberships });",
        "}",
      ],
      "file.ts",
    );
    expect(result.source.split("\n")).toEqual([
      'import { loadPermDock } from "permdock";',
      'import { policy } from "./policy";',
      "export async function load(user: User) {",
      "  return await loadPermDock(policy, user, { memberships });",
      "}",
    ]);
    expect(result.changes).toEqual([
      { line: 4, column: 16, from: "createPermDock", to: "loadPermDock" },
    ]);
  });

  it("keeps createPermDock for synchronous calls and adds loadPermDock beside it", () => {
    const result = apply(
      [
        "import { createPermDock, definePolicy } from 'permdock';",
        "export const a = createPermDock(policy, user);",
        "export const b = await createPermDock(policy, user, options);",
      ],
      "file.ts",
    );
    expect(result.source.split("\n")).toEqual([
      "import { createPermDock, definePolicy, loadPermDock } from 'permdock';",
      "export const a = createPermDock(policy, user);",
      "export const b = await loadPermDock(policy, user, options);",
    ]);
  });

  it("removes a middle specifier and reuses an existing loadPermDock import", () => {
    const result = apply(
      [
        'import { can, createPermDock, loadPermDock as load } from "permdock";',
        "export const b = await createPermDock(policy, user);",
        "export const c = can;",
      ],
      "file.ts",
    );
    expect(result.source.split("\n")).toEqual([
      'import { can, loadPermDock as load } from "permdock";',
      "export const b = await load(policy, user);",
      "export const c = can;",
    ]);
  });

  it("rewrites a namespace call and reports a captured name", () => {
    const result = apply(
      [
        'import * as pd from "permdock";',
        'import { createPermDock } from "permdock";',
        "export const a = await pd.createPermDock(policy, user);",
        "export async function b(loadPermDock: unknown) {",
        "  return await createPermDock(policy, user);",
        "}",
      ],
      "file.ts",
    );
    expect(result.source.split("\n")[2]).toBe(
      "export const a = await pd.loadPermDock(policy, user);",
    );
    expect(result.source.split("\n")[4]).toBe(
      "  return await createPermDock(policy, user);",
    );
    expect(result.followUps.map((item) => item.message)).toEqual([
      "`createPermDock` is `loadPermDock` from `permdock` here; `loadPermDock` is already bound in this scope",
    ]);
  });

  it("reports a returned or chained createPermDock call", () => {
    const result = apply(
      [
        'import { createPermDock } from "permdock";',
        "export const a = (user: User) => createPermDock(policy, user);",
        "export function b(user: User) { return createPermDock(policy, user); }",
        "createPermDock(policy, null).then(use);",
      ],
      "file.ts",
    );
    expect(result.changes).toEqual([]);
    expect(result.followUps.map((item) => item.line)).toEqual([2, 3, 4]);
    expect(result.followUps[0]?.message).toBe(
      "`createPermDock` returns the instance, never a Promise; call `loadPermDock` when a source answers asynchronously",
    );
  });

  it("renames createPermDock from permdock/pdp, which was always async", () => {
    const result = apply(
      [
        'import { createPermDock } from "permdock/pdp";',
        'import { createPermDock as server } from "permdock/server";',
        "export const handler = server(policy, { pdp: createPermDock });",
      ],
      "file.ts",
    );
    expect(result.source.split("\n")).toEqual([
      'import { loadPermDock } from "permdock/pdp";',
      'import { createPermDock as server } from "permdock/server";',
      "export const handler = server(policy, { pdp: loadPermDock });",
    ]);
  });

  it("imports loadPermDock on its own line when only a type import names the entry", () => {
    const result = apply(
      [
        'import type { PermDock } from "permdock";',
        'import * as core from "permdock";',
        "const { createPermDock } = core;",
        'import { createPermDock as make } from "permdock";',
        "export const a: PermDock = await make(policy, user);",
      ],
      "file.ts",
    );
    expect(result.source.split("\n")).toEqual([
      'import type { PermDock } from "permdock";',
      'import * as core from "permdock";',
      "const { createPermDock } = core;",
      'import { loadPermDock } from "permdock";',
      "export const a: PermDock = await loadPermDock(policy, user);",
    ]);
  });
});

describe("the custom role reader", () => {
  it("renames rolesOf to rolesFor in a reader passed to customRoleSource", () => {
    const result = apply(
      [
        'import { customRoleSource } from "permdock";',
        "export const a = customRoleSource({ rolesOf: (tenant) => read(tenant) });",
        "export const b = customRoleSource({ async rolesOf(tenant) { return read(tenant); } });",
        "export const c = { rolesOf: 1 };",
      ],
      "file.ts",
    );
    expect(result.source.split("\n").slice(1)).toEqual([
      "export const a = customRoleSource({ rolesFor: (tenant) => read(tenant) });",
      "export const b = customRoleSource({ async rolesFor(tenant) { return read(tenant); } });",
      "export const c = { rolesOf: 1 };",
    ]);
    expect(result.followUps).toEqual([]);
  });
});

describe("feature functions", () => {
  it("turns instance feature methods into functions that take the instance first", () => {
    const result = apply(
      [
        'import { createPermDock } from "permdock";',
        "export async function run(permdock: PermDock, ctx: Ctx) {",
        "  const change = permdock.decideRoleChange({ role: 'admin' }, { trusted: true });",
        "  const holders = await ctx.permdock.whoCan(permissions.doc.read, row);",
        "  const key = await permdock.tenant(t).decideCredential(request);",
        "  return [change, holders, key];",
        "}",
      ],
      "file.ts",
    );
    expect(result.source.split("\n")).toEqual([
      'import { createPermDock, decideRoleChange, whoCan, decideCredential } from "permdock";',
      "export async function run(permdock: PermDock, ctx: Ctx) {",
      "  const change = decideRoleChange(permdock, { role: 'admin' }, { trusted: true });",
      "  const holders = await whoCan(ctx.permdock, permissions.doc.read, row);",
      "  const key = await decideCredential(permdock.tenant(t), request);",
      "  return [change, holders, key];",
      "}",
    ]);
    expect(
      result.changes.map((item) => [item.line, item.from, item.to]),
    ).toEqual([
      [3, "decideRoleChange", "decideRoleChange"],
      [4, "whoCan", "whoCan"],
      [5, "decideCredential", "decideCredential"],
    ]);
  });

  it("rewrites simulate only for an Arazzo plan and activate only on an instance", () => {
    const result = apply(
      [
        'import { definePolicy } from "permdock";',
        "export const plan = permdock.simulate({ arazzo, openapi });",
        "export const checks = permdock.simulate([[permissions.doc.read]]);",
        "export const elevated = permdock.activate({ role: 'admin', duration: 3600 });",
        "export const session = auth.activate();",
      ],
      "file.ts",
    );
    expect(result.source.split("\n")).toEqual([
      'import { definePolicy, simulateArazzo, activate } from "permdock";',
      "export const plan = simulateArazzo(permdock, { arazzo, openapi });",
      "export const checks = permdock.simulate([[permissions.doc.read]]);",
      "export const elevated = activate(permdock, { role: 'admin', duration: 3600 });",
      "export const session = auth.activate();",
    ]);
  });

  it("nests rewrites, keeps renamed arguments and reuses an imported function", () => {
    const result = apply(
      [
        'import { whoCan as holders, memorySink } from "permdock";',
        "export const a = permdock.whoCan(p, other.whoCan(q, memorySink));",
        "export const b = holders;",
      ],
      "file.ts",
    );
    expect(result.source.split("\n")).toEqual([
      'import { whoCan as holders, memoryDecisionSink } from "permdock";',
      "export const a = holders(permdock, p, holders(other, q, memoryDecisionSink));",
      "export const b = holders;",
    ]);
  });

  it("reports an optional call and a captured name, and leaves a namespace call alone", () => {
    const result = apply(
      [
        'import * as pd from "permdock";',
        "export const a = permdock?.decideRoleChange(change);",
        "export const b = pd.decideRoleChange(permdock, change);",
        "export function c(decideRoleChange: unknown) { return permdock.decideRoleChange(change); }",
      ],
      "file.ts",
    );
    expect(result.changes).toEqual([]);
    expect(result.followUps.map((item) => [item.line, item.message])).toEqual([
      [
        2,
        "`permdock.decideRoleChange(…)` is `decideRoleChange(permdock, …)` from `permdock`",
      ],
      [
        4,
        "`permdock.decideRoleChange(…)` is `decideRoleChange(permdock, …)` from `permdock`; `decideRoleChange` is already bound in this scope",
      ],
    ]);
  });

  it("rewrites a call without further arguments and a multi-line call", () => {
    const result = apply(
      [
        'import { can } from "permdock";',
        "export const a = permdock.whoCan();",
        "export const b = permdock.decideRoleChange(",
        "  change,",
        ");",
      ],
      "file.ts",
    );
    expect(result.source.split("\n").slice(1)).toEqual([
      "export const a = whoCan(permdock);",
      "export const b = decideRoleChange(permdock,",
      "  change,",
      ");",
    ]);
  });
});

describe("instance listing methods", () => {
  it("turns permittedIds and mayUse calls into instance methods and drops the import", () => {
    const result = apply(
      [
        'import { mayUse, permittedIds } from "permdock";',
        "export const ids = permittedIds(permdock, permissions.doc.read, 'project', { conditioned: true });",
        "export const ok = mayUse(await load(), permissions.doc.read);",
      ],
      "file.ts",
    );
    expect(result.source.split("\n")).toEqual([
      "export const ids = permdock.permittedIds(permissions.doc.read, 'project', { conditioned: true });",
      "export const ok = (await load()).mayUse(permissions.doc.read);",
    ]);
    expect(result.followUps).toEqual([]);
  });

  it("keeps the import and reports it when the function is also read as a value", () => {
    const result = apply(
      [
        'import { can, mayUse } from "permdock";',
        "export const ok = mayUse(ctx.permdock, p);",
        "export const check = [mayUse, can];",
      ],
      "file.ts",
    );
    expect(result.source.split("\n")).toEqual([
      'import { can, mayUse } from "permdock";',
      "export const ok = ctx.permdock.mayUse(p);",
      "export const check = [mayUse, can];",
    ]);
    expect(result.followUps.map((item) => item.message)).toEqual([
      "`mayUse` is imported; `mayUse(permdock, permission)` is now `permdock.mayUse(permission)`",
    ]);
  });

  it("leaves decideCredential, still a function that takes the instance, alone", () => {
    const source = [
      'import { decideCredential } from "permdock";',
      "export const decision = await decideCredential(permdock, request);",
    ].join("\n");
    const result = transformSource("file.ts", source, SET);
    expect(result.source).toBe(source);
    expect(result.followUps).toEqual([]);
  });
});

describe("feature options", () => {
  it("wraps approval policy and hosted grant sources passed to createPermDock", () => {
    const result = apply(
      [
        'import { createPermDock } from "permdock";',
        "export const a = createPermDock(policy, user, {",
        "  approvalPolicies: tableApprovalPolicies(db),",
        "  policies,",
        "});",
      ],
      "file.ts",
    );
    expect(result.source.split("\n")).toEqual([
      'import { createPermDock, approvalPolicies, hostedPolicies } from "permdock";',
      "export const a = createPermDock(policy, user, {",
      "  approvalPolicies: approvalPolicies(tableApprovalPolicies(db)),",
      "  policies: hostedPolicies(policies),",
      "});",
    ]);
  });

  it("leaves a memory source and an already wrapped source alone", () => {
    const result = apply(
      [
        'import { approvalPolicies, loadPermDock, memoryApprovalPolicies } from "permdock";',
        "export const a = await loadPermDock(policy, user, { approvalPolicies: memoryApprovalPolicies([]) });",
        "export const b = await loadPermDock(policy, user, { approvalPolicies: approvalPolicies(source) });",
      ],
      "file.ts",
    );
    expect(result.source.split("\n").slice(1)).toEqual([
      "export const a = await loadPermDock(policy, user, { approvalPolicies: memoryApprovalPolicySource([]) });",
      "export const b = await loadPermDock(policy, user, { approvalPolicies: approvalPolicies(source) });",
    ]);
    expect(result.followUps).toEqual([]);
  });

  it("wraps at the permdock/pdp factory and reports options it cannot reach", () => {
    const result = apply(
      [
        'import { createPermDock } from "permdock/pdp";',
        "const approvalPolicies = source;",
        "export const a = await createPermDock(policy, user, { approvalPolicies });",
        "export const options = { approvalPolicies: source, policies: [] };",
      ],
      "file.ts",
    );
    expect(result.source.split("\n")[2]).toBe(
      "export const a = await loadPermDock(policy, user, { approvalPolicies });",
    );
    expect(result.followUps.map((item) => [item.line, item.message])).toEqual([
      [
        3,
        "option `approvalPolicies` takes `approvalPolicies(source)` from `permdock`; `approvalPolicies` is already bound in this scope",
      ],
      [
        4,
        "option `approvalPolicies` takes `approvalPolicies(source)` from `permdock` when this object reaches `createPermDock` or `loadPermDock`",
      ],
    ]);
  });
});

describe("duration strings", () => {
  it("turns duration strings into seconds inside a call to a PermDock import", () => {
    const result = apply(
      [
        'import { definePolicy } from "permdock";',
        "export const policy = definePolicy({",
        "  approval: { ttl: '30m', escalation: { after: \"2h\" } },",
        "  activation: { maxDuration: '4h' },",
        "  consent: { durations: ['1d', '1w', 3600] },",
        "  limit: { per: '1h', count: 5 },",
        "  label: { ttl: 'soon' },",
        "});",
      ],
      "file.ts",
    );
    expect(result.source.split("\n").slice(2, 7)).toEqual([
      "  approval: { ttl: 1800, escalation: { after: 7200 } },",
      "  activation: { maxDuration: 14400 },",
      "  consent: { durations: [86400, 604800, 3600] },",
      "  limit: { per: 3600, count: 5 },",
      "  label: { ttl: 'soon' },",
    ]);
    expect(result.changes.map((item) => [item.from, item.to])).toEqual([
      ["30m", "1800"],
      ["2h", "7200"],
      ["4h", "14400"],
      ["1d", "86400"],
      ["1w", "604800"],
      ["1h", "3600"],
    ]);
  });

  it("reports a duration string outside a PermDock call and leaves other calls alone", () => {
    const result = apply(
      [
        'import { definePolicy } from "permdock";',
        'import { cache } from "./cache";',
        "export const approval = { ttl: '30m' };",
        "export const store = cache({ ttl: '5m' });",
        "export const zero = definePolicy({ ttl: '0s' });",
      ],
      "file.ts",
    );
    expect(result.changes).toEqual([]);
    expect(result.followUps.map((item) => [item.line, item.message])).toEqual([
      [
        3,
        'duration `"30m"` is `1800` (seconds) when this object reaches PermDock',
      ],
    ]);
  });
});
