-- Quote writes follow status: a draft can be deleted, a sent quote cannot.
begin;
select extensions.plan(2);

select tests.authenticate_as('00000000-0000-4000-8000-0000000000a1');

update public.quotes
set status = 'sent'
where id = '00000000-0000-4000-8000-0000000000f1';

with deleted as (
  delete from public.quotes
  where id = '00000000-0000-4000-8000-0000000000f1'
  returning 1
)
select extensions.is(
  (select count(*)::int from deleted),
  0,
  'an owner cannot delete a sent quote'
);

with deleted as (
  delete from public.quotes
  where id = '00000000-0000-4000-8000-0000000000f2'
  returning 1
)
select extensions.is(
  (select count(*)::int from deleted),
  1,
  'an owner can delete a draft quote'
);

select * from extensions.finish();
rollback;
