//#region src/types.d.ts
type CollectConfig = {
  readonly srcPath?: readonly string[];
  readonly out?: string;
  readonly barrel?: boolean | string;
};
type CatalogConfig = {
  readonly out?: string;
};
type PermDockConfig = {
  readonly permissions?: string;
  readonly policy?: string;
  readonly collect?: CollectConfig;
  readonly catalog?: CatalogConfig;
  readonly openapi?: {
    readonly doc?: readonly string[];
  };
};
type CatalogUsage = {
  readonly file: string;
  readonly line: number;
  readonly call: string;
};
type CatalogPermission = {
  readonly key: string;
  readonly scope: string;
  readonly resource: string;
  readonly action: string;
  readonly arity: "instance" | "collection";
  readonly meta: Readonly<Record<string, unknown>>;
  readonly usages: readonly CatalogUsage[];
};
type CatalogResource = {
  readonly id: string;
  readonly schema: unknown;
  readonly definedIn?: string;
};
type CatalogDocument = {
  readonly $schema: string;
  readonly version: 1;
  readonly generatedAt: string;
  readonly generator: string;
  readonly resources: Readonly<Record<string, CatalogResource>>;
  readonly permissions: readonly CatalogPermission[];
};
type CliIo = {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly now?: () => Date;
};
type RunResult = {
  readonly code: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
};
type CreatePermDockPluginOptions = {
  readonly collect?: CollectConfig;
  readonly onDrift?: "error" | "warn";
};
//#endregion
export { CreatePermDockPluginOptions as a, CollectConfig as i, CatalogDocument as n, PermDockConfig as o, CliIo as r, RunResult as s, CatalogConfig as t };