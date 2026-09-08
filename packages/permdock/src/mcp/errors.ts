export class InsufficientScopeError extends Error {
  public override readonly name = 'InsufficientScopeError' as const;
  public readonly code = 'insufficient_scope' as const;
  public readonly missing: string;
  public readonly scope: string;
  public readonly wwwAuthenticate: string;

  public constructor(missing: string, held: readonly string[]) {
    const scopes = [...new Set([...held, missing])].toSorted();
    const scope = scopes.join(' ');
    super(`insufficient_scope: ${missing}`);
    this.missing = missing;
    this.scope = scope;
    this.wwwAuthenticate = `Bearer error="insufficient_scope", scope="${scope}"`;
  }
}
