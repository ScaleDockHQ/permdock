"use client";

export { QuoteTools } from "./quote-tools.tsx";

import { useProtectedAction } from "permdock/react";

import { Button } from "@/components/ui/button";

import type { QuoteRecord } from "../quote-record.ts";

import { permissions } from "../../../permissions.ts";
import {
  approveQuote,
  deleteQuote,
  renameQuote,
  sendQuote,
} from "../quote-actions.ts";

function ActionButton(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <Button size="sm" disabled={props.disabled} onClick={props.onClick}>
      {props.label}
    </Button>
  );
}

function RenameButton(props: { readonly quote: QuoteRecord }) {
  const handle = useProtectedAction(
    renameQuote,
    permissions.quotes.update,
    props.quote,
  );
  return (
    <ActionButton
      label="Rename"
      disabled={!handle.gate.allowed}
      onClick={() => {
        void handle.run([
          props.quote.id,
          {
            title: `${props.quote.title} revised`,
            organizationId: props.quote.organization_id,
          },
        ]);
      }}
    />
  );
}

function SendButton(props: { readonly quote: QuoteRecord }) {
  const handle = useProtectedAction(
    sendQuote,
    permissions.quotes.send,
    props.quote,
  );
  return (
    <ActionButton
      label="Send"
      disabled={!handle.gate.allowed}
      onClick={() => {
        void handle.run({
          id: props.quote.id,
          organizationId: props.quote.organization_id,
        });
      }}
    />
  );
}

function ApproveButton(props: { readonly quote: QuoteRecord }) {
  const handle = useProtectedAction(
    approveQuote,
    permissions.quotes.approve,
    props.quote,
  );
  const token = handle.approval?.token;
  return (
    <ActionButton
      label="Approve"
      disabled={!handle.gate.allowed && token === undefined}
      onClick={() => {
        void (token === undefined
          ? handle.run({
              id: props.quote.id,
              organizationId: props.quote.organization_id,
            })
          : handle.retry());
      }}
    />
  );
}

function DeleteButton(props: { readonly quote: QuoteRecord }) {
  const handle = useProtectedAction(
    deleteQuote,
    permissions.quotes.delete,
    props.quote,
  );
  return (
    <ActionButton
      label="Delete"
      disabled={!handle.gate.allowed}
      onClick={() => {
        void handle.run({
          id: props.quote.id,
          organizationId: props.quote.organization_id,
        });
      }}
    />
  );
}

/** Rename, send, approve and delete. Approve retries with the approval token. */
export function QuoteActions(props: { readonly quote: QuoteRecord }) {
  return (
    <div className="flex flex-wrap gap-2">
      <RenameButton quote={props.quote} />
      <SendButton quote={props.quote} />
      <ApproveButton quote={props.quote} />
      <DeleteButton quote={props.quote} />
    </div>
  );
}
