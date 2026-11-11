---
"permdock": patch
---

`permdock doctor` PD079 reports a `blocks.<name>.permissions` key that better-supabase 0.58 renamed (`view`, `viewAll`, `viewSensitive`, `edit`, `admin`) as its own error, naming the new key and `better-supabase codemod naming`. Before, better-supabase's `former_permission_key` refusal showed as a missing `modulePermissionKeys` export.
