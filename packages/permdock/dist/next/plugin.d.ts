//#region src/next/plugin.d.ts
export type CreatePermDockPluginOptions = {
  readonly collect?: {
    readonly srcPath?: readonly string[];
    readonly out?: string;
    readonly barrel?: boolean | string;
  };
  readonly onDrift?: "error" | "warn";
};
export declare function createPermDockPlugin(options?: CreatePermDockPluginOptions): <T extends object>(nextConfig: T) => T;
//#endregion