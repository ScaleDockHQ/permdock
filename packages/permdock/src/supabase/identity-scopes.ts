/** OpenID Connect identity scopes, which delegate no permission. */
export const IDENTITY_SCOPES: ReadonlySet<string> = new Set([
  "openid",
  "profile",
  "email",
  "address",
  "phone",
  "offline_access",
]);
