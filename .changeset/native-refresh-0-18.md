---
"permdock": minor
---

React Native and servers outside Next.js now load permissions once per authorization version. `nativeRefresh` from `permdock/react-native` refreshes the session, PowerSync and the snapshot when the user's `authz:<uid>` channel fires, and `permdock powersync generate` streams the user's `authz_ver` row so `powerSyncSource` sets `snapshot.authzVersion`. `powersync generate` and `verify` report streams that read token claims as PD084, and a claims-change fixture checks those streams' row sets.

`authorizer` and `authorizationHooks` take `permdockFor`, and `permdockFor(...).sources(versions)` lets oRPC, MCP and `permdock/next` share its instances. `createPermDock({ version })` and `getPermDock({ version })` in `permdock/next` take a known authorization version for read-intent instances. `instanceCache()` caches a custom-role factory's answers per factory and principal. `permdock doctor` reports a `claimsFirst` created per call as PD080. `rls.approvals.managers` makes `manager()` approvers match in SQL and in `authorizationHooks`.
