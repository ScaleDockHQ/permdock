---
"permdock": minor
---

`rls.anonExecute: true` grants `anon` usage on the helper schema and `execute` on every generated helper, for hand-written policies that apply to `public` or `anon` and call them. Without it only field views that `anon` reads get that grant, and a statement `anon` runs that reaches a helper fails, or as an InitPlan has crashed the backend on some Postgres builds. The docs now say that a policy calling a helper should say `to authenticated`.
