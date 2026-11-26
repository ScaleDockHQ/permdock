export async function register(): Promise<void> {
  // Loaded on startup so the first request does not pay for the clients.
  const [{ warm: warmClient }, { warm }, { authorization, bsb }, { policy }] =
    await Promise.all([
      import("better-supabase/next/instrumentation"),
      import("permdock/next"),
      import("./lib/supabase/server.ts"),
      import("./policy.ts"),
    ]);
  const { env } = await import("./env.ts");
  if (env.without === "warm") {
    return;
  }
  await warmClient(bsb);
  await warm(policy);
  await authorization.warm();
}
