/** The `Bearer` challenge of a `WWW-Authenticate` field (RFC 6750 section 3), parameter names in lower case. */
export type BearerChallenge = {
  readonly scheme: "bearer";
  readonly params: Readonly<Record<string, string>>;
};

const SCHEME = /^[\s,]*([!#$%&'*+.^_`|~0-9A-Za-z-]+)(?=[\s,]|$)/u;
const PARAM =
  /^\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([!#$%&'*+.^_`|~0-9A-Za-z-]+))\s*(?:,|$)/u;
const TOKEN68 = /^\s*[A-Za-z0-9._~+/-]+=*\s*(?:,|$)/u;

/**
 * The first `Bearer` challenge in `header` (RFC 9110 section 11.6.1 syntax),
 * or `null`. Other schemes in the same field are skipped.
 */
export function bearerChallenge(header: string | null): BearerChallenge | null {
  if (header === null) {
    return null;
  }
  let rest = header;
  while (rest.trim() !== "") {
    const scheme = SCHEME.exec(rest);
    if (scheme === null) {
      return null;
    }
    rest = rest.slice(scheme[0].length);
    const entries: (readonly [string, string])[] = [];
    let param = PARAM.exec(rest);
    if (param === null) {
      const token68 = TOKEN68.exec(rest);
      rest = token68 === null ? rest : rest.slice(token68[0].length);
    }
    while (param !== null) {
      const quoted = param[2];
      entries.push([
        (param[1] ?? "").toLowerCase(),
        quoted === undefined
          ? (param[3] ?? "")
          : quoted.replaceAll(/\\(.)/gu, "$1"),
      ]);
      rest = rest.slice(param[0].length);
      param = PARAM.exec(rest);
    }
    if ((scheme[1] ?? "").toLowerCase() === "bearer") {
      return Object.freeze({
        scheme: "bearer",
        params: Object.freeze(Object.fromEntries(entries)),
      });
    }
  }
  return null;
}
