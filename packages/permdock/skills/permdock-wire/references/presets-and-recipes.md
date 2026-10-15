# Presets and recipes

## Presets

A preset is an archetype plus the features, auth, backend, framework, agent runtimes, UI and Cloud services an app needs, encoded as a code that starts with `p1` ([presets](https://permdock.com/docs/concepts/presets)). The user builds one at [permdock.com/create](https://permdock.com/create), or you pass flags.

```bash
npx permdock init --preset <code> --dry-run
npx permdock init --archetype b2b --framework hono --feature approvals --dry-run
npx permdock preset decode <code>
```

| Flag          | Values                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| `--archetype` | `b2b`, `agent`, `marketplace`, `api`, `internal`, `consumer`                                                 |
| `--framework` | `next`, `hono`, `express`, `none`                                                                            |
| `--feature`   | `tenancy`, `custom-roles`, `approvals`, `agents`, `audit`, `limits`, `plans`, `ownership`, `api-keys`, `rls` |
| `--agent`     | `ai-sdk`, `mcp`                                                                                              |
| `--ui`        | `shadcn`, `react-native`                                                                                     |

`init` keeps every file that exists unless `--force` is passed, installs nothing and calls no network. It prints the `npm install` line, the `npx shadcn add` line for the recipes and the docs pages to read. Run what it prints, then `permdock doctor`.

What `init` writes is the app's own code: `src/permissions.ts`, `src/policy.ts`, `src/permdock.ts` (`defineApp` with a `profile` from `NODE_ENV`), `src/session.ts` and `src/data.ts` to wire to the real auth and database, and the framework file. The session returns `null` until it is wired, so every check denies. Replace the loaders; do not add rules to them.

### Who owns what

- The `permdock` package owns every rule: evaluation, role ceilings, approval binding, limits, token checks. `npm update` reaches it.
- The app owns declarations (`definePermissions`, `definePolicy` data, `defineApp` options) and presentation (recipes).
- Never copy evaluation logic out of the package into the app, and never change a recipe so it decides on its own; it renders what `useGate` returns.

`profile: "prod"` throws at startup when a store or limits a feature needs are missing ([apps and profiles](https://permdock.com/docs/concepts/apps)). Do not switch the profile to silence it; pass the store.

## Recipes

The `@permdock` shadcn registry holds UI built from the app's own components on `useGate` ([recipes](https://permdock.com/docs/concepts/recipes)). PermDock ships no visible component besides `<Protected>`.

```bash
npx shadcn@latest add https://permdock.com/r/gated-button.json
npx shadcn@latest add https://permdock.com/r/preset-<code>.json
```

| Recipe                                         | Use                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| `gated-button`                                 | A button that is hidden, disabled with the reason, or asks for approval |
| `approval-request-dialog`                      | A note and a request for an `approval-required` action                  |
| `tenant-switcher`                              | The tenants the user is a member of                                     |
| `role-picker`                                  | Only the roles the user may hand out                                    |
| `custom-role-editor`                           | Only the permissions the editor holds                                   |
| `upgrade-prompt`                               | The plans that would grant the action                                   |
| `gated-button-native`, `upgrade-prompt-native` | The same on React Native Reusables                                      |

Each recipe needs `PermDockProvider` from `permdock/react` or `permdock/react-native`. A recipe hides or disables a control; the server checks the action again, so the guard from the Guard step stays.

✓ The recipe renders `useGate`'s `hidden`, `disabled`, `needsApproval` and `reason`, and the server action it calls asserts the same permission.
