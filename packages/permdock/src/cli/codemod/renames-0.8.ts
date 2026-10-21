import type { ConfigMove } from "./config-moves.ts";
import type { SignatureChange } from "./renames-0.5.ts";

const MEMBERSHIP_TABLES = [
  ["rls", "memberships", "scopes", "*"],
  ["rls", "memberships", "resource", "*"],
] as const;

/**
 * 0.8 folds the `tenant` / `team` config shorthands into the named-scope forms,
 * under the `tenant` / `team` aliases a policy's first and second scope answer
 * to.
 */
export const CONFIG_MOVES_0_8: readonly ConfigMove[] = Object.freeze([
  { from: ["rls", "tenantType"], to: ["rls", "scopeTypes", "tenant"] },
  { from: ["rls", "teamType"], to: ["rls", "scopeTypes", "team"] },
  {
    from: ["rls", "memberships", "tenant"],
    to: ["rls", "memberships", "scopes", "tenant"],
  },
  {
    from: ["rls", "memberships", "team"],
    to: ["rls", "memberships", "scopes", "team"],
  },
  ...MEMBERSHIP_TABLES.flatMap((table) =>
    ["tenant", "team"].map((scope) => ({
      from: [...table, scope],
      to: [...table, "columns", scope],
    })),
  ),
]);

/**
 * 0.8 drops `team` from the client `RolesOptions`; `{ scope, id }` names any
 * scope. Reported, since only the reader knows the scope a `team` id belongs
 * to.
 */
export const SIGNATURE_CHANGES_0_8: readonly SignatureChange[] = Object.freeze([
  {
    name: "useRoles",
    entries: [
      "permdock/react",
      "permdock/react-native",
      "permdock/vue",
      "permdock/solid",
    ],
    before: "useRoles({ team: id })",
    after: 'useRoles({ scope: "team", id })',
  },
  ...["roles", "rolesFor"].map((name) => ({
    name,
    entries: ["permdock/svelte"],
    before: `${name}(() => ({ team: id }))`,
    after: `${name}(() => ({ scope: "team", id }))`,
  })),
]);
