-- permdock:seeds v1 schema=permdock
insert into "permdock".role_permissions (role, permission, grant_key, scope, effect) values
  ('owner', 'staff.read', 'staff.read', 'organization', 'allow'),
  ('owner', 'staff.list', 'staff.list', 'organization', 'allow'),
  ('owner', 'quotes.read', 'quotes.read', 'organization', 'allow'),
  ('owner', 'quotes.list', 'quotes.list', 'organization', 'allow'),
  ('owner', 'quotes.update', 'quotes.update', 'organization', 'allow'),
  ('member', 'staff.read', 'staff.read', 'organization', 'allow'),
  ('member', 'staff.list', 'staff.list', 'organization', 'allow'),
  ('contact', 'quotes.read', 'quotes.read', 'customer', 'allow'),
  ('contact', 'quotes.list', 'quotes.list', 'customer', 'allow')
on conflict (role, grant_key, scope) do update
  set permission = excluded.permission, effect = excluded.effect;
delete from "permdock".role_permissions
where (role, grant_key, scope) not in (values
  ('owner', 'staff.read', 'organization'),
  ('owner', 'staff.list', 'organization'),
  ('owner', 'quotes.read', 'organization'),
  ('owner', 'quotes.list', 'organization'),
  ('owner', 'quotes.update', 'organization'),
  ('member', 'staff.read', 'organization'),
  ('member', 'staff.list', 'organization'),
  ('contact', 'quotes.read', 'customer'),
  ('contact', 'quotes.list', 'customer')
);
