import { runs } from "../../../runs.ts";

/** The pending approval requests, oldest first. */
export async function GET(): Promise<Response> {
  const { approvals } = await runs();
  const page = await approvals.list({ status: "pending" });
  return Response.json(
    page.items.map((request) => ({
      token: request.token,
      permission: request.permission,
      resource: request.resource,
      expiresAt: request.expiresAt,
    })),
  );
}
