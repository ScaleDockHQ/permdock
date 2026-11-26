"use client";

import { Button } from "@/components/ui/button";

import { issueApiKey, issueServiceAccount } from "../credential-actions.ts";

export function DeveloperPanel(props: { readonly organizationId: string }) {
  const input = { organizationId: props.organizationId };
  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          void issueApiKey(input);
        }}
      >
        Issue API key
      </Button>
      <Button
        size="sm"
        onClick={() => {
          void issueServiceAccount(input);
        }}
      >
        Issue service account
      </Button>
    </>
  );
}
