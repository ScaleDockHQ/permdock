import { v as Permission } from "./policy-Ypk6zTSJ.js";
import "./decision-BD0W6Opj.js";
//#region src/agent/types.d.ts
type ToolBinding = {
  readonly permission: Permission;
  readonly data?: (args: unknown) => unknown;
};
type ToolMap = Readonly<Record<string, ToolBinding>>;
//#endregion
export { ToolMap as t };