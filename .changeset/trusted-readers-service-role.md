---
"permdock": patch
---

`rls.trustedReaders` accepts `service_role`. `rls generate` threw "generated RLS must never emit service_role" when the list named it, although `service_role` is the trusted server role in a Supabase app. The execute grant on `permdock_trusted_role_permissions` may now name it, and the generator still refuses `service_role` on every other line.
