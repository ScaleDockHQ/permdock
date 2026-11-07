import type { PermissionKeyOf } from "../core/type-helpers.ts";

type KeyedBlocks<B, K extends string> = {
  readonly [Name in keyof B]?: {
    readonly permissions?: Readonly<Record<string, K>>;
  };
};

/**
 * Identity over a better-supabase `blocks` config, which `defineConfig` then
 * checks, that types every `blocks.<name>.permissions` value as a permission
 * key of `P`, a policy or a permission tree. A key the catalog does not list
 * fails to compile, which `permdock doctor` PD079 reports for a config the type
 * cannot see.
 *
 * ```ts
 * export const blocks = defineBlocksConfig<typeof policy>()({
 *   audit: { permissions: { read: "audit.read" } },
 * });
 * ```
 */
export function defineBlocksConfig<P>(): <
  const B extends Readonly<Record<string, unknown>>,
>(
  blocks: B & KeyedBlocks<B, PermissionKeyOf<P>>,
) => B {
  return (blocks) => blocks;
}
