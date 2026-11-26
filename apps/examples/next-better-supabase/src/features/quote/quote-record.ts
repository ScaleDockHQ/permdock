export type QuoteRecord = {
  readonly id: string;
  readonly organization_id: string;
  readonly customer_id: string;
  readonly title: string;
  readonly amount_minor: number;
  readonly currency: string;
  readonly status: "draft" | "sent" | "approved";
  readonly team_id: string | null;
};

const statuses = new Set<string>(["draft", "sent", "approved"]);

export function isQuoteStatus(value: string): value is QuoteRecord["status"] {
  return statuses.has(value);
}
