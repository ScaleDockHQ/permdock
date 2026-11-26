import { accessReviewsHandler } from "permdock/approvals";

import { reviewStore } from "../../../../features/access-review/review-store.ts";
import { subjectFromBearer } from "../../../../permdock/bearer.ts";

const handle = accessReviewsHandler(reviewStore, {
  subject: async (request) => {
    const subject = await subjectFromBearer(request);
    return subject;
  },
});

export async function GET(request: Request): Promise<Response> {
  const response = await handle(request);
  return response;
}

export async function POST(request: Request): Promise<Response> {
  const response = await handle(request);
  return response;
}
