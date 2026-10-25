import base from "../read-only-actors/permdock.config.ts";

/**
 * `read-only-actors` with the job table named, so `--helpers-only` writes its
 * read-only actor policies.
 */
export default { ...base, rls: { ...base.rls, tables: { job: "public.job" } } };
