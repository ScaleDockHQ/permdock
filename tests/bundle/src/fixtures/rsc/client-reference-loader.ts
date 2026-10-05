// Module hooks that stand in for the RSC bundler: a module whose source
// starts with "use client" is replaced by client references, the job
// `react-server-dom-webpack/node-loader` does for a real Flight server.
import type { LoadHookSync, ResolveHookSync } from "node:module";

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const SERVER =
  require.resolve("next/dist/compiled/react-server-dom-webpack/server.node");

const DIRECTIVE = /^\s*['"]use client['"]/u;
const EXPORTS = /export\s*\{([^}]*)\}/gu;

function exportNames(source: string): readonly string[] {
  const names: string[] = [];
  for (const match of source.matchAll(EXPORTS)) {
    for (const part of (match[1] ?? "").split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/u)
        .at(-1);
      if (name !== undefined && name !== "") {
        names.push(name);
      }
    }
  }
  return names;
}

// What Next's bundler does in the server layer: `permdock/next` imports
// `#next/navigation`, which permdock's package.json maps to the bare
// `next/navigation` under the `react-server` condition, and Next aliases that
// to the react-server build.
const SERVER_LAYER_ALIASES: Readonly<Record<string, string>> = {
  "#next/navigation": "next/dist/client/components/navigation.react-server.js",
};

export const resolve: ResolveHookSync = (specifier, context, nextResolve) =>
  nextResolve(SERVER_LAYER_ALIASES[specifier] ?? specifier, context);

export const load: LoadHookSync = (url, context, nextLoad) => {
  const result = nextLoad(url, context);
  if (!url.startsWith("file:") || result.format !== "module") {
    return result;
  }
  const source =
    typeof result.source === "string"
      ? result.source
      : new TextDecoder().decode(result.source);
  if (!DIRECTIVE.test(source)) {
    return result;
  }
  const path = JSON.stringify(fileURLToPath(url));
  const lines = [
    `import { registerClientReference } from ${JSON.stringify(SERVER)};`,
    `const stub = (name) => () => { throw new Error(name + ' is a client reference'); };`,
  ];
  for (const name of exportNames(source)) {
    const binding = `ref_${name.replaceAll(/\W/gu, "_")}`;
    lines.push(
      `const ${binding} = registerClientReference(stub(${JSON.stringify(name)}), ${path}, ${JSON.stringify(name)});`,
      name === "default"
        ? `export default ${binding};`
        : `export { ${binding} as ${name} };`,
    );
  }
  return { format: "module", source: lines.join("\n"), shortCircuit: true };
};
