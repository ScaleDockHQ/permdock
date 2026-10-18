---
"permdock": minor
---

Breaking: adapters use one name per meaning. `permdock/server` exports `createPermDock`; server adapters take `deniedResponse`; agent adapters take `deniedText` and `operations`; adapter type names start with the adapter. Run `permdock codemod 0.5` for the renames below. The call-shape changes in the second table need a manual edit, except `permittedIds` and `mayUse`, which the codemod rewrites.

| Old                           | New                                | Entries                                                                                                          |
| ----------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `createServerKernel`          | `createPermDock`                   | `permdock/server`                                                                                                |
| `ServerKernel`                | `ServerPermDock`                   | `permdock/server`                                                                                                |
| `ServerKernelOptions`         | `ServerPermDockOptions`            | `permdock/server`                                                                                                |
| `createEvaluationsHandler`    | `evaluationsHandler`               | `permdock/server`                                                                                                |
| `createNativeStore`           | `nativeStore`                      | `permdock/react-native`                                                                                          |
| `permdock`                    | `getPermDock`                      | `permdock/server`, `node`, `terminal`, `openai`, `claude-agent`, `eve`                                           |
| `permdock`                    | `middleware`                       | `permdock/hono`, `express`, `elysia`, `trpc`, `orpc`                                                             |
| `load`                        | `data`                             | `permdock/authzen`                                                                                               |
| `loadData`                    | `data`                             | `permdock/nest`                                                                                                  |
| `onDenied`                    | `deniedResponse`                   | `permdock/server`, `hono`, `express`, `fastify`, `elysia`, `nest`, `node`, `trpc`, `orpc`, `supabase/middleware` |
| `onDenied`                    | `deniedText`                       | `permdock/ai-sdk`, `mcp`                                                                                         |
| `tools`                       | `operations`                       | `permdock/ai-sdk`, `openai`, `claude-agent`, `eve`                                                               |
| `OnDenied`                    | `DeniedResponse`                   | `permdock/server`                                                                                                |
| `OnDeniedEvent`               | `DeniedResponseEvent`              | `permdock/server`                                                                                                |
| `OnDeniedText`                | `DeniedText`                       | `permdock/ai-sdk`, `mcp`                                                                                         |
| `PermDockRequest`             | `ExpressPermDockRequest`           | `permdock/express`                                                                                               |
| `PermDockRequest`             | `FastifyPermDockRequest`           | `permdock/fastify`                                                                                               |
| `PermDockEnv`                 | `HonoPermDockEnv`                  | `permdock/hono`                                                                                                  |
| `ElysiaContext`               | `ElysiaPermDockContext`            | `permdock/elysia`                                                                                                |
| `ElysiaCtx`                   | `ElysiaRequestContext`             | `permdock/elysia`                                                                                                |
| `ConvexPermDockCtx`           | `ConvexPermDockContext`            | `permdock/convex`                                                                                                |
| `ServerPermDockProviderProps` | `NextPermDockProviderProps`        | `permdock/next`                                                                                                  |
| `NativePermDockProviderProps` | `ReactNativePermDockProviderProps` | `permdock/react-native`                                                                                          |
| `PermDockSvelteOptions`       | `SveltePermDockOptions`            | `permdock/svelte`                                                                                                |

| Before                                                           | After                                      |
| ---------------------------------------------------------------- | ------------------------------------------ |
| `app.register(permdock)` on `permdock/fastify`                   | `app.register(middleware())`               |
| `app.register(permdockHandler, opts)` on `permdock/fastify`      | `app.register(permdockHandler(), opts)`    |
| `permdockHandler(request)` on `permdock/trpc`, `orpc`, `authzen` | `permdockHandler()(request)`               |
| `permittedIds(permdock, permission, scope)` from `permdock`      | `permdock.permittedIds(permission, scope)` |
| `mayUse(permdock, permission)` from `permdock`                   | `permdock.mayUse(permission)`              |
