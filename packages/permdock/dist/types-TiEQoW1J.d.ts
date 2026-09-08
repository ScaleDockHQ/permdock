import { v as Permission } from "./policy-CL40bNGn.js";
import "./decision-Cjr-7xoX.js";
//#region src/agent/types.d.ts
type ToolBinding = {
  readonly permission: Permission;
  readonly data?: (args: unknown) => unknown;
};
type ToolMap = Readonly<Record<string, ToolBinding>>;
//#endregion
export { ToolMap as t };