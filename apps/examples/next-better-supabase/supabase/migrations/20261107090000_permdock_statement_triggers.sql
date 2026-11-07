-- The authorization version bumps once per statement: row triggers become statement triggers with transition tables.
drop trigger if exists permdock_authz_version on permdock.user_roles;
drop trigger if exists permdock_authz_version on public.contacts;
drop trigger if exists permdock_authz_version on public.organization_memberships;
drop trigger if exists permdock_authz_version_broadcast on permdock.permdock_authz_version;

CREATE OR REPLACE FUNCTION permdock.permdock_broadcast_authz_version()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  r record;
begin
  if to_regprocedure('realtime.send(jsonb, text, text, boolean)') is not null then
    for r in select * from permdock_new loop
      perform realtime.send(jsonb_build_object('user_id', r.user_id, 'version', r.version), 'changed', 'better_supabase:authz', true);
      perform realtime.send(jsonb_build_object('user_id', r.user_id, 'version', r.version), 'changed', 'authz:' || r.user_id::text, true);
    end loop;
  end if;
  return null;
end;
$function$;
CREATE OR REPLACE FUNCTION permdock.permdock_bump_authz_version()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  column_name text := tg_argv[0];
  users uuid[] := '{}';
  holder uuid[];
begin
  if tg_op <> 'INSERT' then
    execute format('select coalesce(array_agg(distinct %1$I::text::uuid), ''{}'') from permdock_old where %1$I is not null', column_name)
      into holder;
    users := users || holder;
  end if;
  if tg_op <> 'DELETE' then
    execute format('select coalesce(array_agg(distinct %1$I::text::uuid), ''{}'') from permdock_new where %1$I is not null', column_name)
      into holder;
    users := users || holder;
  end if;
  perform "permdock".permdock_bump_authz_version_for(users);
  return null;
end;
$function$;

create trigger permdock_authz_version_broadcast_insert AFTER INSERT ON permdock.permdock_authz_version REFERENCING NEW TABLE AS permdock_new FOR EACH STATEMENT EXECUTE FUNCTION permdock.permdock_broadcast_authz_version();
create trigger permdock_authz_version_broadcast_update AFTER UPDATE ON permdock.permdock_authz_version REFERENCING NEW TABLE AS permdock_new FOR EACH STATEMENT EXECUTE FUNCTION permdock.permdock_broadcast_authz_version();
create trigger permdock_authz_version_delete AFTER DELETE ON permdock.user_roles REFERENCING OLD TABLE AS permdock_old FOR EACH STATEMENT EXECUTE FUNCTION permdock.permdock_bump_authz_version('user_id');
create trigger permdock_authz_version_insert AFTER INSERT ON permdock.user_roles REFERENCING NEW TABLE AS permdock_new FOR EACH STATEMENT EXECUTE FUNCTION permdock.permdock_bump_authz_version('user_id');
create trigger permdock_authz_version_update AFTER UPDATE ON permdock.user_roles REFERENCING OLD TABLE AS permdock_old NEW TABLE AS permdock_new FOR EACH STATEMENT EXECUTE FUNCTION permdock.permdock_bump_authz_version('user_id');
create trigger permdock_authz_version_delete AFTER DELETE ON public.contacts REFERENCING OLD TABLE AS permdock_old FOR EACH STATEMENT EXECUTE FUNCTION permdock.permdock_bump_authz_version('user_id');
create trigger permdock_authz_version_insert AFTER INSERT ON public.contacts REFERENCING NEW TABLE AS permdock_new FOR EACH STATEMENT EXECUTE FUNCTION permdock.permdock_bump_authz_version('user_id');
create trigger permdock_authz_version_update AFTER UPDATE ON public.contacts REFERENCING OLD TABLE AS permdock_old NEW TABLE AS permdock_new FOR EACH STATEMENT EXECUTE FUNCTION permdock.permdock_bump_authz_version('user_id');
create trigger permdock_authz_version_delete AFTER DELETE ON public.organization_memberships REFERENCING OLD TABLE AS permdock_old FOR EACH STATEMENT EXECUTE FUNCTION permdock.permdock_bump_authz_version('user_id');
create trigger permdock_authz_version_insert AFTER INSERT ON public.organization_memberships REFERENCING NEW TABLE AS permdock_new FOR EACH STATEMENT EXECUTE FUNCTION permdock.permdock_bump_authz_version('user_id');
create trigger permdock_authz_version_update AFTER UPDATE ON public.organization_memberships REFERENCING OLD TABLE AS permdock_old NEW TABLE AS permdock_new FOR EACH STATEMENT EXECUTE FUNCTION permdock.permdock_bump_authz_version('user_id');
