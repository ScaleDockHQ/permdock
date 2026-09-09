//#region src/core/subject.d.ts
type JsonWebKeyLike = {
  readonly kty?: string;
  readonly [key: string]: unknown;
};
type Binding = {
  readonly jkt?: string;
  readonly "x5t#S256"?: string;
  readonly jwk?: JsonWebKeyLike;
  readonly kid?: string;
};
type Assurance = {
  readonly acr?: string;
  readonly amr?: readonly string[];
  readonly authTime?: number;
};
type Membership = {
  readonly tenant?: string;
  readonly team?: string;
  readonly on?: {
    readonly resource: string;
    readonly id: string;
  };
  readonly roles: readonly string[];
  readonly via?: string;
  readonly expiresAt?: number;
};
type CustomRole = {
  readonly tenant: string;
  readonly name: string;
  readonly includes: readonly string[];
  readonly meta?: Readonly<Record<string, unknown>>;
};
type Principal = {
  readonly id: string;
  readonly issuer?: string;
  readonly kind?: "user" | "service" | "workload";
  readonly roles?: readonly string[];
  readonly memberships?: readonly Membership[];
  readonly tenant?: string;
  readonly assurance?: Assurance;
  readonly binding?: Binding;
  readonly [key: string]: unknown;
};
type Actor = {
  readonly id: string;
  readonly kind: string;
  readonly binding?: Binding;
  readonly [key: string]: unknown;
};
type AuthorizationDetail = {
  readonly type: string;
  readonly actions?: readonly string[];
  readonly [key: string]: unknown;
};
type GnapAccess = string | Readonly<Record<string, unknown>>;
type Delegation = {
  readonly scopes?: readonly string[];
  readonly authorizationDetails?: readonly AuthorizationDetail[];
  readonly access?: readonly GnapAccess[];
  readonly chain?: unknown;
};
type Subject<TPrincipal extends Principal = Principal> = {
  readonly principal: TPrincipal | null;
  readonly actor?: Actor;
  readonly delegation?: Delegation;
  readonly context: Readonly<Record<string, unknown>>;
  readonly session?: string;
  readonly expiresAt?: number;
};
//#endregion
export { CustomRole as a, JsonWebKeyLike as c, Subject as d, Binding as i, Membership as l, Assurance as n, Delegation as o, AuthorizationDetail as r, GnapAccess as s, Actor as t, Principal as u };