"use client";

import { Check } from "lucide-react";
import { useActionState } from "react";

import { SubmitButton } from "@/components/submit-button.tsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";

import { approveQuote } from "../../app/actions.ts";

export function ApproveQuoteForm(props: {
  readonly organization: string;
  readonly id: string;
}) {
  const [result, action] = useActionState<Awaited<
    ReturnType<typeof approveQuote>
  > | null>(async () => {
    const next = await approveQuote({
      organization: props.organization,
      id: props.id,
    });
    return next;
  }, null);
  return (
    <form action={action} className="flex flex-col items-end gap-2">
      <SubmitButton
        data-action="approve"
        icon={<Check data-icon="inline-start" />}
      >
        Approve quote
      </SubmitButton>
      {result?.ok === false ? (
        <Alert variant="destructive" data-testid="approve-problem">
          <AlertTitle>{result.problem.title}</AlertTitle>
          <AlertDescription>{result.problem.detail}</AlertDescription>
        </Alert>
      ) : null}
    </form>
  );
}
