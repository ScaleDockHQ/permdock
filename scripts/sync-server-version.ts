import { readFileSync, writeFileSync } from "node:fs";

/** Writes the `permdock` package version into `server.json`; `version-packages` runs it after `changeset version`. */
const root = new URL("../", import.meta.url);
const read = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(path, root), "utf8"));

const pkg = read("packages/permdock/package.json");
const server = read("server.json");
if (
  typeof pkg !== "object" ||
  pkg === null ||
  !("version" in pkg) ||
  typeof pkg.version !== "string" ||
  typeof server !== "object" ||
  server === null
) {
  throw new Error("packages/permdock/package.json or server.json is malformed");
}
writeFileSync(
  new URL("server.json", root),
  `${JSON.stringify({ ...server, version: pkg.version }, null, 2)}\n`,
);
