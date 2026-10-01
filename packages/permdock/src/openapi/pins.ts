export const DRAFT_PINS = {
  oas: '3.3-dev@2026-09-01',
  securityProfiles: 'oai-discussion-5304@2026-09-01',
  overlay: '1.2-dev@edd4adea',
} as const;

export const PROFILE_NAMES = {
  fapi2: 'fapi-20-security-profile',
} as const;

/** PermDock's published `supportedParametersSchema` per profile, stable across pins. */
export const PROFILE_PARAMETERS = {
  fapi2: 'https://permdock.dev/schemas/security-profiles/fapi2.json',
} as const;

export const GNAP_RESERVED =
  "scheme.type 'gnap' is reserved and emits nothing. See https://permdock.dev/docs/standards/watch-list#gnap";
