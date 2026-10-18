export type PropRename = {
  readonly component: string;
  readonly entries: readonly string[];
  readonly from: string;
  readonly to: string;
  readonly within?: string;
};

export type TemplateHint = {
  readonly component: string;
  readonly entries: readonly string[];
  readonly pattern: RegExp;
  readonly name: string;
  readonly message: string;
};

const JSX_KITS = [
  "permdock/react",
  "permdock/react-native",
  "permdock/solid",
] as const;

export const PROP_RENAMES_0_5: readonly PropRename[] = Object.freeze([
  {
    component: "Protected",
    entries: [...JSX_KITS, "permdock/vue"],
    from: "fallback",
    to: "denied",
  },
  {
    component: "PermDockProvider",
    entries: JSX_KITS,
    from: "fallback",
    to: "denied",
    within: "defaults",
  },
]);

export const TEMPLATE_HINTS_0_5: readonly TemplateHint[] = Object.freeze([
  {
    component: "Protected",
    entries: ["permdock/vue"],
    pattern: /(?:#|v-slot:)fallback\b/gu,
    name: "fallback",
    message: "the `<Protected>` slot `fallback` is `denied`: `#denied`",
  },
  {
    component: "Protected",
    entries: ["permdock/svelte"],
    pattern: /\{#snippet\s+fallback\b|\bslot=["']fallback["']/gu,
    name: "fallback",
    message:
      "the `<Protected>` snippet `fallback` is `denied`: `{#snippet denied(decision)}`",
  },
]);
