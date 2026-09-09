import "./permdock-hQcUhnDS.js";
//#region src/conditions/compile.d.ts
type MembershipTable = {
  readonly table: string;
  readonly user: string;
  readonly role: string;
  readonly tenant?: string;
  readonly team?: string;
  readonly id?: string;
  readonly expiresAt?: string;
};
type MembershipsMapping = {
  readonly tenant?: MembershipTable;
  readonly team?: MembershipTable;
  readonly resource?: Readonly<Record<string, MembershipTable>>;
};
//#endregion
export { MembershipsMapping as t };