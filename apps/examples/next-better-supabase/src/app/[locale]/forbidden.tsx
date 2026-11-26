import { Alert, AlertDescription, AlertTitle } from "@/components/reui/alert";

/** `forbidden()` from a route that needs a permission the caller lacks. */
export default function Forbidden() {
  return (
    <main className="p-4" data-testid="forbidden">
      <Alert variant="warning">
        <AlertTitle>You do not have access to this page</AlertTitle>
        <AlertDescription>
          Ask an organization owner for the role that grants it.
        </AlertDescription>
      </Alert>
    </main>
  );
}
