import { v as Permission } from "./policy-DsqYfECx.js";
import "./decision-C6A-71_M.js";
//#region src/agent/types.d.ts
type ToolBinding = {
  readonly permission: Permission;
  readonly data?: (args: unknown) => unknown;
};
type ToolMap = Readonly<Record<string, ToolBinding>>;
//#endregion
export { ToolMap as t };