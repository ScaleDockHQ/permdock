import type { Permission } from '../core/permissions.ts';
import type { Policy } from '../core/policy.ts';

export type OpenApiTarget = '3.1' | '3.2' | '3.3';
export type OverlayVersion = '1.1' | '1.2';
export type SecurityProfileName = 'fapi2';
export type SchemeType =
  | 'oauth2'
  | 'openIdConnect'
  | 'http'
  | 'apiKey'
  | 'gnap';

export type OpenApiSchemeOptions = {
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

export type OpenApiDocsHints = {
  readonly badges?: boolean;
};

export type OpenApiPermDockOptions = {
  readonly scheme: OpenApiSchemeOptions;
  readonly target?: OpenApiTarget;
  readonly securityProfile?: SecurityProfileName;
  readonly profileScheme?: string;
  readonly docsHints?: OpenApiDocsHints;
};

export type OpenApiSecurityRequirement = Readonly<
  Record<string, readonly string[]>
>;

export type OpenApiDescribe = {
  readonly security: readonly OpenApiSecurityRequirement[];
  readonly 'x-permdock-permissions': readonly string[];
  readonly 'x-permdock-conditions'?: unknown;
  readonly 'x-permdock-approval'?: 'human';
  readonly 'x-permdock-securityProfile'?: SecurityProfileName;
  readonly 'x-badges'?: readonly { readonly name: string }[];
};

export type OpenApiOverlayOptions = {
  readonly extends?: string;
  readonly version?: OverlayVersion;
};

export type OpenApiPermDock = {
  readonly securitySchemes: () => Readonly<Record<string, unknown>>;
  readonly security: (
    permission: Permission | readonly Permission[],
    options?: { readonly anyOf?: boolean },
  ) => readonly OpenApiSecurityRequirement[];
  readonly describe: (
    permission: Permission | readonly Permission[],
    options?: { readonly anyOf?: boolean },
  ) => OpenApiDescribe;
  readonly spec: (
    permission: Permission | readonly Permission[],
  ) => (
    operation: Readonly<Record<string, unknown>>,
  ) => Record<string, unknown>;
  readonly overlay: (
    options?: OpenApiOverlayOptions,
  ) => Record<string, unknown>;
  readonly securityProfileRequirements: () =>
    | Readonly<Record<string, unknown>>
    | undefined;
  readonly catalog: () => Record<string, unknown>;
};

export type OpenApiFactory = (
  policy: Policy,
  options: OpenApiPermDockOptions,
) => OpenApiPermDock;
