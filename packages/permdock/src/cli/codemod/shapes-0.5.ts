import type { Rename } from "./renames-0.5.ts";

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

export type AwaitRename = {
  readonly name: string;
  readonly entries: readonly string[];
  readonly to: string;
};

export type MethodToFunction = {
  readonly method: string;
  readonly to: string;
  readonly entry: string;
  readonly anyReceiver: boolean;
  readonly argument?: string;
};

export type FunctionToMethod = {
  readonly name: string;
  readonly entry: string;
  readonly method: string;
};

export type OptionWrap = {
  readonly key: string;
  readonly wrapper: string;
  readonly entry: string;
  readonly calls: readonly string[];
  readonly entries: readonly string[];
  readonly already: readonly string[];
  readonly reportElsewhere: boolean;
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

export const AWAIT_RENAMES_0_5: readonly AwaitRename[] = Object.freeze([
  { name: "createPermDock", entries: ["permdock"], to: "loadPermDock" },
]);

export const CALL_RENAMES_0_5: readonly Rename[] = Object.freeze([
  { from: "createPermDock", to: "loadPermDock", entries: ["permdock/pdp"] },
  {
    from: "rolesOf",
    to: "rolesFor",
    entries: ["permdock"],
    kind: "option",
    calls: ["customRoleSource"],
  },
]);

export const METHOD_FUNCTIONS_0_5: readonly MethodToFunction[] = Object.freeze(
  [
    "decideRoleChange",
    "decideCredential",
    "decideAutomation",
    "decideSupportSession",
    "whoCan",
  ]
    .map((method): MethodToFunction => ({
      method,
      to: method,
      entry: "permdock",
      anyReceiver: true,
    }))
    .concat([
      {
        method: "simulate",
        to: "simulateArazzo",
        entry: "permdock",
        anyReceiver: true,
        argument: "arazzo",
      },
      {
        method: "activate",
        to: "activate",
        entry: "permdock",
        anyReceiver: false,
      },
    ]),
);

export const FUNCTION_METHODS_0_5: readonly FunctionToMethod[] = Object.freeze([
  { name: "permittedIds", entry: "permdock", method: "permittedIds" },
  { name: "mayUse", entry: "permdock", method: "mayUse" },
]);

const INSTANCE_FACTORIES = ["createPermDock", "loadPermDock"] as const;

export const OPTION_WRAPS_0_5: readonly OptionWrap[] = Object.freeze([
  {
    key: "approvalPolicies",
    wrapper: "approvalPolicies",
    entry: "permdock",
    calls: INSTANCE_FACTORIES,
    entries: ["permdock", "permdock/pdp"],
    already: [
      "approvalPolicies",
      "memoryApprovalPolicySource",
      "memoryApprovalPolicies",
    ],
    reportElsewhere: true,
  },
  {
    key: "policies",
    wrapper: "hostedPolicies",
    entry: "permdock",
    calls: INSTANCE_FACTORIES,
    entries: ["permdock", "permdock/pdp"],
    already: ["hostedPolicies"],
    reportElsewhere: false,
  },
]);
