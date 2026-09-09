import { a as CreatePermDockPluginOptions } from "./types-9m4S4SrP.js";
//#region src/plugin.d.ts
type NextConfigLike = {
  readonly [key: string]: unknown;
};
declare function createPermDockPlugin(options?: CreatePermDockPluginOptions): <T extends NextConfigLike>(nextConfig: T) => T;
declare function runPluginCollect(cwd: string, options: CreatePermDockPluginOptions | undefined, check: boolean): Promise<string | undefined>;
//#endregion
export { createPermDockPlugin as n, runPluginCollect as r, NextConfigLike as t };