import { v as Permission } from "./policy-Dvre0Da9.js";
import "./decision-BvyrBh2L.js";
//#region src/agent/types.d.ts
type ToolBinding = {
  readonly permission: Permission;
  readonly data?: (args: unknown) => unknown;
};
type ToolMap = Readonly<Record<string, ToolBinding>>;
//#endregion
export { ToolMap as t };