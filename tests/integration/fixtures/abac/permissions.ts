import { definePermissions, resource } from "permdock";
import { z } from "zod";

export const Report = z.object({
  id: z.string(),
  region: z.string(),
  clearance: z.number().int(),
});

export const Ticket = z.object({ id: z.string(), region: z.string() });

export const Note = z.object({ id: z.string(), title: z.string() });

export const Memo = z.object({
  id: z.string(),
  archived: z.boolean().nullable(),
});

export const permissions = definePermissions({
  report: resource(Report, { actions: ["read"] }),
  ticket: resource(Ticket, { actions: ["read", "update"] }),
  record: resource(Ticket, { actions: ["read", "delete"] }),
  note: resource(Note, { actions: ["read"] }),
  memo: resource(Memo, { actions: ["read"] }),
});
