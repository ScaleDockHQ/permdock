"use client";

import type { Permission } from "permdock";

import { useApproval, useGate } from "permdock/react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

type ApprovalRequestDialogProps = {
  readonly permission: Permission;
  readonly data?: unknown;
  /** The button that opens the dialog. */
  readonly label?: string;
};

/**
 * For an action that returns approval-required: a button that opens a dialog
 * where the user adds a note and sends the request. It renders nothing when the
 * action needs no approval.
 */
export function ApprovalRequestDialog({
  permission,
  data,
  label = "Request approval",
}: ApprovalRequestDialogProps) {
  const gate = useGate(permission, data);
  const approval = useApproval(gate.decision);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  if (!gate.needsApproval) {
    return null;
  }
  const sent = approval.state === "pending" || approval.state === "approved";
  return (
    <>
      <Button variant="outline" disabled={sent} onClick={() => setOpen(true)}>
        {sent ? "Approval requested" : label}
      </Button>
      <Dialog open={open} onOpenChange={(next) => setOpen(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{gate.reason.title}</DialogTitle>
            <DialogDescription>{gate.reason.detail}</DialogDescription>
          </DialogHeader>
          <Textarea
            value={note}
            placeholder="Why do you need this?"
            onChange={(event) => setNote(event.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                void approval.request(note === "" ? undefined : note);
                setOpen(false);
              }}
            >
              Send request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
