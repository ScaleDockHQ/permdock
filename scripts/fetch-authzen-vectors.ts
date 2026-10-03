import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// openid/authzen carries no licence file, so the vectors are fetched on demand
// into a gitignored folder and never committed.
const COMMIT = "78a5165a0048895a345e4ac5b0f2b9c7904bb110";
const BASE = `https://raw.githubusercontent.com/openid/authzen/${COMMIT}/interop`;
const FILES = [
  "authzen-todo-backend/test/decisions-authorization-api-1_0-02.json",
];

const out = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "permdock",
  "tests",
  "testing",
  "fixtures",
  "authzen",
);

async function fetchOne(file: string): Promise<void> {
  const response = await fetch(`${BASE}/${file}`);
  if (!response.ok) {
    throw new Error(`${file}: HTTP ${String(response.status)}`);
  }
  const target = join(out, file.slice(file.lastIndexOf("/") + 1));
  await writeFile(target, await response.text());
  process.stdout.write(`wrote ${target}\n`);
}

await mkdir(out, { recursive: true });
await Promise.all(
  FILES.map(async (file) => {
    await fetchOne(file);
  }),
);
