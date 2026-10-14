import { ApprovalError, resolveApproval } from "permdock/approvals";
import { PROBLEM_BASE, problemResponse } from "permdock/server";
import { workflowSdkWaiter } from "permdock/workflow-sdk";
import { createHook, sleep } from "workflow";
import { resumeHook } from "workflow/api";

import { subjectOf } from "../../../../policy.ts";
import { runs } from "../../../../runs.ts";

const waiter = workflowSdkWaiter({ createHook, resumeHook, sleep });

/**
 * Approves a pending request as `u_finance`, then wakes the parked run. A real
 * app takes the approver from its verified session, never from the request.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;
  const { approvals } = await runs();
  try {
    await resolveApproval(approvals, token, {
      status: "approved",
      by: subjectOf("u_finance"),
    });
  } catch (error) {
    if (!(error instanceof ApprovalError)) {
      throw error;
    }
    return problemResponse({
      type: `${PROBLEM_BASE}/validation`,
      title: "Approval not resolved",
      status: 409,
      detail: error.message,
    });
  }
  await waiter.wake(token);
  return new Response(null, { status: 204 });
}
