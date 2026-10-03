-- The `features` claim: the user's organizations come from
-- permdock.member_organization_ids_for, so an expired membership loses its
-- features in the same token that loses the membership.
create function public.feature_claims(p_user_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_object_agg(f.organization_id::text, f.features)
  from (
    select organization_id, jsonb_agg(feature order by feature) as features
    from public.organization_features
    where organization_id in (select permdock.member_organization_ids_for(p_user_id))
    group by organization_id
  ) f
$$;

revoke execute on function public.feature_claims(uuid) from public, anon, authenticated;
