import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Every `$id` under https://permdock.com/schemas/ resolves to the file `permdock` ships, copied before `next build`.
const source = join(
  dirname(fileURLToPath(import.meta.resolve("permdock/package.json"))),
  "schemas",
);
const target = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
  "schemas",
);

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
const names = readdirSync(source).filter((name) => name.endsWith(".json"));
for (const name of names) {
  copyFileSync(join(source, name), join(target, name));
}
process.stdout.write(`copied ${String(names.length)} schemas to ${target}\n`);
