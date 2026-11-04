import { bundleWithMeta, consumerSource } from "./consumers.ts";

/**
 * `node src/why.ts "<fixture name>"` prints the dist chunks a consumer fixture
 * keeps after tree-shaking, largest first.
 */
const name = process.argv[2];
const source = name === undefined ? undefined : consumerSource(name);
if (name === undefined || source === undefined) {
  throw new Error(`usage: node src/why.ts "<fixture name from consumers.ts>"`);
}

const { metafile } = await bundleWithMeta(source);
const rows: [number, string][] = [];
for (const output of Object.values(metafile.outputs)) {
  for (const [input, info] of Object.entries(output.inputs)) {
    rows.push([info.bytesInOutput, input.replace(/^.*\/dist\//u, "")]);
  }
}
rows.sort((a, b) => b[0] - a[0]);
for (const [bytes, input] of rows) {
  process.stdout.write(`${String(bytes).padStart(8)}  ${input}\n`);
}
