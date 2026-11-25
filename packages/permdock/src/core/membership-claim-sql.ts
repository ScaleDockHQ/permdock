/**
 * The SQL that turns a compact `memberships` claim (`core/membership-claim.ts`:
 * `[scope index, short id, via index, ...role indexes]` rows in `e` plus the
 * `o` objects) into the entries of the long form. `claim` is a jsonb
 * expression, which may be correlated with the enclosing query.
 */
export function compactMembershipsSql(claim: string): string {
  return `(
          select coalesce(jsonb_agg(d.m), '[]'::jsonb)
          from (
            select jsonb_build_object(
              'scope', c.cl -> 's' ->> (x.e ->> 0)::int,
              'id', case when left(x.e ->> 1, 1) = '=' then substr(x.e ->> 1, 2)
                else (encode(decode(translate(x.e ->> 1, '-_', '+/') || '==', 'base64'), 'hex'))::uuid::text end,
              'roles', (
                select coalesce(jsonb_agg(c.cl -> 'r' -> ((r.v #>> '{}')::int)), '[]'::jsonb)
                from jsonb_array_elements(x.e) with ordinality r(v, n)
                where r.n > 3
              )
            ) || case when (x.e ->> 2)::int >= 0
              then jsonb_build_object('via', c.cl -> 'v' ->> (x.e ->> 2)::int)
              else '{}'::jsonb end as m
            from (select ${claim} as cl) c
            cross join lateral jsonb_array_elements(coalesce(c.cl -> 'e', '[]'::jsonb)) x(e)
            union all
            select o.m
            from (select ${claim} as cl) c
            cross join lateral jsonb_array_elements(coalesce(c.cl -> 'o', '[]'::jsonb)) o(m)
          ) d
        )`;
}
