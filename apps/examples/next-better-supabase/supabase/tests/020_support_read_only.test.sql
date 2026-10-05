-- A better-supabase support session acting as Olivia (owner of Acme) reads her
-- quotes and writes only when the session was started with read_only false.
begin;
select extensions.plan(6);

create function pg_temp.act(act jsonb) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    (current_setting('request.jwt.claims')::jsonb - 'act' || jsonb_build_object('act', act))::text,
    true
  );
$$;

create function pg_temp.rename(title text) returns int language sql as $$
  with changed as (
    update public.quotes set title = rename.title
    where id = '00000000-0000-4000-8000-0000000000f1'
    returning 1
  )
  select count(*)::int from changed;
$$;

select tests.authenticate_as('00000000-0000-4000-8000-0000000000a1');
select extensions.is(pg_temp.rename('Own session'), 1, 'the owner''s own session updates her quote');

select pg_temp.act('{"kind": "support", "sub": "00000000-0000-4000-8000-0000000000ff", "session_id": "support-1"}');
select extensions.is(
  (select count(*)::int from public.quotes),
  2,
  'a support session reads what the owner reads'
);
select extensions.is(pg_temp.rename('No read_only claim'), 0, 'a support session without read_only cannot update');

select pg_temp.act('{"kind": "support", "sub": "00000000-0000-4000-8000-0000000000ff", "session_id": "support-1", "read_only": true}');
select extensions.is(pg_temp.rename('Read-only session'), 0, 'a read_only support session cannot update');

select pg_temp.act('{"sub": "00000000-0000-4000-8000-0000000000ff", "session_id": "impersonation-1"}');
select extensions.is(pg_temp.rename('Impersonation'), 0, 'an impersonation session without read_only cannot update');

select pg_temp.act('{"kind": "support", "sub": "00000000-0000-4000-8000-0000000000ff", "session_id": "support-1", "read_only": false}');
select extensions.is(pg_temp.rename('Writable session'), 1, 'a support session started with read_only false updates');

select tests.clear_authentication();
select * from extensions.finish();
rollback;
