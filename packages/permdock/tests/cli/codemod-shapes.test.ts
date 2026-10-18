import { describe, expect, it } from "vitest";

import type { RenameSet } from "../../src/cli/codemod/transform.ts";

import {
  RENAMES_0_5,
  SIGNATURE_CHANGES_0_5,
} from "../../src/cli/codemod/renames-0.5.ts";
import {
  PROP_RENAMES_0_5,
  TEMPLATE_HINTS_0_5,
} from "../../src/cli/codemod/shapes-0.5.ts";
import { transformSource } from "../../src/cli/codemod/transform.ts";

const SET: RenameSet = {
  renames: RENAMES_0_5,
  signatures: SIGNATURE_CHANGES_0_5,
  props: PROP_RENAMES_0_5,
  templates: TEMPLATE_HINTS_0_5,
};

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
