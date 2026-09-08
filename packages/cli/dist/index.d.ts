import { a as CreatePermDockPluginOptions, i as CollectConfig, n as CatalogDocument, o as PermDockConfig, r as CliIo, s as RunResult, t as CatalogConfig } from "./types-Cbwy1cVw.js";
import { n as createPermDockPlugin } from "./plugin-Dm19uevv.js";
//#region src/config.d.ts
export declare function defineConfig<T extends PermDockConfig>(config: T): T;
//#endregion
//#region src/run.d.ts
export declare function run(argv: readonly string[], options?: {
  readonly cwd?: string;
  readonly io?: CliIo;
}): Promise<RunResult>;
//#endregion
export { type CatalogConfig, type CatalogDocument, type CollectConfig, type CreatePermDockPluginOptions, type PermDockConfig, type RunResult, createPermDockPlugin };