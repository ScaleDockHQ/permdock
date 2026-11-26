import { Alert, AlertDescription, AlertTitle } from "@/components/reui/alert";

/** `unauthorized()` from a route that needs a signed-in caller. */
export default function Unauthorized() {
  return (
    <main className="p-4" data-testid="unauthorized">
      <Alert>
        <AlertTitle>Sign in to continue</AlertTitle>
        <AlertDescription>
          This page needs a signed-in account.
        </AlertDescription>
      </Alert>
    </main>
  );
}
