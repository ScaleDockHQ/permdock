-- Per-organization plan features, as the `features` claim (`supabase.hook.claims`).
-- A stand-in for better-supabase's better_supabase.feature_claims: it reads the
-- user's organizations from permdock.member_organization_ids_for, so an expired
-- membership loses its features in the same token that loses the membership.
-- After the helpers migration (it calls the helper) and before the hook (which grants on it).
create table public.organization_features (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  feature text not null,
  primary key (organization_id, feature)
);

alter table public.organization_features enable row level security;

grant select on public.organization_features to supabase_auth_admin;
create policy organization_features_auth_admin_read on public.organization_features
  for select to supabase_auth_admin using (true);

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
