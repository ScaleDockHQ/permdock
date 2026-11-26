import { approvalsHandler } from "permdock/approvals";

import { subjectFromBearer } from "../../../../permdock/bearer.ts";
import { approvalStore } from "../../../../permdock/request.ts";

const handle = approvalsHandler(approvalStore, {
  subject: async (request) => {
    const subject = await subjectFromBearer(request);
    return subject;
  },
  requireDistinctApprover: true,
});

export async function GET(request: Request): Promise<Response> {
  const response = await handle(request);
  return response;
}

export async function POST(request: Request): Promise<Response> {
  const response = await handle(request);
  return response;
}
