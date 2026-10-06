import type { Snapshot, TokenSigner } from "./interfaces.ts";

import { compact } from "./compact.ts";

export async function signSnapshot(
  snapshot: Snapshot,
  signer: TokenSigner,
  audience?: string | readonly string[],
): Promise<string> {
  const payload: Record<string, unknown> = {
    snapshot,
  };
  if (snapshot.subject.principal !== null) {
    payload["sub"] = snapshot.subject.principal.id;
  }
  const token = await signer.sign(
    payload,
    compact<Parameters<TokenSigner["sign"]>[1]>({
      typ: "permdock-snapshot+jwt" as const,
      audience,
      expiresAt: snapshot.expiresAt,
    }),
  );
  return token;
}
