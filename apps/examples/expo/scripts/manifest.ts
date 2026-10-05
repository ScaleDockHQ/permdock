import { readFileSync, writeFileSync } from "node:fs";
import { localSnapshotManifest } from "permdock";

import { policy } from "../src/policy.ts";

const path = new URL("../src/permdock-manifest.json", import.meta.url);
const manifest = localSnapshotManifest(policy);

if (!process.argv.includes("--check")) {
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
} else if (
  JSON.stringify(JSON.parse(readFileSync(path, "utf8"))) !==
  JSON.stringify(manifest)
) {
  throw new Error(
    "src/permdock-manifest.json is stale: run pnpm --filter @permdock/example-expo gen",
  );
}
