import * as sql from "better-supabase/sql";

type RenderLayout = {
  readonly delegationScopes?: Readonly<Record<string, readonly string[]>>;
};

type Render = (
  names: readonly string[],
  layout: RenderLayout,
) => readonly { readonly contents: string }[];

function isRender(value: unknown): value is Render {
  return typeof value === "function";
}

/**
 * The SQL files of better-supabase's permissions block. 0.15 renders blocks
 * with `renderBlocks` and names it `permissions`; 0.13 and 0.14 use
 * `renderModules` and `access`.
 */
export function permissionsBlockSql(layout: RenderLayout): readonly string[] {
  const blocks: unknown = Reflect.get(sql, "renderBlocks");
  if (isRender(blocks)) {
    return blocks(["permissions"], layout).map((file) => file.contents);
  }
  const modules: unknown = Reflect.get(sql, "renderModules");
  if (isRender(modules)) {
    return modules(["access"], layout).map((file) => file.contents);
  }
  throw new Error("PermDock: better-supabase/sql exports no renderer");
}
