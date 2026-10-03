-- A claim the token hook adds for the app (`supabase.hook.claims`); PermDock never reads it.
create function public.datetime_preference_claims(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'timezone', p.timezone,
    'week_start', p.week_start,
    'date_format', p.date_format,
    'time_format', p.time_format
  )
  from public.datetime_preferences p
  where p.user_id = p_user_id
$$;

revoke execute on function public.datetime_preference_claims(uuid) from public, anon, authenticated;
