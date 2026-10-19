---
"permdock": minor
---

`<Protected>`'s denied slot is `denied` in every UI kit, matching `<PermissionBoundary>`. In React, Vue and Solid, `fallback` means a loading or error state, so it read as the wrong thing.

| Before                                                                                   | After                                            |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `<Protected permission={…} fallback={<Locked />}>` (React, React Native, Next.js, Solid) | `<Protected permission={…} denied={<Locked />}>` |
| Vue `#fallback` slot, or `{ fallback: () => … }`                                         | `#denied` slot, or `{ denied: () => … }`         |
| Svelte `{#snippet fallback(decision)}`                                                   | `{#snippet denied(decision)}`                    |
| `PermDockProvider defaults={{ fallback }}` and the Vue, Svelte and Solid equivalents     | `defaults={{ denied }}`                          |
| `view.slot === "fallback"` (`viewFor`)                                                   | `view.slot === "denied"`                         |

`approval` still falls back to `denied`. `pending`, `deniedResponse`, `deniedText` and `onDenied` keep their names.
