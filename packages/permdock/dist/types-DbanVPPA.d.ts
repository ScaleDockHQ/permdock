import { r as Permission } from "./permissions-CkmCCiYs.js";
import "./decision-CH_azeep.js";
//#region src/agent/types.d.ts
type ToolBinding = {
  readonly permission: Permission;
  readonly data?: (args: unknown) => unknown;
};
type ToolMap = Readonly<Record<string, ToolBinding>>;
//#endregion
export { ToolMap as t };