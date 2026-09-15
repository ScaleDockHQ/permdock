export async function POST(request: Request) {
  const webhook = process.env.WAITLIST_WEBHOOK_URL;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }
  if (
    body === null ||
    typeof body !== 'object' ||
    !('email' in body) ||
    typeof body.email !== 'string' ||
    body.email.length === 0
  ) {
    return Response.json({ ok: false }, { status: 400 });
  }
  if (webhook === undefined || webhook.length === 0) {
    return new Response(null, { status: 503 });
  }
  const forwarded = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: body.email }),
  });
  if (!forwarded.ok) {
    return new Response(null, { status: 503 });
  }
  return Response.json({ ok: true });
}
