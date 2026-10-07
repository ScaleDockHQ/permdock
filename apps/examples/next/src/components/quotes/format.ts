import type { Quote } from "../../permissions.ts";

import { customers } from "../../lib/store.ts";

export const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export function customerName(quote: Quote): string {
  return (
    customers.find((customer) => customer.id === quote.customer_id)?.name ??
    quote.customer_id
  );
}
