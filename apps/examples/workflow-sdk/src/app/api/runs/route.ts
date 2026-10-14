import {
  PROBLEM_BASE,
  problemResponse,
  validationProblem,
} from "permdock/server";
import { startAutomation } from "permdock/workflow-sdk";
import { start } from "workflow/api";
import { z } from "zod";

import { runs } from "../../../runs.ts";
import { sendOverdue } from "../../../workflows/send-overdue.ts";

const StartBody = z.object({ invoiceId: z.string().min(1).max(64) });

/** Starts the `send-overdue` automation from server code, as a scheduler would. */
export async function POST(request: Request): Promise<Response> {
  const body = StartBody.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return validationProblem("Expected { invoiceId: string }.");
  }
  const { workflow } = await runs();
  const started = await startAutomation(
    workflow,
    start,
    sendOverdue,
    "send-overdue",
    [body.data.invoiceId],
  );
  if (started.outcome !== "started") {
    return problemResponse({
      type: `${PROBLEM_BASE}/denied`,
      title: "Automation start denied",
      status: 403,
      detail: started.denials.map((denial) => denial.reason).join(", "),
    });
  }
  return Response.json(
    { run: started.run.id, workflowRun: started.workflowRun.runId },
    { status: 202 },
  );
}
