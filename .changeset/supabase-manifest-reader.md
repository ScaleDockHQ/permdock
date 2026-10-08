---
"permdock": minor
---

`permdock/supabase` adds `parseSupabaseManifest`, which reads a `permdock.manifest.json` document (parsed, or the JSON text), validates it against `schemas/supabase-manifest-v1.json` and returns a frozen `SupabaseHookManifest`. It throws `PermDockValidationError` with every issue, so a manifest of another major is refused. `SupabaseManifestActiveRow` is now exported.
