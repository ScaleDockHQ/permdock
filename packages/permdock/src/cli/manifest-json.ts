/** Where `permdock supabase inspect --out` writes the manifest by default. */
export const MANIFEST_FILE = "permdock.manifest.json";

/** The bytes `permdock supabase inspect --out` and `permdock cloud pull` write. */
export function formatManifestJson(manifest: unknown): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
