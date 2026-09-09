import { o as Policy, v as Permission } from "../policy-Ypk6zTSJ.js";
//#region src/openapi/types.d.ts
type OpenApiTarget = "3.1" | "3.2" | "3.3";
type OverlayVersion = "1.1" | "1.2";
type SecurityProfileName = "fapi2";
type SchemeType = "oauth2" | "openIdConnect" | "http" | "apiKey" | "gnap";
type OpenApiSchemeOptions = {
  readonly name: string;
  readonly type: SchemeType;
  readonly oauth2MetadataUrl?: string;
  readonly flows?: {
    readonly authorizationCode?: Readonly<Record<string, unknown>>;
    readonly clientCredentials?: Readonly<Record<string, unknown>>;
    readonly deviceAuthorization?: Readonly<Record<string, unknown>>;
  };
  readonly openIdConnectUrl?: string;
  readonly ref?: string;
};
type OpenApiDocsHints = {
  readonly badges?: boolean;
};
type OpenApiPermDockOptions = {
  readonly scheme: OpenApiSchemeOptions;
  readonly target?: OpenApiTarget;
  readonly securityProfile?: SecurityProfileName;
  readonly profileScheme?: string;
  readonly docsHints?: OpenApiDocsHints;
};
type OpenApiSecurityRequirement = Readonly<Record<string, readonly string[]>>;
type OpenApiDescribe = {
  readonly security: readonly OpenApiSecurityRequirement[];
  readonly "x-permdock-permissions": readonly string[];
  readonly "x-permdock-conditions"?: unknown;
  readonly "x-permdock-approval"?: "human";
  readonly "x-permdock-securityProfile"?: SecurityProfileName;
  readonly "x-badges"?: readonly {
    readonly name: string;
  }[];
};
type OpenApiOverlayOptions = {
  readonly extends?: string;
  readonly version?: OverlayVersion;
};
type OpenApiPermDock = {
  readonly securitySchemes: () => Readonly<Record<string, unknown>>;
  readonly security: (permission: Permission | readonly Permission[], options?: {
    readonly anyOf?: boolean;
  }) => readonly OpenApiSecurityRequirement[];
  readonly describe: (permission: Permission | readonly Permission[], options?: {
    readonly anyOf?: boolean;
  }) => OpenApiDescribe;
  readonly spec: (permission: Permission | readonly Permission[]) => (operation: Readonly<Record<string, unknown>>) => Record<string, unknown>;
  readonly overlay: (options?: OpenApiOverlayOptions) => Record<string, unknown>;
  readonly securityProfileRequirements: () => Readonly<Record<string, unknown>> | undefined;
  readonly catalog: () => Record<string, unknown>;
};
type OpenApiFactory = (policy: Policy, options: OpenApiPermDockOptions) => OpenApiPermDock;
//#endregion
//#region src/openapi/create.d.ts
export declare const createPermDock: OpenApiFactory;
//#endregion
//#region src/openapi/pins.d.ts
export declare const DRAFT_PINS: {
  readonly oas: "3.3-dev@2026-09-01";
  readonly securityProfiles: "oai-discussion-5304@2026-09-01";
  readonly overlay: "1.2-dev@edd4adea";
};
export declare const PROFILE_NAMES: {
  readonly fapi2: "fapi-20-security-profile";
};
export declare const GNAP_RESERVED = "scheme.type 'gnap' is reserved and emits nothing. See https://permdock.dev/docs/standards/gnap";
//#endregion
//#region src/openapi/emit.d.ts
export declare function securitySchemesOf(policy: Policy, options: OpenApiPermDockOptions): Record<string, unknown>;
export declare function catalogOf(options: OpenApiPermDockOptions, extraDrafts?: Readonly<Record<string, string>>): Record<string, unknown>;
export declare function openapiVersion(target: OpenApiTarget): string;
//#endregion
export type { OpenApiDescribe, OpenApiDocsHints, OpenApiFactory, OpenApiOverlayOptions, OpenApiPermDock, OpenApiPermDockOptions, OpenApiSchemeOptions, OpenApiSecurityRequirement, OpenApiTarget, OverlayVersion, SchemeType, SecurityProfileName };