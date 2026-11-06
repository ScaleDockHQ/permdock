-- anon reads only the columns the public slug lookup selects
revoke select on public.organizations from anon;
grant select (id, slug, name) on public.organizations to anon;
