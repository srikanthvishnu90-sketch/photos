-- Dependency-free assertion subset for running the pgTAP-authored acceptance
-- files on a disposable vanilla PostgreSQL install that does not ship pgTAP.
-- Do not load this in Supabase; the real pgTAP extension remains authoritative.

create or replace function public.plan(expected integer)
returns text
language plpgsql
as $$
begin
  if expected < 1 then
    raise exception 'invalid assertion plan';
  end if;
  return '1..' || expected::text;
end
$$;

create or replace function public.ok(
  condition boolean,
  description text
)
returns text
language plpgsql
as $$
begin
  if condition is not true then
    raise exception 'assertion failed: %', description;
  end if;
  return 'ok - ' || description;
end
$$;

create or replace function public.is(
  actual anycompatible,
  expected anycompatible,
  description text
)
returns text
language plpgsql
as $$
begin
  if actual is distinct from expected then
    raise exception 'assertion failed: % (expected %, got %)',
      description, expected, actual;
  end if;
  return 'ok - ' || description;
end
$$;

create or replace function public.has_table(
  schema_name text,
  table_name text,
  description text
)
returns text
language plpgsql
as $$
begin
  if pg_catalog.to_regclass(
    pg_catalog.format('%I.%I', schema_name, table_name)
  ) is null then
    raise exception 'assertion failed: %', description;
  end if;
  return 'ok - ' || description;
end
$$;

create or replace function public.throws_ok(
  statement text,
  expected_state text,
  expected_message text,
  description text
)
returns text
language plpgsql
as $$
begin
  begin
    execute statement;
  exception when others then
    if sqlstate is distinct from expected_state
      or sqlerrm is distinct from expected_message then
      raise exception
        'assertion failed: % (expected [%] %, got [%] %)',
        description, expected_state, expected_message, sqlstate, sqlerrm;
    end if;
    return 'ok - ' || description;
  end;
  raise exception 'assertion failed: % (statement did not throw)', description;
end
$$;

create or replace function public.finish()
returns setof text
language sql
as $$
  select null::text where false
$$;
