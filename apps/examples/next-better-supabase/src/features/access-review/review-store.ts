import "server-only";
import { memoryAccessReviewStore } from "permdock/approvals";

/** Process-local reviews. The HTTP handler and the apply action share it. */
export const reviewStore = memoryAccessReviewStore();
