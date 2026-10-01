import { readFileSync } from 'node:fs';

export type Rfc9421Vector = {
  readonly key: Readonly<Record<string, string>>;
  readonly request: {
    readonly method: string;
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  };
  readonly signatureInput: string;
  readonly signature: string;
};

export type Rfc8037Vector = {
  readonly privateKey: Readonly<Record<string, string>>;
  readonly publicKey: Readonly<Record<string, string>>;
  readonly thumbprint: string;
  readonly jws: string;
};

export type Rfc7520Vector = {
  readonly rsaPublicKey: Readonly<Record<string, string>>;
  readonly hmacKey: Readonly<Record<string, string>>;
  readonly rs256: string;
  readonly hs256: string;
};

export type ScimAttribute = {
  readonly name: string;
  readonly type: string;
  readonly multiValued: boolean;
  readonly required: boolean;
  readonly mutability?: string;
  readonly returned?: string;
  readonly uniqueness?: string;
  readonly subAttributes?: readonly ScimAttribute[];
};

export type ScimSchema = {
  readonly id: string;
  readonly name: string;
  readonly attributes: readonly ScimAttribute[];
};

export type Rfc7643Vector = {
  readonly resourceTypes: readonly Readonly<Record<string, unknown>>[];
  readonly resourceSchemas: readonly ScimSchema[];
  readonly serviceProviderSchemas: readonly ScimSchema[];
};

export type OcsfClass = {
  readonly uid: number;
  readonly name: string;
  readonly category_uid: number;
  readonly attributes: readonly Readonly<
    Record<
      string,
      {
        readonly requirement?: string;
        readonly enum?: Readonly<Record<string, unknown>>;
      }
    >
  >[];
};

type Fixtures = {
  readonly 'rfc9421-ed25519.json': Rfc9421Vector;
  readonly 'rfc8037-ed25519.json': Rfc8037Vector;
  readonly 'rfc7520-jws.json': Rfc7520Vector;
  readonly 'rfc7643-schemas.json': Rfc7643Vector;
  readonly 'ocsf-1.3.0-authorize_session.json': OcsfClass;
  readonly 'ocsf-1.3.0-account_change.json': OcsfClass;
  readonly 'cloudevents-1.0.2.schema.json': Readonly<Record<string, unknown>>;
  readonly 'a2a-1.0.0.schema.json': Readonly<Record<string, unknown>>;
  readonly 'arazzo-1.1.schema.json': Readonly<Record<string, unknown>>;
};

/** A vendored upstream artefact from `tests/fixtures/standards`. */
export function standardsFixture<Name extends keyof Fixtures>(
  name: Name,
): Fixtures[Name] {
  const text = readFileSync(
    new URL(`../fixtures/standards/${name}`, import.meta.url),
    'utf8',
  );
  // SAFETY: pnpm standards:fixtures writes each file in the shape listed in Fixtures.
  return JSON.parse(text) as Fixtures[Name];
}
