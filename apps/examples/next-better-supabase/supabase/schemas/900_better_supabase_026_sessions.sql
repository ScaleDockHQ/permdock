-- better-supabase module: sessions
-- @bsb-block sessions@1 managed
-- @bsb-hash sha256:84970d54c6abe809822a43de8adbcb3b5899de50689bed3f8e3ef427be84da46
-- session_active() for restrictive policies: false once the caller's session was signed out or expired, or the user was banned or deleted, so revoked access tokens stop working before they expire. options.policies writes the policy on every table.
-- Managed by `better-supabase add`; re-running it rewrites this file unless it was edited by hand.
-- Change it through `blocks` in better-supabase.config.ts and the module's SQL hooks.

-- An access token stays valid until it expires, even after its session is
-- signed out or its user is deleted. This checks the session behind it.
-- Tokens without a session_id claim (signed by the app) and support tokens
-- (with an act claim, whose session the support module ends) pass.
-- authenticated can't read auth.sessions, so the check runs as the owner.
create or replace function better_supabase.session_active()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  claims jsonb := auth.jwt();
  session text := claims ->> 'session_id';
begin
  if claims -> 'act' is not null or session is null then
    return true;
  end if;
  if session !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return exists (
    select 1
    from auth.sessions s
    join auth.users u on u.id = s.user_id
    where s.id = session::uuid
      and s.user_id = (claims ->> 'sub')::uuid
      and (s.not_after is null or s.not_after > now())
      and (u.banned_until is null or u.banned_until <= now())
      and u.deleted_at is null
  );
end;
$$;

revoke execute on function better_supabase.session_active() from public, anon;
grant execute on function better_supabase.session_active() to authenticated;

-- Why session_active() is false: user_banned while the caller's user is banned,
-- else session_not_found. The bootstrap wrappers return it as end_reason.
create or replace function better_supabase.session_end_reason()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from auth.users u
    where u.id = auth.uid() and u.banned_until is not null and u.banned_until > now()
  ) then
    return 'user_banned';
  end if;
  return 'session_not_found';
end;
$$;

revoke execute on function better_supabase.session_end_reason() from public, anon;
grant execute on function better_supabase.session_end_reason() to authenticated;

-- The last sign-in of many users in one query, for admin lists. auth.users
-- isn't readable through the Data API, so only the service role calls this.
create or replace function better_supabase.last_sign_ins(p_users uuid[])
returns table (user_id uuid, last_sign_in_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.last_sign_in_at
  from auth.users u
  where u.id = any(p_users)
$$;

revoke execute on function better_supabase.last_sign_ins(uuid[]) from public, anon, authenticated;
grant execute on function better_supabase.last_sign_ins(uuid[]) to service_role;

-- Deletes every session and refresh token of a user and returns how many
-- sessions went. Only the service role calls this, over SQL or the Data API.
create or replace function better_supabase.end_sessions(p_user uuid)
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  ended int;
begin
  with gone as (
    delete from auth.sessions s where s.user_id = end_sessions.p_user returning s.id
  )
  select count(*)::int into ended from gone;
  delete from auth.refresh_tokens t where t.user_id = end_sessions.p_user::text;
  return ended;
end;
$$;

revoke execute on function better_supabase.end_sessions(uuid) from public, anon, authenticated;
grant execute on function better_supabase.end_sessions(uuid) to service_role;

-- The caller's own unexpired sessions, most recently active first, with the
-- one behind the current token marked.
create or replace function better_supabase.list_my_sessions()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id,
    'createdAt', s.created_at,
    'lastActiveAt', coalesce(s.updated_at, s.created_at),
    'userAgent', s.user_agent,
    'ip', host(s.ip),
    'aal', s.aal,
    'current', s.id::text = auth.jwt() ->> 'session_id'
  ) order by coalesce(s.updated_at, s.created_at) desc), '[]'::jsonb)
  from auth.sessions s
  where s.user_id = (select auth.uid())
    and (s.not_after is null or s.not_after > now())
$$;

revoke execute on function better_supabase.list_my_sessions() from public, anon;
grant execute on function better_supabase.list_my_sessions() to authenticated;

-- Ends one of the caller's sessions: its refresh tokens go with it, and
-- session_active() turns false for its access tokens.
create or replace function better_supabase.end_my_session(session uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not (permdock.permdock_actor_may_write()) then
    raise exception 'This session is read-only' using errcode = '42501', hint = 'ACTOR_READ_ONLY';
  end if;
  delete from auth.sessions s
  where s.id = end_my_session.session
    and s.user_id = (select auth.uid());
  return found;
end;
$$;

revoke execute on function better_supabase.end_my_session(uuid) from public, anon;
grant execute on function better_supabase.end_my_session(uuid) to authenticated;


-- The caller's security page in one call: the sessions from
-- list_my_sessions(), the count and the current session's id.
create or replace function better_supabase.sessions_overview()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'count', jsonb_array_length(s.payload),
    'currentId', (select x ->> 'id' from jsonb_array_elements(s.payload) x where (x ->> 'current')::boolean limit 1),
    'sessions', s.payload)
  from (select better_supabase.list_my_sessions() as payload) s
$$;

revoke execute on function better_supabase.sessions_overview() from public, anon;
grant execute on function better_supabase.sessions_overview() to authenticated;

-- Restrictive, so it applies on top of the table's other policies. Wrapped in
-- a select, it runs one indexed lookup per table in a statement:
-- create policy session_required on public.invoices as restrictive
--   for all to authenticated
--   using ((select better_supabase.session_active()))
--   with check ((select better_supabase.session_active()));

-- The caller's own authorization version, null without a signed-in user.
-- Clients compare it with the token's authz_ver to catch up on a broadcast
-- they missed.
-- PermDock keeps the versions in permdock.authz_version_for.
create or replace function better_supabase.caller_authz_version()
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return null;
  end if;
  return permdock.authz_version_for(auth.uid());
end;
$$;

revoke execute on function better_supabase.caller_authz_version() from public, anon;
grant execute on function better_supabase.caller_authz_version() to authenticated;

-- blocks['sessions'].options.bootstrap: bsb.bootstrap({ rpc }) calls these.
-- Each checks the session and returns the caller's authorization version
-- (the live one when the database keeps it, and the token's) with the app
-- function's data, so a cache miss is one query.
create or replace function better_supabase.bootstrap_app(args jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not (select better_supabase.session_active()) then
    return jsonb_build_object(
      'session_active', false,
      'end_reason', better_supabase.session_end_reason(),
      'authz_version', auth.jwt() -> 'authz_ver',
      'token_authz_version', auth.jwt() -> 'authz_ver',
      'tenant', args ->> 'tenant',
      'data', null
    );
  end if;
  return jsonb_build_object(
    'session_active', true,
    'authz_version', to_jsonb(better_supabase.caller_authz_version()),
    'token_authz_version', auth.jwt() -> 'authz_ver',
    'tenant', args ->> 'tenant',
    'data', to_jsonb(public.sample_authz_version(args)),
    'subject', case when nullif(args ->> 'tenant', '') is null then to_jsonb(permdock.permdock_subject()) else to_jsonb(permdock.permdock_subject(((args ->> 'tenant'))::text)) end,
    'subject_tenant', nullif(args ->> 'tenant', '')
  );
end;
$$;

revoke execute on function better_supabase.bootstrap_app(jsonb) from public, anon;
grant execute on function better_supabase.bootstrap_app(jsonb) to authenticated;
