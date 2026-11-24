import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Resolves a package from the app, then from the installed `better-supabase`,
 * which pins `@supabase/pg-delta` and `@supabase/pg-topo` and whose BS709 tells
 * the app to remove its own entries. Under pnpm the app then cannot see them.
 */
export function resolveFromApp(cwd: string, name: string): string | undefined {
  const app = createRequire(join(cwd, "package.json"));
  try {
    return app.resolve(name);
  } catch {
    try {
      return createRequire(app.resolve("better-supabase/package.json")).resolve(
        name,
      );
    } catch {
      return undefined;
    }
  }
}

/** The module `name` resolves to from the app, or undefined when neither has it. */
export function importFromApp(cwd: string, name: string): Promise<unknown> {
  const path = resolveFromApp(cwd, name);
  // An optional peer, resolved from the app or better-supabase rather than from permdock.
  return path === undefined
    ? Promise.resolve(undefined)
    : import(pathToFileURL(path).href);
}
