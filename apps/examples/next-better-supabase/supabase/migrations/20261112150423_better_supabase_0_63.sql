SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION better_supabase.can_assign (
  tenant uuid,
  role   text
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select coalesce(auth.jwt() ->> 'role', '') = 'service_role' or ((better_supabase.interactive_session() or not better_supabase.interactive_only_role(can_assign.role)) and coalesce((false), false))
$function$;

CREATE OR REPLACE FUNCTION better_supabase.cap_allows (
  permission text
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select case
    when jwt is null then true
    when better_supabase.interactive_only(cap_allows.permission)
      and not better_supabase.interactive_session() then false
    when jsonb_typeof(cap) = 'array'
      and not exists (
        select 1 from jsonb_array_elements_text(cap) c(key)
        where better_supabase.permission_matches(c.key, cap_allows.permission)
      ) then false
    when jsonb_typeof(jwt -> 'api_key') = 'object' then exists (
      select 1
      from jsonb_array_elements_text(case jsonb_typeof(jwt -> 'api_key' -> 'scopes')
          when 'array' then jwt -> 'api_key' -> 'scopes'
          else '[]'::jsonb
        end) s(scope)
      cross join lateral unnest(better_supabase.scope_permissions(s.scope)) k(key)
      where better_supabase.permission_matches(k.key, cap_allows.permission)
    )
    when coalesce(jwt ->> 'client_id', '') = ''
      and (jwt -> 'act' is null
        or (jsonb_typeof(jwt -> 'act') = 'object'
          and jwt -> 'act' ->> 'kind' in ('support', 'impersonation'))) then true
    else exists (
      select 1
      from unnest(case jsonb_typeof(jwt -> 'scope')
          when 'string' then regexp_split_to_array(btrim(jwt ->> 'scope'), '\s+')
          when 'array' then array(select jsonb_array_elements_text(jwt -> 'scope'))
          else '{}'::text[]
        end) s(scope)
      cross join lateral unnest(better_supabase.scope_permissions(s.scope)) k(key)
      where s.scope <> ''
        and better_supabase.permission_matches(k.key, cap_allows.permission)
    )
  end
  from (select auth.jwt() as jwt) as token
  cross join lateral (
    select coalesce(jwt -> 'bsb_permission_cap', jwt -> 'bs_permission_cap') as cap
  ) as capped
$function$;

CREATE OR REPLACE FUNCTION better_supabase.interactive_only (
  permission text
)
  RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  select false
$function$;

CREATE OR REPLACE FUNCTION better_supabase.interactive_only_role (
  role text
)
  RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  select false
$function$;

CREATE OR REPLACE FUNCTION better_supabase.interactive_session()
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select auth.jwt() is null
    or (auth.jwt() -> 'api_key' is null
      and coalesce(auth.jwt() ->> 'client_id', '') = ''
      and auth.jwt() -> 'act' is null)
$function$;

REVOKE ALL ON FUNCTION "better_supabase"."interactive_only"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."interactive_only"(text) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."interactive_only_role"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."interactive_only_role"(text) TO "anon", "authenticated", "service_role";

REVOKE ALL ON FUNCTION "better_supabase"."interactive_session"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "better_supabase"."interactive_session"() TO "anon", "authenticated", "service_role";
