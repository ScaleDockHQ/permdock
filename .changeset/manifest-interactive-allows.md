---
"permdock": patch
---

The Supabase manifest schema accepts the `permdock_interactive_allows` helper that `rls generate` writes for interactive-only actions. Before, `permdock supabase inspect` wrote it and `parseSupabaseManifest` refused the manifest, so better-supabase `gen` failed in an app that marks an action `interactiveOnly`.
