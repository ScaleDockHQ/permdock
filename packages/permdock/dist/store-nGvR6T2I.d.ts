import { v as Permission } from "./policy-Dvre0Da9.js";
import { n as Decision } from "./decision-BvyrBh2L.js";
import { u as SnapshotV2 } from "./interfaces-DMSVa7et.js";
import { c as PermissionState, r as ClientPermDock } from "./types-DkJf_Fq2.js";
//#region src/react/store.d.ts
type ClientStore = {
  get(): ClientPermDock;
  subscribe(listener: () => void): () => void;
  permissionState(permission: Permission, data?: unknown): PermissionState;
  requestApproval(decision: Decision, note?: string): Promise<void>;
  replace(value: unknown): void;
  snapshot(): SnapshotV2;
};
//#endregion
export { ClientStore as t };