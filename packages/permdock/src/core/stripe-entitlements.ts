import type { EntitlementSource } from './interfaces.ts';

/** The part of the Stripe Node SDK this source calls: `stripe.entitlements.activeEntitlements.list`. */
export type StripeEntitlementsClient = {
  readonly entitlements: {
    readonly activeEntitlements: {
      list(params: {
        readonly customer: string;
        readonly limit?: number;
        readonly starting_after?: string;
      }): PromiseLike<{
        readonly data: readonly {
          readonly id: string;
          readonly lookup_key: string;
        }[];
        readonly has_more: boolean;
      }>;
    };
  };
};

const PAGE = 100;
const MAX_PAGES = 10;

/**
 * Plan names from Stripe Entitlements: the `lookup_key` of every active
 * entitlement of the tenant's Stripe customer. `customer` maps the active
 * tenant to its customer id; no tenant or no customer means no entitlements.
 * Pass it as `entitlements`, and grant with `plan('<lookup_key>')`.
 */
export function fromStripeEntitlements(options: {
  readonly stripe: StripeEntitlementsClient;
  readonly customer: (
    tenant: string,
    principal: { readonly id: string },
  ) => string | undefined | PromiseLike<string | undefined>;
}): EntitlementSource {
  return {
    async entitlementsFor(principal, query) {
      if (query.tenant === undefined) {
        return [];
      }
      const customer = await options.customer(query.tenant, principal);
      if (customer === undefined || customer === '') {
        return [];
      }
      const keys = new Set<string>();
      let after: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result =
          // oxlint-disable-next-line no-await-in-loop -- each page needs the previous page's last id
          await options.stripe.entitlements.activeEntitlements.list(
            after === undefined
              ? { customer, limit: PAGE }
              : { customer, limit: PAGE, starting_after: after },
          );
        for (const item of result.data) {
          if (typeof item.lookup_key === 'string' && item.lookup_key !== '') {
            keys.add(item.lookup_key);
          }
        }
        const last = result.data.at(-1);
        if (!result.has_more || last === undefined) {
          break;
        }
        after = last.id;
      }
      return [...keys].toSorted();
    },
  };
}
