import { a as CreatePermDockPluginOptions, c as RlsDialect, d as RlsTarget, f as RunResult, i as CollectConfig, l as RlsMembershipTable, n as CatalogDocument, o as PermDockConfig, r as CliIo, s as RlsConfig, t as CatalogConfig, u as RlsMemberships } from "./types-9m4S4SrP.js";
import { n as createPermDockPlugin } from "./plugin-BVUvY2IG.js";
//#region src/config.d.ts
export declare function defineConfig<T extends PermDockConfig>(config: T): T;
//#endregion
//#region src/run.d.ts
export declare function run(argv: readonly string[], options?: {
  readonly cwd?: string;
  readonly io?: CliIo;
}): Promise<RunResult>;
//#endregion
export { type CatalogConfig, type CatalogDocument, type CollectConfig, type CreatePermDockPluginOptions, type PermDockConfig, type RlsConfig, type RlsDialect, type RlsMembershipTable, type RlsMemberships, type RlsTarget, type RunResult, createPermDockPlugin };