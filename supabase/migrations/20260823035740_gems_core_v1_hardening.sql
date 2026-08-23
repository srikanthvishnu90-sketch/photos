-- Advisor hardening: lock down trigger helper functions.
-- Applied to project hkwkxacvcgorhthwyslx (gems) on 2026-08-22.

-- 1. Pin search_path on touch_updated_at (was role-mutable).
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- 2. These are trigger-only functions; nobody should call them over
--    the REST RPC surface.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.touch_updated_at() from public, anon, authenticated;
