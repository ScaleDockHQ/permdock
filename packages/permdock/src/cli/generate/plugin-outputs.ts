import type { PermDockConfig, RlsConfig } from "../types.ts";

/** `rls.out` and `rls.split` as an `rls()` plugin writes them. */
export function withRlsOutputs(
  config: PermDockConfig,
  options: Pick<RlsConfig, "out" | "split">,
): PermDockConfig {
  const split = options.split ?? config.rls?.split;
  // Without split or an out, rls() writes its task path.
  const out =
    options.out ??
    config.rls?.out ??
    (split === undefined ? "permdock.sql" : undefined);
  return {
    ...config,
    rls: {
      ...config.rls,
      ...(out === undefined ? {} : { out }),
      ...(split === undefined ? {} : { split }),
    },
  };
}

/** `supabase.hook.out` as a hook plugin writes it. */
export function withHookOut(
  config: PermDockConfig,
  out: string | undefined,
): PermDockConfig {
  return out === undefined
    ? config
    : {
        ...config,
        supabase: {
          ...config.supabase,
          hook: { ...config.supabase?.hook, out },
        },
      };
}
