"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

import { createShareLink, revokeShareLink } from "../share-actions.ts";

export function ShareActions(props: {
  readonly organizationId: string;
  readonly quoteId: string;
}) {
  const [linkId, setLinkId] = useState<string | null>(null);
  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          void createShareLink({
            organizationId: props.organizationId,
            quoteId: props.quoteId,
          }).then((created) => {
            setLinkId(created.ok ? created.value.id : null);
          });
        }}
      >
        Share
      </Button>
      <Button
        size="sm"
        disabled={linkId === null}
        onClick={() => {
          if (linkId === null) {
            return;
          }
          void revokeShareLink({
            organizationId: props.organizationId,
            linkId,
          });
        }}
      >
        Revoke
      </Button>
    </>
  );
}
