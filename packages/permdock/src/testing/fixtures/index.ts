import type { CatalogDocument } from "../../catalog/types.ts";
import type { SupabaseManifest } from "../../supabase/manifest.ts";

import { parseCatalog } from "../../catalog/parse.ts";
import { parseSupabaseManifest } from "../../supabase/manifest.ts";
import catalog from "./better-supabase.catalog.json" with { type: "json" };
import manifest from "./better-supabase.manifest.json" with { type: "json" };

/**
 * The `permissions.catalog.json` of `apps/examples/next-better-supabase`, a
 * `catalog-v1` document with resources, permissions, scopes, roles, grants and
 * delegations, for testing a catalog consumer such as a Cloud.
 */
export const betterSupabaseCatalog: CatalogDocument = parseCatalog(catalog);

/**
 * The `permdock.manifest.json` of the same app, a `supabase-manifest-v1`
 * document.
 */
export const betterSupabaseManifest: SupabaseManifest =
  parseSupabaseManifest(manifest);
