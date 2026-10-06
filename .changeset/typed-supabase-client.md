---
"permdock": patch
---

`postgrestSources` and `supabaseApprovalStore` now take their client as `SupabaseRpcCaller`, which a supabase-js client typed with a generated `Database` (`SupabaseClient<Database>`) satisfies. Before, its `rpc` typed the arguments as `never` for a function name the `Database` did not declare, so the call needed a cast to an untyped client. `SupabaseRpcClient` stays the type to implement a fake against; it satisfies `SupabaseRpcCaller` too.
