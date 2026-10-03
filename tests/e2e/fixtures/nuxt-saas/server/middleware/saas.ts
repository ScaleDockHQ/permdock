import { handleSaasRoute } from "@permdock/e2e-saas-kit";

/** Test, login and delete routes shared with every fixture. */
export default defineEventHandler(async (event) => {
  if (!event.path.startsWith("/api/")) {
    return;
  }
  const response = await handleSaasRoute(toWebRequest(event));
  if (response !== undefined) {
    return sendWebResponse(event, response);
  }
});
