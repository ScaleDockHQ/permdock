import type { JWK } from 'jose';

// Test-only ES256 key pair. It signs fixture sessions and nothing else.
export const publicJwk: JWK = {
  kty: 'EC',
  crv: 'P-256',
  x: 'p5Q0wX-3-mOBqOcCTP-RHesn80ydMMNOpr_YNY6uE1I',
  y: 'Tr8Bo2w8QPJ1l0BfNLOEUsSz2VVJGx8AWMOika2yUeA',
  kid: 'e2e',
  alg: 'ES256',
  use: 'sig',
};

export const privateJwk: JWK = {
  ...publicJwk,
  d: '8gTksJVtlkViFAL5tSmPaxnrR3QzONTODL6l8xDZiCk',
};
